# Deploy Phase 1 (Web demo) — пошаговый чек-лист

Цель: запустить веб-демо доступным по публичному URL. Backend → Railway, frontend → Vercel.

Перед запуском кода всё уже подготовлено в репо: `backend/railway.toml`, `frontend/vercel.json`, `AUTH_MODE` feature-flag, `/login` + magic-link флоу.

---

## 0. Подготовка (15–30 минут)

### 0.1. Домен

Тебе нужны 2–3 хоста:

| Хост | Где | Пример |
| --- | --- | --- |
| Frontend | Vercel | `yourdomain.com` или `your-project.vercel.app` |
| Backend | Railway | `api.yourdomain.com` или `your-project.up.railway.app` |
| Email "from" | Resend | `noreply@yourdomain.com` (нужен верифицированный домен) |

**Самый дешёвый старт**: использовать дефолтные домены Vercel/Railway (бесплатно). Для Resend сложнее — нужен **либо** свой домен (минимум `.com` за ~$10/год + 5 минут на DNS-записи Resend), **либо** `onboarding@resend.dev` (отдаст письма только на email владельца Resend-аккаунта — годится для smoke-теста, но не для реальных юзеров).

### 0.2. Resend

1. Создать аккаунт на https://resend.com (бесплатный тариф — 3000 emails/мес).
2. (Опционально, но нужно для рассылки на чужие email) Verify Domain: вставить TXT/CNAME записи Resend в DNS своего домена.
3. Создать API key → сохранить (понадобится для Railway env).

### 0.3. OpenAI

Должен уже быть. Уверься что у ключа есть кредиты — на проде он будет расходоваться.

---

## 1. Backend → Railway

### 1.1. Создание сервиса

1. Зайти на https://railway.app, выбрать существующий project или создать новый.
2. **New Service → Deploy from GitHub Repo** (если репо на GitHub) или **Empty Service** + later push.
3. Подключить репо. Если репо не на GitHub — установить Railway CLI:
```
   npm i -g @railway/cli
   railway login
   cd backend && railway link
   railway up
```
4. **Settings → Service → Root Directory: ****`/backend`**. Это критично — иначе Railway будет пытаться билдить из корня, где нет Dockerfile.
5. Railway автоматически найдёт `backend/Dockerfile` и `backend/railway.toml`. Healthcheck на `/health` уже прописан.

### 1.2. Volume

1. **New → Volume**. Назвать например `data`.
2. **Attach Volume**: выбрать наш backend service. Mount path: **`/data`** (это ключевой момент — backend пишет в `/data/research_agent.db`, `/data/chroma_db`, `/data/uploads`, `/data/outputs`).
3. Без volume **всё стирается на каждом redeploy** — БД, индексы, аплоады, документы.

### 1.3. Environment Variables

В **Variables** вкладке добавить (каждая отдельным значением, не одним блоком):

```
OPENAI_API_KEY            = sk-...
OPENAI_MODEL              = (твой основной, например gpt-5.5)
OPENAI_MODEL_MINI         = (твой mini, например gpt-5.5-mini)

AUTH_MODE                 = required
RESEND_API_KEY            = re_...
RESEND_FROM               = Research Agent <noreply@yourdomain.com>

BACKEND_PUBLIC_URL        = https://<railway-public-url>
FRONTEND_URL              = https://<vercel-public-url>
CORS_ORIGINS              = https://<vercel-public-url>

DATABASE_URL              = sqlite+aiosqlite:////data/research_agent.db
CHROMA_PERSIST_DIR        = /data/chroma_db
UPLOAD_DIR                = /data/uploads
OUTPUT_DIR                = /data/outputs
```

> `<railway-public-url>` и `<vercel-public-url>` подставишь после первых деплоев — это циклическая зависимость. Сначала выкатить с placeholder'ами, потом обновить.

### 1.4. Generate Domain

**Settings → Networking → Generate Domain**. Скопировать URL — это и есть `<railway-public-url>`. Вернуться в Variables и подставить.

### 1.5. Smoke-проверка backend

```
curl https://<railway-public-url>/health      # → {"status":"ok"}
curl https://<railway-public-url>/            # → {"message":"...","version":"0.1.0"}
```

Если 502 / "Application failed to respond" — открыть **Logs**, посмотреть на стадию `alembic upgrade head` и стартап uvicorn'а.

