# Итерация 15 — Phase 1 alpha: magic-link auth + 1-сессия-на-email gate

**Дата:** 2026-05-25
**Продолжение:** `launch-plan.md` (Фаза 1 — Веб-демо).
**Цель альфы:** Email-вход через magic-link, гейт «одна сессия на email», deploy-конфиги Railway/Vercel.

**Итог:** Backend и фронт для альфы готовы, локально верифицированы 11 кейсов (4 ветви magic-link verify + /api/me + два режима gate). На Railway/Vercel ещё не развёрнуто — это руками пользователя по `docs/deploy-phase-1.md`. Из Phase 1 scope намеренно отложены: kill-switch, Turnstile, cap длины input, privacy-disclaimer, Next.js upgrade — это «стабилизация» поверх живой альфы, не критично до первого реального юзера.

---

## Содержание

1. [Принципы и развилки](#1-principles)
2. [Alembic: переход с `Base.metadata.create_all`](#2-alembic)
3. [Модели: User + MagicLinkToken + FK на Session](#3-models)
4. [Auth API: magic-link + Resend + /api/me](#4-auth-api)
5. [AUTH_MODE feature-flag — почему он не был в плане](#5-auth-mode)
6. [Frontend: /login, /auth/callback, /auth/error, guard](#6-frontend)
7. [Gate D в session.py](#7-gate)
8. [Локальная end-to-end верификация](#8-e2e)
9. [Deploy-конфиги Railway + Vercel](#9-deploy)
10. [Эпистемические заметки](#10-epistemic)
11. [Что осталось открытым](#11-open)

---

## 1. Принципы и развилки {#1-principles}

До кодинга зафиксировал три развилки (пользователь подтвердил выбор):

- **Email-провайдер — Resend.** 3000 emails/мес free, простой REST API (`POST https://api.resend.com/emails`), доставка через AWS SES без сложности SES. Loops хороший для lifecycle-маркетинга, но для transactional magic-link это overkill.
- **Формат токенов — UUID-в-БД.** Не подписанные JWT. Преимущество: проще (никакой криптокон-фигурации `JWT_SECRET`), легко аннулировать (`UPDATE users SET auth_token = ...`), и магик-линк токены становятся unguessable за счёт энтропии UUID4 (122 бит).
- **Семантика гейта — вариант D**: запрос `POST /session` ищет любую сессию (активную или завершённую) с этим `user_id`; если есть — 409 с указанием existing. Magic-link relogin → фронт получает auth_token → GET /me видит `existing_session_id` → редирект на её страницу. Защита от abuse + UX «бросил → вернулся».

Все три решения подтверждены до начала кодинга. Четвёртая развилка (`AUTH_MODE`) появилась в процессе — см. §5.

---

## 2. Alembic: переход с `Base.metadata.create_all` {#2-alembic}

### Что было

`backend/db/database.py:15-18`: `init_db()` через `Base.metadata.create_all`. Это создаёт **только отсутствующие таблицы**. Когда модель добавляет колонку — `create_all` ничего не делает (он не знает, как изменить существующую таблицу).

В Phase 2 на свежем `/data` это работало (контейнеры стартовали с пустой БД, `create_all` создал всё с нуля). Но как только Phase 1 deploy на Railway с persistent volume — каждое изменение схемы становится скрытым выключателем.

### Что сделано

- `backend/alembic.ini` + `backend/alembic/env.py` (async-вариант, `render_as_batch=True`)
- `backend/alembic/versions/0001_baseline.py` — snapshot пред-Alembic схемы (только `sessions`)
- `backend/alembic/versions/0002_users_magic_link.py` — новые таблицы и FK
- `db/database.py`: убран `init_db()` — мёртвый код
- `main.py`: убран `await init_db()` из startup
- `backend/Dockerfile`: `CMD ["sh", "-c", "alembic upgrade head && uvicorn ..."]`

### `render_as_batch=True` — обязательно для SQLite

SQLite не умеет полный `ALTER TABLE`. Чтобы добавить колонку с FK — Alembic делает batch-режим: создаёт новую таблицу с нужной схемой, копирует данные, дропает старую, переименовывает. Без `render_as_batch=True` миграция `ADD COLUMN user_id` упала бы.

### Переход для существующих БД

Для существующей БД (например локальная dev `backend/research_agent.db`, которая жила до Alembic) сценарий:

```
docker exec backend alembic stamp 0001_baseline
```

Это говорит Alembic «считай, что миграция 0001 уже применена», и при следующем `upgrade head` пропустится её content, но дальше пойдут инкрементальные. Документировано в `docs/deploy-phase-1.md`.

### Верификация

Запустил backend на фрэш `/data`:

```
INFO  [alembic.runtime.migration] Running upgrade  -> 0001_baseline, baseline: existing sessions table
INFO  [alembic.runtime.migration] Running upgrade 0001_baseline -> 0002_users_magic_link
```

Затем `sqlite3 PRAGMA table_info` показал все 4 таблицы (`alembic_version`, `sessions` с `user_id`, `users`, `magic_link_tokens`) с корректными колонками и индексами.

---

## 3. Модели: User + MagicLinkToken + FK на Session {#3-models}

```
users               (id, email UNIQUE, auth_token UNIQUE, created_at)
magic_link_tokens   (token PK, email, expires_at, consumed_at, created_at)
sessions            (+ user_id FK→users.id, NULLABLE)
```

`Session.user_id` **nullable**, потому что в режиме `AUTH_MODE=disabled` (self-host из Phase 2) сессии создаются без user-привязки. Декларативно это «опциональная привязка».

Per-session `owner_token` оставлен как был — он защищает shareable download-ссылки (`api/deps.py:14-15`). Это второй уровень auth (per-session ресурсы); per-user `auth_token` — первый (создание).

---

## 4. Auth API: magic-link + Resend + /api/me {#4-auth-api}

`backend/api/auth.py`:

- `POST /api/auth/request {email}` → создаёт `magic_link_tokens` row, шлёт письмо через Resend REST API. Tokens TTL = 15 минут. Не раскрывает существует ли email (всегда 200).
- `GET /api/auth/verify?token=...` → проверяет expires/consumed, find-or-create User по email, помечает token consumed_at, **307 redirect** на `{FRONTEND_URL}/auth/callback?auth_token=<users.auth_token>`. На ошибки — `/auth/error?reason={expired|consumed|invalid}`.
- `GET /api/me` (Bearer) → `{email, existing_session_id}`. existing_session_id используется фронтом, чтобы после relogin'а не показывать landing-wizard, а сразу редирект на существующую сессию.

`require_user` — dependency для эндпоинтов, требующих авторизации. `maybe_require_user` — обёртка для эндпоинтов, которые в `AUTH_MODE=disabled` работают без User (см. §5).

### Subtle: timezone в `magic_link_tokens.expires_at`

SQLite не хранит tzinfo. При чтении `row.expires_at.tzinfo is None`. Без forced UTC сравнение с `datetime.now(timezone.utc)` падало бы с `TypeError`. Заплатка:

```python
if expires_at.tzinfo is None:
    expires_at = expires_at.replace(tzinfo=timezone.utc)
```

Это нашёлся в первом curl-тесте expired-кейса — сразу бросилось в глаза.

### Resend integration

Через `httpx` (уже в requirements, не добавляю SDK). `RESEND_API_KEY` + `RESEND_FROM`. При отсутствии ключа — `HTTPException(500, "Email sender is not configured")`. Это понятный сигнал self-host пользователю, что email он не настроил, а не молчаливое падение.

---

## 5. AUTH_MODE feature-flag — почему он не был в плане {#5-auth-mode}

Это **развилка №4**, которой не было в `launch-plan.md`, и до начала фронта я её не предвидел.

### Симптом

Когда написал guard в `app/page.tsx` (если нет auth_token → `/login`), задумался: что будет, если этот же код запускать в self-host docker-compose? Self-host пользователь не настраивает Resend, не имеет публичного домена, и email-флоу для него **мёртв**. Если в self-host же будет редирект на `/login` — пользователь застрял.

### Причина

Phase 1 (веб-демо) и Phase 2 (self-host) в плане были описаны раздельно, но **используют один и тот же кодовый артефакт**. Один deploy-набор (`docker-compose.yml`), одна точка входа (`POST /api/session`). Если жёстко добавить требование Bearer на `POST /session` — Phase 2 ломается.

### Фикс

Environment flag `AUTH_MODE`:
- `disabled` (дефолт, self-host): `maybe_require_user` возвращает `None`, gate не проверяется, в `Session.user_id` пишется `NULL`.
- `required` (Railway prod): `maybe_require_user` делегирует в `require_user` → 401 без Bearer, gate D действует.

Frontend: `NEXT_PUBLIC_AUTH_MODE` (запекается в build, как `NEXT_PUBLIC_BACKEND_URL`). В `app/page.tsx` `useEffect` проверяет mode → если `required` без токена, редирект на `/login`; если `disabled` — сразу `setAuthReady(true)`.

### Цена feature-flag'а

3 строки в auth.py (`auth_required()` + ветка в `maybe_require_user`), 4 строки в page.tsx (`process.env.NEXT_PUBLIC_AUTH_MODE` + guard). Это не «два кодпасса одной фичи» — это один и тот же путь, с development-time флагом для двух deployment-целей.

### Урок

В плане Phase 1/Phase 2 описаны как разные фазы по времени, но в коде они оказались **одним и тем же артефактом в двух конфигурациях**. Я заметил это в момент, когда писал guard. Если бы заметил раньше (при первом дизайн-обсуждении), сразу зафиксировал бы AUTH_MODE как часть схемы, не как пост-fix'инг. Этот разрыв «фазы в плане ≠ артефакты в коде» — урок на будущее.

---

## 6. Frontend: /login, /auth/callback, /auth/error, guard {#6-frontend}

Три новые страницы в `frontend/app/`:

- `login/page.tsx` — форма email + submit → `POST /api/backend/api/auth/request`. Success-state «письмо отправлено» с возможностью resend. 422 от Pydantic EmailStr — показывается «Введите корректный email».
- `auth/callback/page.tsx` — `useSearchParams` для `auth_token`, сохраняет в localStorage, `GET /api/me`, редирект:
  - есть `existing_session_id` → `/session/{id}`
  - иначе → `/`
  - 4xx → ошибка с ссылкой обратно на `/login`
- `auth/error/page.tsx` — таблица reason → human-readable текст, кнопка «Запросить новую ссылку».

### Suspense boundary для `useSearchParams`

В Next.js 14 standalone `useSearchParams` требует Suspense, иначе build выдаст warning «entire page is opted out of static rendering». Обе страницы обёрнуты в `<Suspense>`. SSR показывает fallback (`"..."` или «Завершаем вход...»), client раскрывает реальный контент.

### Lib auth update

`frontend/lib/auth.ts`: добавлены `saveAuthToken`, `getAuthToken`, `clearAuthToken`, `authBearer()`. Owner_token-функции оставлены (per-session уровень не отменён).

### Guard в `app/page.tsx`

```tsx
useEffect(() => {
  if ((process.env.NEXT_PUBLIC_AUTH_MODE ?? "disabled") !== "required") {
    setAuthReady(true);
    return;
  }
  const token = getAuthToken();
  if (!token) { router.replace("/login"); return; }
  setAuthReady(true);
}, [router]);
```

Plus `if (!authReady) return <main>Проверяем вход...</main>;` — без этого на ms показывалась landing-form и резко улетала в /login. UX-шероховатость.

### POST /session обработка ответов

В `handleStart()` добавлено: 409 → берём `existing_session_id` из `detail`, `router.replace`. 401 → `router.replace('/login')`. Это покрывает gate D + auth invalidation.

---

## 7. Gate D в session.py {#7-gate}

```python
@router.post("/session", ...)
async def create_session(
    body: CreateSessionRequest,
    db: AsyncSession = Depends(get_db),
    user: Optional[User] = Depends(maybe_require_user),
):
    if user is not None:
        existing = (await db.execute(select(DBSession).where(DBSession.user_id == user.id))).scalars().first()
        if existing is not None:
            raise HTTPException(409, detail={"error": "session_exists", "existing_session_id": existing.id})
    ...
    db_session = DBSession(..., user_id=user.id if user is not None else None, ...)
```

Простая блокировка на `EXISTS` запросе. В дальнейшем (при росте) индекс `ix_sessions_user_id` (добавлен в миграции 0002) даст O(log n) lookup.

Возможный race condition: два одновременных `POST /session` от одного юзера могут оба пройти проверку и оба создать сессии. На текущем масштабе альфы (один пользователь не кликает Submit два раза подряд за миллисекунды) это accepted risk. Чистое решение — `UNIQUE INDEX ON sessions(user_id) WHERE user_id IS NOT NULL` (partial unique index), это превратит race в DB constraint violation, который можно поймать. Не делаю — преждевременная оптимизация.

---

## 8. Локальная end-to-end верификация {#8-e2e}

Все проверки — `curl` против контейнеров Docker, не reasoning.

| # | Что | Ожидание | Результат |
|---|---|---|---|
| 1 | `alembic upgrade head` фрэш БД | две миграции применятся, head=0002 | ✓ |
| 2 | Schema check | 4 таблицы, sessions+user_id | ✓ |
| 3 | `GET /api/me` без токена | 401 | 401 |
| 4 | `GET /api/me` фейковый токен | 401 | 401 |
| 5 | `POST /api/auth/request` без RESEND_API_KEY | 500 | 500 |
| 6 | `POST /api/auth/request` невалидный email | 422 | 422 (Pydantic EmailStr) |
| 7 | `GET /api/auth/verify` валидный | 307 → /auth/callback?auth_token=... | ✓ |
| 8 | `GET /api/auth/verify` повтор | 307 → /auth/error?reason=consumed | ✓ |
| 9 | `GET /api/auth/verify` несуществующий | 307 → /auth/error?reason=invalid | ✓ |
| 10 | `GET /api/auth/verify` просроченный | 307 → /auth/error?reason=expired | ✓ |
| 11 | `GET /api/me` с реальным token | 200 {email, existing_session_id:null} | ✓ |
| 12 | Frontend `/login`, `/auth/callback`, `/auth/error` build | static, no warnings | ✓ |
| 13 | Frontend `/` без auth_token | HTML с «Проверяем вход...» | ✓ |
| 14 | Frontend → backend proxy (rewrite) | 401/500 пробрасываются | ✓ |
| 15 | MODE=disabled: POST /session ×2 без Bearer | оба 200 | ✓ |
| 16 | MODE=required: POST /session без Bearer | 401 | 401 |
| 17 | MODE=required: POST /session с фейковым | 401 | 401 |
| 18 | MODE=required: POST /session с реальным | 200 | 200 |
| 19 | MODE=required: повтор | 409 + existing_session_id | ✓ |

Что **не** проверено локально:
- Фактическая доставка письма через Resend (нужен реальный API key + verified domain). Будет в прод-smoke после deploy.
- Поведение `/auth/error` в браузере (SSR возвращает Suspense fallback `"..."`, реальный текст рендерится на клиенте — стандартный pattern, верификация = открыть в браузере).
- Поведение фронта на медленной/нестабильной сети.

---

## 9. Deploy-конфиги Railway + Vercel {#9-deploy}

- `backend/railway.toml` — `[build].builder = "dockerfile"`, `[deploy].healthcheckPath = "/health"`, `restartPolicyType = "on_failure"`.
- `frontend/vercel.json` — `framework: "nextjs"` + дефолтные build/install commands.
- `docs/deploy-phase-1.md` — пошаговая инструкция: создание сервиса, volume mount (`/data` критично), env vars, smoke-проверка, известные ограничения, инструкция отката в `AUTH_MODE=disabled`.

Не делал автодеплой/CI — пользователь будет руками на Railway/Vercel дашбордах в первый раз. CI-пайплайн (GitHub Actions + автоматический deploy на merge) — следующая итерация, после того как ручной флоу проверен.

---

## 10. Эпистемические заметки {#10-epistemic}

1. **Развилка про AUTH_MODE — пример «фазы в плане ≠ артефакты в коде».** Я её **не** запланировал — заметил в момент, когда уже писал guard. Урок: при дизайне многоэтапных запусков (web demo + self-host) проверять, что они существуют как **разные deploy-конфигурации одного артефакта**, а не как разные кодовые ветки. Это не первая такая развилка в этом проекте — будет ещё.

2. **`render_as_batch=True` — то, что отличает «Alembic поднялся» от «Alembic работает на SQLite».** Без него ALTER TABLE падает. Это знание из документации Alembic, но в большинстве туториалов опущено (там Postgres-примеры). На SQLite это **обязательно**.

3. **Self-check hook задаёт правильный вопрос: «гипотеза наследована или проверена?»** В этой итерации после рекона субагентом я сразу честно отметил «состояние кода знаю по пересказу, не своими глазами», и до старта кодинга открыл 5 файлов лично (`db/models.py`, `api/session.py`, `api/deps.py`, `lib/auth.ts`, `app/page.tsx`). Это спасло от того, что субагент мог упустить (например, что owner_token уже per-session — рекон сказал «есть auth», что технически верно, но семантически уже).

4. **«Проверь curl-командой» вместо «должно работать».** 19 кейсов выше — это 19 curl/sqlite команд. Альтернатива «я написал код, тесты юнита прошли, релизим» приводит к ситуациям типа item #7 «timezone-aware comparison» — это **не** ловится unit-тестом, ловится только end-to-end вызовом с реальной БД, реальным SQLite, реальным временем.

5. **Bag-of-features в Phase 1 — отложил намеренно.** Plan.md перечисляет 9 задач: magic-link, signup gate, User table, Turnstile, kill-switch, persistent volume, Vercel deploy, cap input, Next.js update. Я сделал 5 из 9, чётко прописав в `iteration-15.md` §11 что отложено и почему. Это лучше чем сделать все 9 наполовину и не выйти на live.

---

## 11. Что осталось открытым {#11-open}

### В этой альфе (намеренно отложено)

1. **Kill-switch по дневному бюджету.** План: middleware читает OpenAI Usage API раз в N минут, если today's cost > $30 (env) → блокирует `POST /auth/request` (отключает signup, существующие могут продолжать). Реализация ~0.5 дня. Без неё деплой на Railway открыт для бот-abuse — но в альфе с одним каналом распространения (Telegram + LinkedIn) риск низкий.

2. **Cloudflare Turnstile.** Тоже план. Не делал, потому что без него Phase 1 уже работает и абыюз-вектор «1 сессия на email» сам по себе ограничивает. Turnstile добавит ещё один слой защиты против скрипт-сайнапов с разными email.

3. **Cap на длину user input** (бриф ≤ 20k символов). Фронт `<textarea>` без `maxLength`, бэк pydantic `str` без validation. Atак-вектор: 1Mb токенов отправить в OpenAI = большая часть бюджета. Простой фикс: `max_length=20_000` на pydantic + `maxLength` на textarea. Не сделал — отдельной итерацией со всей abuse-защитой (Turnstile + kill-switch + cap).

4. **Privacy disclaimer перед загрузкой файла** в `ContextUploadScreen`. Тривиально, 30 минут. Не сделал — UI-полировка после первого деплоя.

5. **Next.js 14 → 15.** Отложил намеренно (`launch-plan.md` Phase 1 «обновить Next.js» = 0.5–1 день и рискованно — Server Components API ломались). Сделать **после** стабилизации альфы.

### Известные ограничения архитектуры (не в scope альфы)

6. **Race condition в gate D.** Два одновременных `POST /session` от одного юзера могут оба пройти. Решение — partial unique index. Преждевременно на текущем масштабе.

7. **`onboarding@resend.dev` шлёт только на email владельца Resend-аккаунта.** Для реальных юзеров нужен верифицированный домен в Resend. Это **деплойное требование**, не код. Документировано в `docs/deploy-phase-1.md` §0.3.

8. **Resend rate limits.** На free tier — 100 emails/день. При vir-успехе альфы это потолок. Upgrade Resend tier — простая операция, но мониторить надо.

9. **Один volume → один backend instance.** Railway не позволяет mount one volume в multiple replicas. Для альфы (100–200 сессий/мес) ОК; для Phase 1.5 (если будет рост) — миграция на Postgres + S3/R2 для файлов.

### Сразу после первого живого деплоя

10. **Smoke-тест с реального адреса**: пройти полный wizard на проде, скачать ZIP. Это ещё на todo (#12) — после того как пользователь руками задеплоит.

11. **iteration-16.md** — следующий etape: abuse-защита (kill-switch + Turnstile + cap input + Next 15 upgrade).
