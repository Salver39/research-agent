# Итерация 14 — Phase 2 запуска: упаковка в docker-compose, end-to-end self-host

**Дата:** 2026-05-25
**Продолжение:** `launch-plan.md` (Фаза 2 — Self-host через `docker-compose`).
**Цель:** упаковать стек (FastAPI + Next.js + SQLite + Chroma + WeasyPrint) в `docker-compose up -d --build`, проверить полный сценарий wizard'а от старта до выгрузки документов, описать в README.

**Итог:** добавлены `backend/Dockerfile`, `frontend/Dockerfile`, оба `.dockerignore`, `docker-compose.yml`, `.env.example`, секция self-host в `README.md`. Четыре правки в коде. Поймано четыре нетривиальных дефекта (три из них — особенности Docker/Next.js, не код приложения; один — устаревший pin зависимости). Полный путь wizard'а проходит, документы скачиваются с PDF, persistence через `compose down && up` верифицирован.

---

## Содержание

1. [Принципы и развилки на старте](#1-принципы-и-развилки)
2. [Backend Dockerfile + правки путей](#2-backend-dockerfile)
3. [Frontend Dockerfile + standalone output](#3-frontend-dockerfile)
4. [docker-compose: ложная persistence, env_file vs Dockerfile ENV](#4-compose-falsepersistence)
5. [SSE-буферизация в Next.js standalone (а не «только в dev»)](#5-sse-buffering)
6. [WeasyPrint 62.3 vs pydyf 0.12 — silent PDF failure](#6-weasyprint-pydyf)
7. [End-to-end проверка](#7-e2e)
8. [README self-host](#8-readme)
9. [Эпистемические заметки](#9-epistemic)
10. [Что осталось открытым](#10-open)

---

## 1. Принципы и развилки

В начале явно зафиксировал три решения по архитектуре docker-стека, чтобы не делать вслепую:

- **Python 3.11-slim-bookworm** в образе бэка. Локальный `.venv` на 3.9 не накладывает обязательств — это venv, не требование. Все зависимости (`weasyprint==62.3`, `chromadb==0.5.23`, `fastapi==0.111.0`, `openai>=2.35.1`) совместимы с 3.11.
- **Один bind mount `./data`** вместо разрозненных томов на `uploads/`, `outputs/`, `chroma_db/`, SQLite. Self-host пользователь видит все свои данные в одном месте на хосте и бэкапит одной командой.
- **Чтобы один mount работал, нужны env'ы под пути.** В коде `UPLOAD_DIR` и `OUTPUT_DIR` были захардкожены строками `"uploads"` / `"outputs"`. Две правки на 1 строку каждая в `backend/api/upload.py:16` и `backend/api/download.py` — обернул в `os.getenv` с дефолтом на старое значение. Локально ничего не меняется, в Docker подменяется на `/data/uploads` и `/data/outputs` через env.

Все три решения подтверждены пользователем до начала кодинга. Это сэкономило время потом, когда compose начал перебивать пути (см. §4) — стало понятно, какие именно env'ы должен задавать compose.

---

## 2. Backend Dockerfile

`backend/Dockerfile` — однослойный, без non-root user'а сознательно (упрощает права на bind mount для self-host пользователя).

Ключевые моменты:

- `python:3.11-slim-bookworm` (явно пинан bookworm, чтобы имена apt-пакетов не дрейфовали).
- Системные deps под WeasyPrint: `libpango-1.0-0`, `libpangoft2-1.0-0`, `libcairo2`, `libgdk-pixbuf-2.0-0`, `shared-mime-info` + шрифты `fonts-dejavu` + `fonts-noto` для кириллицы в PDF.
- `ENV` блок задаёт дефолтные пути на `/data/...` — но они потом перебиваются через compose, см. §4.
- `RUN mkdir -p /data` — гарантирует, что SQLite не упадёт на первой записи в несуществующую директорию.

`backend/.dockerignore` исключает `.venv/`, `uploads/`, `outputs/`, `chroma_db/`, `.env` — без этого `.venv` (~500+ МБ) попал бы в образ.

**Верификация:** `docker build -t research-agent-backend ./backend` собрался за 95 секунд, образ 1.1 ГБ. Запуск `docker run --rm -d` с dummy ключами OpenAI → `/health` отвечает `{"status":"ok"}` за 2 секунды. Запас на старт: лог `Application startup complete` появляется сразу, fail-fast на env работает (если убрать переменные, контейнер падает с понятной ошибкой).

**Размер 1.1 ГБ — много, но осознанно.** Основная масса — chromadb тянет `onnxruntime` + `tokenizers` + `huggingface_hub` (~600 МБ). Это плата за «embeddings локально, навсегда $0». Альтернатива — заменить embedder на OpenAI, тогда RAG будет платным, но образ упадёт до ~300 МБ. Не делаю — экономика прогона требует $0 embeddings (см. `iteration-13.md` §2).

---

## 3. Frontend Dockerfile

Multi-stage на `node:20-alpine`, output standalone. Включение standalone — добавление одной строки `output: "standalone"` в `frontend/next.config.mjs:3`.

Структура:

```dockerfile
FROM node:20-alpine AS base
FROM base AS deps          # npm ci по lockfile
FROM base AS builder       # COPY + npm run build
FROM base AS runner        # копируется только .next/standalone + .next/static
```

`public/` не копируется — его в репо просто нет (Next.js не требует).

User: non-root (`nextjs:nodejs`) — для фронта стандартный паттерн и проблем с volume'ами нет (у фронта нет volume).

**Верификация:** `docker build` за 16 секунд, образ 224 МБ. `docker run --rm -d -p 3001:3000` — `/` отвечает HTTP 200 за 2 секунды.

---

## 4. compose: ложная persistence, env_file vs Dockerfile ENV {#4-compose-falsepersistence}

### Симптом

После первого smoke-теста (`docker compose restart` посередине, GET сессии возвращает 200) показалось, что persistence работает. Параллельно глянул `./data/` на хосте — там **только пустая `uploads/`, нет `research_agent.db`**. Если bind mount работает, DB файл должен быть на хосте.

### Диагноз

Заглянул в env внутри контейнера:

```
DATABASE_URL=sqlite+aiosqlite:///./research_agent.db    ← НЕ из Dockerfile
CHROMA_PERSIST_DIR=./chroma_db                          ← НЕ из Dockerfile
UPLOAD_DIR=/data/uploads                                ← из Dockerfile ENV
OUTPUT_DIR=/data/outputs                                ← из Dockerfile ENV
```

`DATABASE_URL` и `CHROMA_PERSIST_DIR` — относительные пути, как в дефолтах кода. Значит Dockerfile ENV для них **перебит чем-то более приоритетным**.

Источник — `env_file: .env` в compose. Пользовательский `backend/.env` (скопированный в корень) содержит `DATABASE_URL=` и `CHROMA_PERSIST_DIR=` со старыми относительными путями. Compose их подгружает, и они побеждают Dockerfile ENV (`env_file` имеет приоритет выше Dockerfile ENV).

`UPLOAD_DIR` / `OUTPUT_DIR` остались правильными из Dockerfile, потому что в `.env` пользователя этих переменных не было — они новые, появились только в этой итерации (§1).

### Доказательство ложности первого smoke-теста

`docker compose restart` **не пересоздаёт** контейнеры — рестартует уже существующий контейнер. DB файл при таком сценарии живёт во внутренней FS контейнера, а не в bind mount. Сессия «персистит», но только до `docker compose down`.

Реальный тест — `docker compose down && rm -rf data && docker compose up -d`. После создания сессии и нового `down/up` (фрэш контейнеры из образа) — сессия должна быть на месте. До фикса — была HTTP 404. После фикса — HTTP 200, и `./data/research_agent.db` появился на хосте.

### Фикс

В `docker-compose.yml` добавлен явный `environment:` блок поверх `env_file:`. В compose приоритет: `environment:` > `env_file:` > Dockerfile ENV. То есть compose теперь self-contained по путям — что бы ни лежало у пользователя в `.env`, в контейнере будет именно `/data/...`:

```yaml
environment:
  - DATABASE_URL=sqlite+aiosqlite:////data/research_agent.db   # 4 слеша = sqlite:// + /data/...
  - CHROMA_PERSIST_DIR=/data/chroma_db
  - UPLOAD_DIR=/data/uploads
  - OUTPUT_DIR=/data/outputs
```

### Урок

`docker compose restart` ≠ верификация persistence. Тест должен быть `down && up` (или `down -v && up` если речь про named volumes). На этом я почти попался; помогла привычка смотреть «где реально файл», а не только «отвечает ли API».

---

## 5. SSE-буферизация в Next.js standalone {#5-sse-buffering}

### Симптом

Wizard прошёл до этапа гипотез. На пятом шаге UI выдал «Ошибка агента: Агент не отвечает», в логах бэка — OpenAI ответил 200 OK, агент дописал, `[DONE]` отправлен. Бэк всё сделал; фронт не дождался.

### Что я думал → что оказалось

Сначала подозревал бэк (memory note про singleton AsyncOpenAI). Грепнул логи — context-агент финиширует, hypothesis-агент тоже идёт. Дальше пошёл в `frontend/hooks/useSSE.ts`. И там — буквально комментарий автора кода на строках 78–83:

> "SSE bypass: Next.js dev rewrites buffer streaming responses (the built-in proxy never flushes until the upstream closes), which kills long agent streams. When NEXT_PUBLIC_BACKEND_URL is set, hit the backend directly — backend CORS already allows the frontend origin. **In prod (no env var) we fall back to the proxy path; production proxies (Vercel/nginx) handle SSE correctly.**"

Автор предполагал прод = Vercel или nginx. **Но в docker-compose проксирует сам Next.js standalone — тот же буферящий проксер, что и в dev.** Heartbeats `: keepalive` каждые 20 секунд от бэка не доходят до браузера, idle-timer на фронте срабатывает на 60-й секунде, аборт стрима, ошибка.

Это та же история, что зафиксирована в memory — `project_sse_buffering_pitfalls.md` — но в новом контексте.

### Фикс

Установить `NEXT_PUBLIC_BACKEND_URL=http://localhost:8001` в build-arg, чтобы Next.js при сборке запекал его в JS-бандл. Тогда `useSSE` идёт **напрямую** к бэку через хост-порт, минуя Next.js-прокси. Backend CORS уже разрешает `http://localhost:3001`.

В `frontend/Dockerfile`:
```dockerfile
ARG NEXT_PUBLIC_BACKEND_URL=http://localhost:8001
ENV NEXT_PUBLIC_BACKEND_URL=$NEXT_PUBLIC_BACKEND_URL
RUN npm run build
```

В `docker-compose.yml`:
```yaml
frontend:
  build:
    context: ./frontend
    args:
      BACKEND_URL: http://backend:8000              # для SSR-rewrites внутри Next
      NEXT_PUBLIC_BACKEND_URL: http://localhost:8001 # для browser-side fetch к бэку
```

После пересборки — wizard прошёл до конца.

### То же касается обычных fetch'ей

`BACKEND_URL` (без `NEXT_PUBLIC_`) — серверный rewrite в Next.js. Он тоже **запекается на этапе build**, потому что `routes-manifest.json` собирается компилятором. Если задать `BACKEND_URL` только в `environment:` (runtime) без `args:` (buildtime), rewrite не подхватит env и зафиксирует fallback `http://localhost:8000`. Это и был самый первый HTTP 500 на втором экране wizard'а до того, как я перевёл `BACKEND_URL` в build-args.

### Урок

В Next.js standalone **и серверные, и `NEXT_PUBLIC_*` env'ы должны попадать в образ в build-time через `ARG`**, не через runtime `ENV`. Runtime env работает только для кода, который читает `process.env` динамически — не для rewrites, не для запечённых клиентских бандлов.

---

## 6. WeasyPrint 62.3 vs pydyf 0.12 — silent PDF failure {#6-weasyprint-pydyf}

### Симптом

Сценарий пройден, выгрузил ZIP. В нём 6 файлов `.docx`, **ни одного `.pdf`**. UI ошибок не показал. На хосте в `./data/outputs/<sid>/` тоже только `.docx`.

### Причина silence

`backend/documents/generator.py:64`:
```python
if fmt == "pdf":
    pdf_path = os.path.join(output_dir, f"{safe}.pdf")
    try:
        import mammoth
        from weasyprint import HTML
        ...
        HTML(string=html_content).write_pdf(pdf_path)
    except Exception:
        return None
    return pdf_path
```

Голый `except Exception: return None`. PDF молча выпадает из ZIP, на фронт идёт только список того, что сгенерировалось.

### Реальная причина (после запуска руками с traceback'ом)

```
File "/usr/local/lib/python3.11/site-packages/weasyprint/pdf/stream.py", line 246, in transform
    super().transform(a, b, c, d, e, f)
AttributeError: 'super' object has no attribute 'transform'
```

`weasyprint==62.3` ожидает `pydyf.Stream.transform`, но в `pydyf>=0.11` этот метод убрали из родительского класса. Известная регрессия совместимости.

В `backend/requirements.txt` был пинан только `weasyprint==62.3`. `pydyf` тянулся транзитивно последний. На свежем `pip install -r requirements.txt` (внутри Docker) подтянулся `pydyf-0.12.1`. В локальном `.venv` у пользователя пинался старый (`<0.11`) — там PDF работал, и поэтому регрессия не была замечена раньше.

### Фикс

Добавил `pydyf<0.11` в `backend/requirements.txt`. Это правильный фикс не только для Docker, но и для воспроизводимости env вообще — любой, кто соберёт venv с нуля, получит работающий WeasyPrint без сюрприза.

После пересборки backend-контейнера и прямого вызова `HTML.write_pdf` через `docker exec` — PDF сгенерировался, 28.8 КБ, появился на хосте в `./data/outputs/.../*.pdf`.

### Альтернатива (не выбрана)

Обновить WeasyPrint до 64.x. Это бы решило, но 64.x могла привезти другие API-изменения; патч-пин на `pydyf` тиснее по поверхности и точнее по диагнозу.

### Урок

Когда библиотека А зафиксирована, а её зависимость Б — нет, апгрейд Б становится скрытым выключателем. `pip-tools` / `uv pip compile` решают это лок-файлом. Для self-host минимально достаточно — пинать всё, что known-bad без пина (как сделал с `pydyf`). Полный lockfile — Phase 1.

---

## 7. End-to-end проверка

После всех фиксов прогон:

1. `docker compose -p research-agent down && rm -rf data`
2. `docker compose -p research-agent up -d --build`
3. Браузер → `http://localhost:3001` → заполнил бриф / контекст / задачу.
4. Загрузил два PDF для RAG.
5. Прошёл этапы: clarify → brief → context → hypothesis → method → sampling → design → done.
6. Скачал ZIP-пакет.
7. `docker compose -p research-agent down && docker compose up -d` (фрэш контейнеры).
8. GET той же сессии по `session_id` + `owner_token` — HTTP 200, состояние на месте.
9. Скачал ZIP заново — 12 файлов: 6 `.docx` + 6 `.pdf`, кириллица в PDF читается.

В `./data/` после прогона:
```
./data/
├── research_agent.db          (768 KB)
├── chroma_db/                 (29 MB — HNSW индексы + sqlite3 + ONNX-модель кэш)
├── uploads/<session_id>/      (исходные PDF пользователя)
└── outputs/<session_id>/      (docx + pdf + research_package.zip)
```

Имя проекта `research-agent` пришлось задавать через `-p` и `name: research-agent` в compose, потому что папка репо называется `Новая папка` (кириллица + пробел) — compose из такого имя проекта вывести не может.

---

## 8. README self-host

В `README.md` между «Быстрый старт» и «Конфигурация» добавлена секция `## Self-host (Docker)`. Покрывает:

- Запуск (`cp .env.example .env` → `docker compose up -d --build`).
- Где лежат данные (`./data/...`).
- Частые команды (логи, остановка, пересборка, сброс под ноль).
- **Как менять порты** — с явным напоминанием, что после изменения хост-портов нужно одновременно обновить `CORS_ORIGINS` и `NEXT_PUBLIC_BACKEND_URL` и пересобрать (потому что URL запекается в build-time).
- Особенности: arm64/x86 архитектура билда, кириллица в имени папки → `-p`, SSE bypass через прямой backend-URL.

Эти три «гочи» — прямые выводы из дефектов §4, §5, и из контекста этой работы. Если бы пользователь сам копал — он бы потратил то же время на них.

---

## 9. Эпистемические заметки

1. **Hook self-check'а каждый ответ — сэкономил минимум один ложный фикс.** На моменте «persistence работает по `restart`» он не задал вопрос напрямую, но привычка задавать «гипотеза проверена или наследована?» подсказала проверить `ls data/` — оттуда и пошла раскрутка.

2. **`docker exec` для прямого вызова сломанной функции — самый быстрый способ найти silent failure.** PDF не генерируется → ловишь `try/except Exception: return None` → вылавливаешь traceback скриптом из 5 строк через `docker exec backend python3 -c "..."`. Прятать traceback за широким `except` в коде, который пишет в файлы, — антипаттерн; добавить лог не помешает.

3. **Build-time vs run-time env в Next.js — то место, где документация Next.js путает, а интуиция «прод = Vercel» подводит.** Любая система, где Next.js standalone сам играет роль прокси (docker-compose, kube без отдельного ingress), наследует ту же буферизацию SSE, что и dev. Производственная конфигурация может означать «прод-стек», но не «прод-прокси».

4. **«Где реально лежит файл?» — дешёвая проверка, ловит больше, чем кажется.** На каждом шаге я смотрел `./data/` на хосте — это сразу показало, что bind mount не работает, что DB файл не пишется, и т.п. API-ответы лгут (могут отвечать корректно, читая из локальной FS контейнера), файлы на диске — нет.

5. **Stream-closed на нескольких `Edit` подряд → переключиться на Bash + Python.** Когда инструмент Edit начал ловить «Stream closed» на трёх правках подряд, я перешёл на патч через Python heredoc внутри Bash. Это не fix самого инструмента, но обход, который продолжил работу. Если бы цеплялся за Edit — потеря 10+ минут.

---

## 10. Что осталось открытым

1. **Образ собирается под архитектуру хоста.** На Apple Silicon → arm64, на x86 Linux → amd64. Для multi-arch (например, выложить готовый образ в ghcr.io под обе архитектуры) нужен `docker buildx --platform`. Пока — каждый self-host пользователь билдит сам, что и нормально на старте Phase 2.

2. **PDF generation в `documents/generator.py` всё ещё проглатывает `Exception`.** Фикс на pydyf сделан, но защита от молчания нет. Когда WeasyPrint снова что-то сломает (а это случается раз в полгода-год), пользователь получит ZIP без PDF и без причины. Минимальная правка — заменить `except Exception:` на `except Exception as e: logger.warning("PDF gen failed: %s", e); return None`. Не делал в этой итерации, чтобы не размывать scope.

3. **Локальный `backend/.env` пользователя содержит лишние `DATABASE_URL=` и `CHROMA_PERSIST_DIR=`** со старыми путями. Compose их перебивает (§4), поэтому работает. Но если пользователь снимет `environment:` override — компоуз вернётся к относительным путям. Стоит почистить `backend/.env`, или (надёжнее) добавить комментарий в `.env.example`, что эти переменные **не нужны** для docker-compose. Не делал.

4. **`docker compose -p research-agent`** — флаг `-p` обязателен из-за кириллицы в имени папки. Описано в README, но это пятно UX. Если пользователь переименует папку в `research-agent` — `-p` уже не нужен. Не настаиваю, документально упомянуто.

5. **Phase 1 (веб-демо)** — не начата. Требует: magic-link auth, Cloudflare Turnstile, kill-switch по дневному бюджету, Resend/Loops, deploy на Vercel + Railway. План задач в `docs/launch-plan.md` Фаза 1.

6. **Phase 3 (лендинг + README под нетехническую аудиторию)** — не начата. Текущий README остался developer-focused; план в `launch-plan.md` Фаза 3 предполагает переписать под аудиторию «продакт смотрит из любопытства».
