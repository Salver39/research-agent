# Итерация 13 — Подготовка к публичному запуску, code hygiene, token budget на агентах

**Дата:** 2026-05-17
**Продолжение:** `iteration-12.md` (open question §13.2 про MethodAgent token budget).
**Цель:** определиться со способом дистрибуции под цель «репутация + лиды»; закрыть тихие fallback'и в env-конфиге; собрать реальную экономику по OpenAI; найти корень падений/висов на множественной загрузке документов.

**Итог:** 8 правок в коде, 1 новый документ (`docs/launch-plan.md`), 1 запись в memory, 1 открытая проблема `iteration-12.md` §13.2 закрыта по логике (та же правка покрывает оба агента). Backend ни разу не упал после правок. Один ложный след (telemetry → крэш) — потрачено ~15 минут, опровергнуто эмпирикой.

---

## Содержание

1. [Стратегия дистрибуции — итог обсуждения и `launch-plan.md`](#1-стратегия-дистрибуции)
2. [Экономика по реальным OpenAI usage отчётам](#2-экономика-по-реальным-данным)
3. [Code hygiene: fail-fast на env, убраны тихие fallback'и моделей](#3-code-hygiene-fail-fast)
4. [Usage logging + `finish_reason` (диагностический инструментарий)](#4-usage-logging)
5. [Диагностика «крэш на 3-м файле» — ложный след про telemetry](#5-ложный-след-telemetry)
6. [Реальный root cause «документов нет на этапе паттернов» — token budget](#6-token-budget-root-cause)
7. [Память: Chroma telemetry noise](#7-память-chroma-telemetry-noise)
8. [Эпистемические заметки](#8-эпистемические-заметки)
9. [Что осталось открытым](#9-что-осталось-открытым)

---

## 1. Стратегия дистрибуции

**Контекст вопроса:** «Хочу поделиться проектом — задеплоить или раздать как self-host?». Несколько итераций уточнений ЦА и цели:

- **ЦА** — фрилансеры и стартапы (продакты, дизайнеры, исследователи без техбэкграунда). Не корпорации.
- **Цель** — репутация + лиды на консалтинг/заказы. Не SaaS, не выручка.
- **Чувствительность данных** — пользователи часто грузят NDA-материалы, спросят про privacy первым делом.

**Что отпадает под эту комбинацию:**
- `curl | bash` install-скрипт через терминал — для нетехничной ЦА это стена (Homebrew, антивирусы, Gatekeeper, права админа).
- Docker Desktop — тоже барьер для дизайнера/исследователя.
- Portable bundle (PyInstaller/Tauri/Electron) — единственный реалистичный self-host для не-разработчиков, но это недели работы; преждевременно до валидации спроса.
- Корпоративный обвес (Azure OpenAI, ZDR, SSO) — не для ЦА.

**Принятый сетап (`docs/launch-plan.md`):**
1. **Веб-демо с одной бесплатной сессией на email.** Magic-link auth, Cloudflare Turnstile, kill-switch по дневному бюджету. BYOK не нужен (см. §2 — экономика позволяет платить самому).
2. **Self-host через `docker-compose.yml`** — для тех, кому privacy критична.
3. **Лендинг + 2–3 минуты видео + GitHub README с design decisions** — это и есть демонстрация экспертизы.
4. **Один публичный пост** в формате «методология → инструмент как иллюстрация» (vc.ru / Хабр / LinkedIn).

Полный план с задачами, оценками и явным «что НЕ делать» — в `docs/launch-plan.md`.

---

## 2. Экономика по реальным данным

Пользователь скачал три отчёта с `platform.openai.com` за 11–17 мая: `completions_usage`, `embeddings_usage`, `cost`. Сопоставил с количеством сессий в `research_agent.db`.

**Главные цифры:**

| Метрика | Значение |
|---|---|
| Сессий в БД за неделю | 29 |
| Общий cost за неделю | $26.50 |
| **Средняя стоимость сессии** | **~$0.91** |
| Разброс по дням | $0.23 – $4.47 |
| Embeddings | **$0** — навсегда |
| Вызовов модели на одну сессию | ~17 (480 запросов gpt-5.5 / 29 сессий) |
| Кэш input-токенов gpt-5.5 | ~60% работает |

**Embeddings = $0 объясняется:** `backend/rag/client.py` создаёт `PersistentClient` без `embedding_function`, значит используется Chroma default — локальная ONNX-модель через `onnxruntime` (уже в venv). RAG ничего не платит OpenAI и не будет, пока кто-то явно не заменит embedding function.

**`gpt-4o` в отчёте за 12 мая (38 запросов)** — оказалось остатками от тихих fallback'ов в коде (`os.environ.get("OPENAI_MODEL", "gpt-4o")`), когда `.env` ещё не был перенастроен на gpt-5.5. После настройки `.env` запросы больше не уходили на gpt-4o, но **landmine остался в коде** — это закрыто в §3.

**Что решает экономика:**
- BYOK на старте **не нужен** — при $0.91/сессия и kill-switch $30–50/день месячный потолок ~$300–500 в худшем случае.
- Self-host **экономически бесплатен** для меня (embeddings локальные, completions платит юзер своим ключом).

---

## 3. Code hygiene: fail-fast

### Проблема

В трёх местах кода стояли тихие fallback'и моделей:

```python
# brief.py:117-118
return os.environ.get("OPENAI_MODEL_MINI", "gpt-4o-mini")
return os.environ.get("OPENAI_MODEL", "gpt-4o")

# validator.py:82
model=os.environ.get("OPENAI_MODEL_MINI", "gpt-4o-mini"),

# base.py:92
return os.environ.get("OPENAI_MODEL", "gpt-5.5")
```

Если `.env` забыт или переменная не подхватилась — код **молча** уходит на дефолт. Это уже стрельнуло в §2 (расход на gpt-4o за 12 мая), а при self-host пользователь, забывший прописать `OPENAI_MODEL`, тихо уедет на gpt-4o с другим биллингом и поведением.

### Что сделано

1. **`brief.py`** — `os.environ["OPENAI_MODEL_MINI"]` / `os.environ["OPENAI_MODEL"]`, без fallback. KeyError при отсутствии.
2. **`validator.py`** — то же. **Важная тонкость:** в `validate_clarity` есть `except Exception` с fail-open поведением. Если оставить `os.environ[...]` внутри try-блока, KeyError будет проглочен и валидатор тихо вернёт «ok». Поэтому чтение env-переменной вынесено **до** try-блока. Теперь fail-fast работает по-настоящему.
3. **`base.py`** — то же убрано (по аналогии, симметрия).
4. **`main.py`** — добавлен fail-fast блок сразу после `load_dotenv`:

```python
for _key in ("OPENAI_API_KEY", "OPENAI_MODEL", "OPENAI_MODEL_MINI"):
    if not os.environ.get(_key):
        raise RuntimeError(f"{_key} is not set — check backend/.env")
```

Это лучше, чем падение на первом юзерском запросе через 30 секунд после старта.

### Проверка

Прогнаны 4 runtime-теста через `.venv/bin/python -c "import main"`:
- С `.env` — импорт проходит (positive: OK).
- Без всех 3 переменных — `RuntimeError: OPENAI_API_KEY is not set — check backend/.env`.
- Без только `OPENAI_MODEL` — `RuntimeError: OPENAI_MODEL is not set — check backend/.env`.
- Без только `OPENAI_MODEL_MINI` — `RuntimeError: OPENAI_MODEL_MINI is not set — check backend/.env`.

Чтобы тест работал, в негативных кейсах нужно подменять `load_dotenv` на no-op (`dotenv.load_dotenv = lambda *a, **kw: None`), иначе `.env` с `override=True` перепишет переменные обратно.

---

## 4. Usage logging

### Проблема

Не было видимости в стоимость сессии. SQL по БД хранит только финальный state, без промптов и без `usage`. Способ 2 из обсуждения (логировать `response.usage` в SDK) к прошлым тестам неприменим — данных нет.

Дополнительный подвох: в `agents/base.py:stream` вызов идёт со `stream=True`, **без** `stream_options={"include_usage": True}`. Без этой опции `chunk.usage` в стриме просто не приходит — даже если добавить логирование, оно ничего не увидит.

### Что сделано

В `agents/base.py:stream`:
- Добавлено `stream_options={"include_usage": True}`.
- В цикле по chunk'ам ловится usage (приходит в **финальном** chunk, после всех choice-chunks) и логируется:

```
agents.base INFO openai_call agent=ContextAgent model=gpt-5.5 prompt=7112 completion=2048 finish=length
```

В `agents/validator.py` (не-streaming) — логируется `response.usage` напрямую с `finish_reason`.

### Что это сразу дало

В первой же сессии после правки увидел в логах **прямое доказательство** проблемы из §6:
```
openai_call agent=ContextAgent model=gpt-5.5 prompt=7112 completion=2048 finish=length
```
`completion=2048` ровно равно `_max_tokens()`, `finish=length` — это и есть «JSON обрезан по лимиту». Без `finish_reason` пришлось бы гадать.

---

## 5. Ложный след — telemetry

### Что увидел

В логах при загрузке файлов сыпались строки:
```
chromadb.telemetry.product.posthog ERROR Failed to send telemetry event ClientStartEvent: capture() takes 1 positional argument but 3 were given
```

Это `chromadb==0.5.23` + новый `posthog-python` с несовместимым API: telemetry внутри Chroma пытается отправить событие, попадает в TypeError. Параллельно пользователь сообщил, что бэк **тихо падает** при загрузке 3-го файла подряд — без traceback, без сообщений, просто оборванный лог.

### Гипотеза, которая оказалась ложной

«Telemetry exception внутри `_index_and_mark_done` (BackgroundTask) роняет event loop, что валит весь процесс тихо». Это сошлось бы по симптомам, но было спекуляцией без доказательств.

### Что сделал по этой гипотезе

1. Добавил `ANONYMIZED_TELEMETRY=False` в `backend/.env` и `.env.example` — **не сработало**, ERRORы остались.
2. Добавил `Settings(anonymized_telemetry=False)` напрямую в `chromadb.PersistentClient(...)` в `rag/client.py` — **тоже не сработало**, ERRORы остались.

### Эмпирический результат

После правок процесс **перестал падать** на 3-м файле, но telemetry-ERRORы **продолжали сыпаться**. Это **опровергает гипотезу** — telemetry-исключение ловится внутри Chroma и не пробрасывается выше. Реальная причина крэшей из `iteration-12.md` §13.1 остаётся неизвестной (не воспроизвелось в этой сессии после правок).

### Что в итоге

- Правки в `rag/client.py` и `.env` оставил — они безвредны, и комментарий в `rag/client.py` объясняет почему передаём `Settings`.
- Знание «`ANONYMIZED_TELEMETRY=False` и `Settings` НЕ помогают в Chroma 0.5.23» записано в memory (§7), чтобы в будущем не уходить в тот же ложный след.

---

## 6. Token budget — root cause

### Симптом

Пользователь загрузил 3 файла, дошёл до этапа «Найденные паттерны», агент отработал и выдал «Документов нет — агент будет работать только с брифом». При том что:

```
sources statuses:
  Raif_NW_Премиум-программы.txt → indexed
  Raif&NW_Премиум-программы_w3.pdf → indexed
  Psikhicheskaya_podgotovka_sportsmena.pdf → indexed
rag_fragments count: 6
patterns count: 0
```

RAG нашёл фрагменты, но `patterns` пустой.

### Доказательство в логе

```
openai_call agent=ContextAgent model=gpt-5.5 prompt=7112 completion=2048 finish=length
api.stream WARNING persist: JSON parse failed at stage=context;
   raw[:300]='{\n  "patterns": [\n    {\n      "text": "Ключевой бизнес-сигнал...
```

- `completion=2048` ровно равно `_max_tokens()` в `BaseAgent`.
- `finish=length` — модель упёрлась в потолок, ответ обрезан.
- Парсер JSON падает, в state записывается пустой `patterns`, фронт показывает fallback-сообщение.

Это **в точности** тот же класс проблем, что `iteration-12.md` §13.2 (MethodAgent stochastic empty response → кандидат token budget на reasoning). Теперь видно явно: JSON не пустой, а **обрезан** в середине структуры.

### Что сделано

В `agents/base.py:_max_tokens()`:
```python
def _max_tokens(self) -> int:
    # Ceiling, not target — OpenAI bills only generated tokens. 2048 was too
    # tight for ContextAgent / MethodAgent on long prompts: JSON got cut
    # mid-structure (finish_reason="length") and persist crashed on parse.
    return 8192
```

Меняется ОДНО число; покрывает все агенты, наследующие `BaseAgent` (включая MethodAgent). Цена не растёт сама по себе — это потолок, OpenAI берёт только за сгенерированные токены. На практике для большинства входов модель будет генерировать меньше 8192.

**Оговорка про reasoning-модели:** для gpt-5.5 `max_completion_tokens` включает скрытые reasoning_tokens. Поднятие потолка **разрешает**, но не **заставляет** модель думать дольше. На простых задачах reasoning не растёт. Если когда-то увидим, что reasoning ест бюджет — можно тюнить `reasoning_effort` отдельно.

### Verification после правки

В следующем прогоне на той же сессии:
```
openai_call agent=ContextAgent model=gpt-5.5 prompt=6981 completion=1777 finish=stop
```
- `completion=1777` — модель завершила сама, **не упёрлась в потолок** (1777 < 8192).
- `finish=stop` — естественное завершение.
- В UI: «Найденные паттерны» с реальными паттернами, гипотезы сформированы корректно.

Гипотеза подтверждена полностью. `iteration-12.md` §13.2 закрывается **по логике** (та же правка применяется ко всем агентам), но **верификация именно на MethodAgent** в этой сессии не выполнена — нужно отдельно при следующем прогоне до method-этапа.

---

## 7. Память: Chroma telemetry noise

Создана запись `project_chroma_telemetry_noise.md` в `~/.claude/.../memory/`:

> В `backend/.venv` стоит `chromadb==0.5.23` + новый `posthog-python` с несовместимым API. При каждой Chroma-операции в логи летит `posthog ERROR ... capture() takes 1 positional argument but 3 were given`. **Это шум, не убийца.** `ANONYMIZED_TELEMETRY=False` и `Settings(anonymized_telemetry=False)` — НЕ отключают эти ERRORы в этой версии. Если нужно реально убрать шум — поднимать chromadb или posthog, либо подавлять логгер `chromadb.telemetry.product.posthog`.

**Why это записано:** я только что потратил время на ложный след «telemetry exception роняет процесс». Запись страхует от того, что в будущей сессии я (или другая сессия) пойдёт по тому же пути.

---

## 8. Эпистемические заметки

1. **Hook самопроверки сработал по делу.** На каждом ответе проверка четырёх пунктов (особенно «гипотеза наследована или проверена?») вылавливала непроверенные утверждения и заставляла либо проверять, либо явно помечать как спекуляцию. Заметные перехваты:
   - «`ANONYMIZED_TELEMETRY=False` решает проблему» — помечено как гипотеза, потом эмпирически опровергнуто.
   - «session_lock блокирует индексацию через polling» — проверил `api/locks.py`, оказалось не так, спекуляцию снял.
   - «cached input стоит 10–50% от обычного» — помечено как «по опыту с предыдущими моделями, не сверка с gpt-5.5».

2. **Ложные следы стоят 15 минут, не часы — если их быстро опровергать.** История с telemetry — типичный пример. Гипотеза правдоподобная, симптомы сходятся, но 30 секунд runtime-теста (запуск + воспроизведение + grep) показывают, что процесс не падает от этого. Это быстрее, чем «логически рассуждать дальше».

3. **«Что изменилось между рабочим и сломанным?» — самый дешёвый вопрос.** На сессии с 3-м файлом я не задал его первым. Если бы задал — сразу бы пошёл искать «что появилось на 3-м, чего не было на 2-х», и не отвлекался бы на гипотезы про общие проблемы (telemetry, `--reload`).

4. **Открытые вопросы из старых итераций — это not-todo лист, который полезно перечитать.** `iteration-12.md` §13.2 был там же написан как кандидат-причина, и сегодня та же правка закрыла её для другого агента (по логике). Если бы я перечитал open questions раньше, дошёл бы до правки за минуты, а не за два часа диагностики.

---

## 9. Что осталось открытым

1. **Тихие крэши uvicorn** из `iteration-12.md` §13.1 — на этой сессии не воспроизвелись после правок Chroma и token budget, но и **не верифицированы как устранённые**. Может проявиться снова на другом сценарии. Если повторится — нужны полные логи момента крэша (`uvicorn ... > /tmp/backend.log 2>&1`) и сравнение с предыдущими.

2. **MethodAgent token budget — закрыт по логике, не верифицирован.** В этой сессии до method-этапа не дошли. При следующем прогоне нужно проверить лог `openai_call agent=MethodAgent ... finish=stop` (не `length`) и убедиться, что pустые ответы из `iteration-12.md` §10 не повторяются.

3. **`ResearchDiagnosisScreen` crash** на старой сессии `4e0eca0a-...` — `TypeError: Cannot read properties of undefined (reading 'map')` на `diagnosis.uncertainty_types`. В памяти стоит запрет на правку без явного запроса (`project_clarify_step3_bug`). Не трогал.

4. **Chroma telemetry-шум.** Косметика, не блокер. Если когда-то будет важно — поднимать chromadb до версии, совместимой с актуальным posthog, либо подавлять логгер.

5. **`docs/launch-plan.md` Фазы 1–4** — не начаты. Это запланированная работа, не баг. Триггер — решение пользователя начать публикацию.
