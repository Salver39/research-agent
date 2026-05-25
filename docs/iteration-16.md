# Итерация 16 — Phase 1 alpha: abuse-защита и стабилизация

**Дата:** 2026-05-25 (вечер того же дня, что и iteration-15)
**Продолжение:** `iteration-15.md` (Phase 1 alpha задеплоена и валидирована на 2 юзерах).
**Цель:** закрыть отложенные пункты §11 из `iteration-15.md`: cap input, privacy disclaimer, kill-switch, Turnstile + явный handler для `gpt-5.5-mini` model_not_found.

**Итог:** 3 коммита (`faaf9de`, `20657e0`, `b278e6b`). 5 функциональных доработок. Локально верифицировано: cap input (20k chars), kill-switch ($60 > $30 → 503), Turnstile (3 ветви — secret unset, missing token, fake token). На проде верифицирован Turnstile (`research-agent-navy-seven.vercel.app/login` — виджет загружается, токен валидируется). Single deploy-time stumble: preview-deployment Vercel имеет уникальный URL, не в списке Cloudflare Hostnames → Turnstile отказывает; основной prod URL работает.

---

## Содержание

1. [Cap длины input (20k)](#1-cap)
2. [Privacy disclaimer](#2-privacy)
3. [Validator: NotFoundError handler](#3-validator)
4. [Kill-switch по дневному бюджету](#4-killswitch)
5. [Cloudflare Turnstile](#5-turnstile)
6. [Эпистемические заметки](#6-epistemic)
7. [Что осталось открытым](#7-open)

---

## 1. Cap длины input (20k chars) {#1-cap}

**Куда:** `backend/api/session.py:CreateSessionRequest`, `backend/api/validate.py:ValidateClarityRequest`, `frontend/app/page.tsx` (три textarea).

Pydantic `Field(max_length=20_000)` блокирует на бэке (отдаёт 422). HTML `maxLength={MAX_INPUT_LEN}` блокирует ввод на фронте (браузер просто не позволяет печатать дальше). Обе защиты независимы — копипастер не обойдёт.

**Зачем 20k:** разумный потолок «нормальный продакт-бриф». Для реальных кейсов 1–5k символов. 20k — щедрый запас под детальный кейс, **но достаточно жёстко** чтобы скрипт не вставил `lorem ipsum × 1M` в надежде сжечь OpenAI.

---

## 2. Privacy disclaimer {#2-privacy}

`frontend/components/wizard/ContextUploadScreen.tsx`: жёлтая плашка над drop-zone:

- Файлы сохраняются на сервере, индексируются локально (Chroma).
- Кусочки релевантного текста уходят в OpenAI.
- Не загружай документы под NDA или с PII — ссылка на self-host для таких случаев.

Это **этическое** требование, не техническое. Юзер на проде не видит, что файлы уходят в OpenAI (мы это используем как RAG). Плашка делает это явным.

---

## 3. Validator: NotFoundError handler {#3-validator}

В `iteration-15.md` §11 я отметил silent failing-open в `agents/validator.py:99-101`. На проде с `OPENAI_MODEL_MINI=gpt-5.5-mini` (модель к которой у Railway-ключа нет доступа) валидатор молча падал и не блокировал юзера.

**Не убираю fail-open** — это **продуктовое решение**: если OpenAI временно лёг, юзер должен пройти дальше, а не упереться. Но **разделил два пути**:

```python
except openai.NotFoundError as e:
    # Misconfigured — visible as a single log line
    logger.error("validate_clarity: model %r not available — check OPENAI_MODEL_MINI env (%s)", model, e)
    return {"ok": True, "issues": {}}
except Exception:
    # Transient — full stack trace
    logger.exception("validate_clarity: LLM call failed, failing open")
    return {"ok": True, "issues": {}}
```

`NotFoundError` теперь даёт **читаемую однострочку** в логе, а не stack trace. Это конфигурация, а не сбой; админ должен увидеть «check OPENAI_MODEL_MINI env» и пойти исправить.

---

## 4. Kill-switch по дневному бюджету {#4-killswitch}

Главный элемент iteration-16. План: каждый OpenAI-вызов пишем в БД, перед signup суммируем за 24h, сравниваем с лимитом.

### Архитектура

| Файл | Что |
|---|---|
| `db/models.py` | +`UsageLog` (id, created_at indexed, model, prompt_tokens, completion_tokens) |
| `alembic/versions/0003_usage_log.py` | миграция, индекс на created_at |
| `db/usage.py` | новый модуль: `PRICING` dict, `estimate_cost_usd`, `log_usage`, `current_day_cost_usd`, `check_budget` |
| `agents/base.py` | вызов `log_usage` после streaming-response chunk.usage |
| `agents/validator.py` | вызов `log_usage` после non-streaming response |
| `api/auth.py:request_magic_link` | первый шаг — `await check_budget(db)` |
| `.env.example` | + `DAILY_BUDGET_USD=30` (default disabled, активируется задав значение) |

### Pricing

```python
PRICING = {
    "gpt-5.5":      {"input": 5.0, "output": 15.0},
    "gpt-5.5-mini": {"input": 0.5, "output": 1.5},
    "gpt-5.4":      {"input": 5.0, "output": 15.0},
    "gpt-5.4-mini": {"input": 0.5, "output": 1.5},
    "gpt-4o":       {"input": 5.0, "output": 15.0},
    "gpt-4o-mini":  {"input": 0.15, "output": 0.6},
    "default":      {"input": 10.0, "output": 30.0},  # conservative
}
```

`default` намеренно **over-estimate** — если на проде появится модель, которой нет в dict, kill-switch будет блокировать **раньше** консервативно, не **позже** мягко. Это правильная сторона ошибки для kill-switch.

### Что блокируется

`check_budget` стоит **только** в `POST /api/auth/request` (signup). Не в `POST /session`, не в `POST /advance`. Логика: пользователь, который уже залогинен и проходит wizard, **продолжает** до конца — он уже потратил часть бюджета, имеет право добежать. Новых юзеров не пускаем. Это минимизирует frustration legit-юзеров и максимизирует защиту от роботов, которые **именно** через signup-флоу пытаются масштабировать atak.

### Race в `log_usage`

`log_usage` использует свой собственный `SessionLocal()` (не `db` из роута). Это **сознательно** — он не должен ронять основной запрос, если БД временно лёгла. `try/except` ловит всё и continues. Усугубление: запись может быть лоsт. На текущем масштабе и при пути «kill-switch — over-budget threshold» это acceptable: запись потерялась = недооценка = пропустит больше signup'ов, но новые сами пополнят `usage_log` и быстро выровняют.

### Локальная верификация

| Сценарий | Ожидание | Факт |
|---|---|---|
| usage_log пустой, DAILY_BUDGET_USD=30 | check пропускается | 500 «Email sender» (т.е. дошло дальше) ✓ |
| usage_log = 4M output tokens на gpt-5.5 (=$60) | 503 budget_exceeded | 503 ✓, лог: `budget exceeded: cost=$60.00 >= limit=$30.00` |
| usage_log очищен | возврат к 500 | 500 ✓ |

---

## 5. Cloudflare Turnstile {#5-turnstile}

### Реализация

`frontend/app/login/page.tsx` — добавлен `@marsidev/react-turnstile`. Если `NEXT_PUBLIC_TURNSTILE_SITE_KEY` пуст → виджет не рендерится (для self-host / local dev). Если задан → виджет, submit-кнопка disabled пока нет `cf_token`. После 4xx ответа — `turnstileRef.current?.reset()`, юзер может повторить.

`backend/api/auth.py` — `_verify_turnstile(token)` POST'ит на `challenges.cloudflare.com/turnstile/v0/siteverify` с `secret` + `response`. No-op если `TURNSTILE_SECRET_KEY` пуст. Иначе:
- Нет token → 403 «Turnstile token missing».
- Token есть, Cloudflare отклоняет → 403 «Turnstile validation failed», в лог `invalid-input-secret` или другой error-code.
- Cloudflare 5xx → 502 «Turnstile verify upstream error».

`_verify_turnstile` вызывается **до** `check_budget` — порядок важен: при abuse-атаке кладём отказ как можно раньше, до любых обращений к БД.

### Локальная верификация (3 ветви)

```
TURNSTILE_SECRET_KEY unset                → 500 (email sender), turnstile no-op
TURNSTILE_SECRET_KEY set, no cf_token     → 403 "Turnstile token missing"
TURNSTILE_SECRET_KEY set, fake cf_token   → 403 "Turnstile validation failed"
                                            log: `invalid-input-secret`
```

### Прод-проблема: preview deployment

После push'а виджет на проде не загружался — Cloudflare error 110200. Console показывал:

```
Failed to execute 'postMessage' on 'DOMWindow':
The target origin provided ('https://challenges.cloudflare.com') does
not match the recipient window's origin
('https://research-agent-r1j9bi870-salver39s-projects.vercel.app').
```

URL в адресной строке — **preview deployment** Vercel (`research-agent-<hash>-salver39s-projects.vercel.app`), не основной `research-agent-navy-seven.vercel.app`. В Cloudflare Turnstile Hostnames был только `research-agent-navy-seven.vercel.app` (и старый apex `research-agent.app`), и preview-hostname не разрешён → Turnstile отказывает.

На основном prod URL виджет работает.

### Урок про preview-deployments

Vercel генерирует уникальный URL **на каждый push** (формат `<project>-<hash>-<team>.vercel.app`). Это значит:
- Site Key Turnstile с фиксированным hostname работает **только** для production-домена.
- Если хочется чтобы preview тоже работали — нужен `*.vercel.app` wildcard в Hostnames (но это пустит на твой Turnstile **любой** Vercel-сайт; не делал).
- Альтернатива: использовать **invisible mode** Turnstile + проверка референа. Не сделал — overkill для одного юзера.

Решение для альфы: тестировать на prod-URL, не на preview.

---

## 6. Эпистемические заметки {#6-epistemic}

1. **Conservative-by-default — правильное направление ошибки.** `PRICING["default"] = {"input": 10, "output": 30}` пишется так, чтобы новые модели сначала **переоценивались**, а не недооценивались. Когда модель появляется в Pricing dict с реальными ценами — over-charge снимается, но `default` ловит ситуацию когда «забыли обновить». Это **разница** между «ловит-bug» и «опрокидывается». Для kill-switch критично.

2. **`failing-open` ≠ silent failure.** В iteration-15 я отметил silent failing-open как «надо убрать». В iteration-16 я **не убрал** его, а **разделил** classes ошибок: `NotFoundError` (конфиг, видный в логах одной строкой) и общая `Exception` (transient, со stack trace). `failing-open` остался **продуктовое решение** (не блокировать юзера если OpenAI лёг). «Убрать silent» ≠ «убрать fail-open». Это разные характеристики.

3. **Preview deployment Vercel — class problem для security-features.** Любой security widget с whitelist-based hostname-проверкой (Turnstile, hCaptcha, OAuth, magic-link callbacks, Stripe checkout) сломается на preview-URL. Если в iteration-17 будут Stripe/OAuth/etc — заранее планировать domain strategy: либо production-only, либо wildcard, либо custom domains.

4. **`render_as_batch=True` (из iteration-15) спас snowball.** Миграция 0003 на SQLite потребовала только ADD COLUMN — без batch было бы OK. Но я не дублировал config — render_as_batch unconditional в `env.py`, так что для будущих ALTER миграций (drop column, rename, etc.) уже готово. **Стоимость декоратора = 0, защита = full**.

5. **Все 3 коммита один в один — не катастрофа, наоборот.** Я сделал commit после каждого блока (1-3, kill-switch, turnstile). Не один большой dump. Это даёт **rollback granularity** — если Turnstile сломал бы прод, я бы откатил `b278e6b`, оставил kill-switch (`20657e0`) и cap input (`faaf9de`). Чем мельче атомарный коммит, тем спокойнее эксперимент.

---

## 7. Что осталось открытым {#7-open}

### Env, которые юзер должен задать руками

| Где | Переменная | Значение |
|---|---|---|
| Railway | `DAILY_BUDGET_USD` | `30` (или другое) — иначе kill-switch no-op |
| Railway | `TURNSTILE_SECRET_KEY` | secret из Cloudflare dashboard |
| Railway | `OPENAI_MODEL_MINI` | работающая модель (например `gpt-5.4-mini` или `gpt-4o-mini`) |
| Vercel | `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | `0x4AAAAAADWNEpNgIRyGvJSg` для всех environments, **без build-cache** |

### Технический долг

1. **Pricing dict устаревает.** Цены OpenAI меняются. Через несколько месяцев `PRICING` может оказаться неверен. Решение: либо периодически обновлять руками, либо вытащить в `.env` (`OPENAI_PRICING_JSON`), либо вообще не считать cost — суммировать tokens и сравнивать с фиксированной квотой типа `MAX_DAILY_TOKENS`. На альфе оставил dict в коде.

2. **`usage_log` растёт без cleanup.** Без TTL/cron — таблица будет расти бесконечно. На 100–200 сессий/мес это медленно (~10–20 строк в сессию = 1k–4k строк/мес). Через год будет ~50k строк — индекс на `created_at` всё равно покрывает. **Acceptable**. Когда станет проблемой — добавить cron `DELETE WHERE created_at < now() - 30 days` (kill-switch смотрит только на last 24h, история не нужна).

3. **Race в `log_usage`.** Если два concurrent OpenAI-вызова finish'ятся одновременно, оба пытаются insert. SQLite + WAL обрабатывает это, но **может быть** stall на 100ms. На текущем масштабе не виден; на 10x — может появиться. Решение тогда: либо batch insert, либо message queue.

4. **Turnstile preview-deployments** — оставлено как known limitation. Production-only.

5. **Next.js 14 → 15** — всё ещё откладывается (рискованная задача без выигрыша для альфы).

### Что должно быть в iteration-17 (если будет)

- **Лендинг + переписать README под нетехническую аудиторию** (Phase 3 из `launch-plan.md`).
- **Custom domain на Vercel** — что-то типа `research-agent.app` напрямую (не Vercel-subdomain). Потребует обновления Cloudflare Turnstile Hostnames и Resend `RESEND_FROM`.
- **Postmortem `usage_log` после первой недели прода** — посмотреть реальную cost-per-session, скорректировать `DAILY_BUDGET_USD` если нужно.