---

## 2. Frontend → Vercel

### 2.1. Создание проекта

1. На https://vercel.com → **Add New → Project**.
2. Импортировать репо. Если не на GitHub — установить Vercel CLI:
```
   npm i -g vercel
   cd frontend && vercel
```
3. **Root Directory: ****`frontend`** (Vercel должен видеть `frontend/package.json`).
4. **Framework Preset**: Next.js (определится автоматически из `vercel.json`).
5. **Build Command**: оставить default (`npm run build`).

### 2.2. Environment Variables

В **Settings → Environment Variables** добавить **для всех окружений** (Production/Preview/Development) — все три должны совпадать, иначе preview-деплои сломаются:

```
BACKEND_URL                  = https://<railway-public-url>
NEXT_PUBLIC_BACKEND_URL      = https://<railway-public-url>
NEXT_PUBLIC_AUTH_MODE        = required
```

**ВАЖНО**: и `BACKEND_URL`, и `NEXT_PUBLIC_BACKEND_URL` запекаются в build-time (см. `iteration-14.md` §5). Если потом меняешь URL → нужен **Redeploy** в Vercel, runtime-обновления не подхватит.

### 2.3. Deploy + custom domain (опционально)

1. **Deploy** — первый билд.
2. (Опционально) **Settings → Domains → Add** свой домен. После добавления:
  - Vercel выдаст DNS-записи.
  - Когда домен заработает — обновить `FRONTEND_URL` и `CORS_ORIGINS` на Railway, и redeploy backend (Railway тоже env-as-build не использует, но процесс должен перезапуститься чтобы CORS подхватился).

### 2.4. Smoke-проверка frontend

1. Открыть `https://<vercel-public-url>/`.
2. Ожидать **редирект на ****`/login`** (потому что `NEXT_PUBLIC_AUTH_MODE=required` и нет токена).
3. На `/login` ввести свой email → «Получить ссылку».
4. Открыть почту → перейти по ссылке → должен быть редирект на `/auth/callback?auth_token=...` → автоматически на `/`.
5. Заполнить landing-wizard → создать сессию → пройти этапы → выгрузить ZIP.

**Если на шаге 3 не приходит письмо**:
- Backend Logs на Railway: ищи `Resend send failed` — там будет точный ответ Resend.
- Если используется `onboarding@resend.dev` — письмо приходит ТОЛЬКО на email владельца Resend-аккаунта.
- Если используется свой домен — проверь, что domain verified в Resend Dashboard (TXT/CNAME записи).

---

## 3. Проверка gate D

После того как ты прошёл шаг 2.4 и создал одну сессию:

1. Залогинься тем же email ещё раз (новый magic-link).
2. После `/auth/callback` ты автоматически окажешься **на странице существующей сессии**, а не на landing-wizard'е (это работа `/api/me → existing_session_id → router.replace`).
3. Попытка вручную открыть `/` создаст POST → backend ответит `409 {error: "session_exists", existing_session_id: ...}` → фронт сделает `router.replace`.

---

## 4. Откат / переключение в self-host режим

Если что-то сломалось и нужно быстро вернуться к self-host флоу без auth:

- На Railway: установить `AUTH_MODE=disabled`, перезапустить. На фронте — оставить `NEXT_PUBLIC_AUTH_MODE=disabled` и redeploy.
- В этом режиме backend работает как до Phase 1: любой может создать сессию, gate не действует.

---

## 5. Известные ограничения альфы

- **Один volume = один backend instance**. Если попытаться горизонтально масштабировать backend на Railway — SQLite-файл будет конфликтить (Railway не позволит mount one volume в multiple replicas). Для текущего масштаба (100–200 сессий/мес) — это не проблема.
- **SSE-стримы 5–10 минут**. Vercel free/hobby ограничивает функции по времени, но у нас SSE идут **напрямую** к Railway (`NEXT_PUBLIC_BACKEND_URL`), минуя Vercel proxy — то же решение, что в `iteration-14.md` §5. Railway без таймаута на инстанс-уровне.
- **Kill-switch не реализован**. Если кто-то ботом нагенерит сессий, бюджет не защищён. Это todo для следующей итерации (`launch-plan.md` Phase 1 — Kill-switch by daily budget).
- **Turnstile не реализован.** Та же причина — отложено.
- **Cap на длину input.** Тоже отложено.
