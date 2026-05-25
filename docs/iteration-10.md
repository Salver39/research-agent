# Итерация 10 — Survey-агент end-to-end: от заглушки до работающего опроса

**Дата:** 2026-05-15
**Продолжение:** `iteration-9.md` (там устранён hang design-этапа на gpt-5.5).
**Цель:** реализовать DesignSurveyAgent (был TODO-заглушкой) и довести опрос до рабочего состояния через wizard.

**Итог:** survey-агент работает end-to-end: 12 гипотез → сегментирован brief → survey-JSON (meta, screener, warmup, main_blocks, open_questions, demographics, closing, routing) → отрендерен на frontend → сохранён в `state.design`. По пути устранены 7 багов разной природы, из них 2 — нетривиальные буферизационные слои в SSE.

---

## Содержание

1. [Создание survey-агента (промпт + класс)](#1-создание-survey-агента)
2. [Smoke-тест агента в изоляции](#2-smoke-тест-в-изоляции)
3. [Интеграция в frontend и docx](#3-интеграция-в-frontend-и-docx)
4. [Bug A — фильтр персиста не пропускал survey-shape](#4-bug-a--фильтр-персиста)
5. [Bug B — абсолютный SSE-таймаут на frontend короткий для reasoning](#5-bug-b--абсолютный-таймаут)
6. [Bug D — зеркальный фильтр на frontend (setDesign)](#6-bug-d--зеркальный-фильтр)
7. [Bug E — Next.js dev rewrites буферизуют SSE целиком](#7-bug-e--nextjs-dev-proxy)
8. [Bug F — Chrome fetch reader буферизует мелкие SSE-чанки](#8-bug-f--chrome-fetch-reader)
9. [Bug G — рендер падает на routing-rule без if_answer_in](#9-bug-g--routing-render)
10. [Heartbeat-плюмбинг на backend](#10-heartbeat-плюмбинг)
11. [Эпистемические уроки](#11-эпистемические-уроки)
12. [Что осталось открытым](#12-что-осталось-открытым)

---

## 1. Создание survey-агента

В `backend/agents/design_survey.py` была заглушка `SYSTEM = "# TODO"` с `max_tokens = 6000`, без diagnosis-блока. Orchestrator уже маршрутизировал `method_key == "survey"` на этот класс (`orchestrator.py:118`), но генерация падала на пустом промпте.

Сделано:

- **`backend/prompts/design_survey.py`** — system prompt ~11.5K символов по `survey_guide.md`. Структура:
  1. Главный принцип (минимум вопросов, каждый привязан к гипотезе)
  2. Цель/задачи исследования (использует `diagnosis.research_goal/tasks` verbatim)
  3. Структура анкеты: `screener → warmup → main_blocks → open_questions → demographics → closing` (строгий порядок)
  4. Покрытие гипотез (`hypothesis_ids`, `hypothesis_text`)
  5. Что измеряем: `measurement_type` ∈ behavior / frequency / importance / satisfaction / intention / priority / barriers / awareness / segment / screener / context
  6. Типы вопросов: single/multi_choice, likert_5/7, ranking, numeric, open
  7. 8 запретов по формулировке (наводящие, двойные, гипотетика о будущем, сложный язык, двойное отрицание, без временного периода, «или» внутри)
  8. Правила скринера (не подсказывать) и шкал (симметрия, постоянство направления, подписи)
  9. Длина 7–12 мин, ≤ 30 вопросов, ≤ 2 открытых
  10. Skip logic + рандомизация
  11. Строгий JSON-schema в финале

- **`backend/agents/design_survey.py`** — больше не заглушка: тянет `diagnosis.research_goal` / `research_tasks` как `design_usability.py`/`design_interviews.py`, `max_tokens = 16000`.

Verbatim-цитирование цели и задач из диагноза — для согласованности всего пайплайна.

---

## 2. Smoke-тест в изоляции

Перед интеграцией — изолированный вызов через `.venv/bin/python` в standalone process с синтетическим стейтом (2 гипотезы про refund-rate косметики). Результат на gpt-5.5:

- 127 секунд, 16064 символов raw
- JSON распарсился чисто
- 11 структурных проверок зелёные: top-level keys, покрытие гипотез, отсутствие h3 (priority=2), measurement_type/required у всех вопросов, симметрия шкал, qualifying_answers у скринера, ≤2 открытых, demographics в конце

Качественные замечания (некритичные):
- `numeric`-вопрос без `unit/min/max` (нарушение явного требования промпта)
- routing использовал `if_answer_not_contains` (не было в нашей схеме, только `if_answer_in`) — позже это аукнется в bug G
- Третий main_block без `hypothesis_ids` — серая зона по правилу «нет привязки — режь»

Этот smoke-тест дал важную точку отсчёта: **в изоляции агент работает за ~2 минуты, JSON валидный.**

---

## 3. Интеграция в frontend и docx

Согласившись с пользователем сделать полный e2e, добавил три недостающих звена:

**`frontend/store/session.ts`** — типы `SurveyQuestion`, `SurveyBlock`, `SurveyScreener`, `SurveyWarmup`, `SurveyRoutingRule`, `DesignMeta`/`DesignIntro`/`DesignClosing` как union-совместимые опциональные структуры (не отдельные ветки), чтобы рендер интервью/usability не сломался.

**`frontend/components/wizard/DesignScreen.tsx`** — третья ветка рендера `design.main_blocks`. Хелперы `SurveySection` / `SurveyQuestionCard` отображают каждый вопрос с meta-строкой (тип · измерение · период · гипотезы), options, шкалы с подписями, qualifying для скринера, маршрутизация. Расширил `LABELS` для всех survey quality_checks.

**`backend/documents/generator.py`** — функция `_render_survey` (новый блок перед `guide_blocks`), которая укладывает ту же структуру в .docx через `_render_survey_question` хелпер.

Все три изменения проверены: `tsc --noEmit` чисто, docx-генератор отрабатывает на survey-стейте (37 KB), регрессия usability и interview docx — оба генерируются без ошибок.

---

## 4. Bug A — фильтр персиста

Первый прогон через UI: дизайн «генерировался» 8 минут, потом ошибка. На бэке не было httpx-лога. Я предположил три параллельные причины (timeout, hang, прокси), запросил у пользователя контекст бэк-лога.

При чтении кода нашёл **главную мою ошибку при подключении агента**:

`backend/api/stream.py:188` — `_persist_agent_output` для design-этапа сохраняет `state["design"] = data` ТОЛЬКО если в JSON есть `guide_blocks` ИЛИ `tasks` ИЛИ `pre_interview`. Survey-агент возвращает `main_blocks` — фильтр **молча** не срабатывал, design не сохранялся в БД, даже если стрим прошёл успешно.

**Fix:**
```python
elif stage == "design" and ("guide_blocks" in data or "tasks" in data or "pre_interview" in data or "main_blocks" in data):
    state["design"] = data
```

Юнит-тестировал на 4 кейсах: survey ✓, регрессия usability ✓, регрессия interview ✓, неизвестный shape игнорируется ✓.

---

## 5. Bug B — абсолютный таймаут

Frontend `useSSE.ts:19` — `setTimeout(ctrl.abort, 240_000)` — абсолютный 240-секундный таймер с момента запроса. На простых запросах хватало, но для survey-дизайна на 12 гипотезах с reasoning-моделью gpt-5.5 — мало.

**Первый фикс (избыточный):** заменил на `idleTimeoutMs = 90_000` — сбрасывается на каждом байте.
**Сопутствующий эффект:** окно до первого байта сузилось с 240с до 90с. На больших промптах reasoning > 90с, idle-таймер срабатывает ДО первого чанка.

**Второй фикс (двойной таймер):** firstByteMs = 480s + idleMs = 90s. После первого байта переключается на быстрый idle.

**Третий фикс (правильный):** после того как добавил heartbeat на backend (см. п. 10), вернул к одному параметру `idleMs = 60_000` — heartbeat каждые 20с не даёт срабатывать idle. Это архитектурно чище.

Также: backend `agents/base.py:39` `AsyncOpenAI(timeout=240.0)` → `timeout=600.0`. На длинных промптах openai-клиент сам не убьёт legitimate долгий reasoning.

---

## 6. Bug D — зеркальный фильтр

В тот же класс, что Bug A: `frontend/app/session/[id]/page.tsx:102` (`onDone` колбэк):

```ts
} else if (d.guide_blocks || d.tasks || d.pre_interview) {
  s.setDesign(d);
}
```

Frontend-store не подхватывал survey-JSON из стрима. Даже если backend сохранил (после фикса А), store оставался без design до F5.

**Fix:** добавил `|| d.main_blocks` в это же условие.

**Урок:** когда добавляешь новый shape выхода агента, надо покрыть **все** фильтры по shape — на backend (persist) И на frontend (store update). Один из них пропустишь — будет «молчаливый» баг где данные есть в БД но не в UI.

---

## 7. Bug E — Next.js dev proxy

После всех фиксов — повторный прогон через UI. 8 минут ожидания, ошибка «Агент не отвечает». Опять без httpx-лога на бэке.

Сначала предположил долгий reasoning, потом отверг (нет httpx-лога), потом снова вернулся к этой гипотезе. Решил подтвердить эмпирически: написал smoke-test, который читает РЕАЛЬНОЕ состояние из БД и зовёт `DesignSurveyAgent.stream()` напрямую.

**Результат smoke-теста на прод-стейте (12 гипотез):**
- `first chunk at 114.8s` — reasoning gpt-5.5 на этом промпте занимает ~115 секунд
- Полное время: 196.5s, 29142 символа raw

Это **подтвердило**, что reasoning >90с — и значит обновлённый idle-таймер фронта срабатывает до первого чанка. Гипотеза снова актуальна.

Но при следующей попытке через UI — снова ошибка через 1.5 минуты («Агент не отвечает дольше минуты»). К этому моменту heartbeat уже был на бэке (см. п. 10), идея была: при reasoning >60с heartbeats keep alive.

Параллельная диагностика:
- **Direct curl на localhost:8000** → 65с, 14202 строки, успешный `[DONE]` ✓
- **Через Next.js proxy (`localhost:3000/api/backend/...`)** → **6 минут, 0 байт** ✗

Smoking gun. **Next.js dev rewrites не пропускают SSE.** Встроенный proxy держит response в памяти до закрытия upstream. Длинные стримы попадают в окно тайм-аута самого proxy и тихо обрываются. usability/interview работали через тот же proxy потому что их стрим короче 30 секунд — proxy успевал завершить целиком.

**Fix:** в `frontend/hooks/useSSE.ts` сделал URL зависимым от env:
```ts
const base = process.env.NEXT_PUBLIC_BACKEND_URL ?? "/api/backend";
const res = await fetch(`${base}/api/stream/${sessionId}`, ...);
```
В `frontend/.env.local` добавил `NEXT_PUBLIC_BACKEND_URL=http://localhost:8000`. Backend CORS уже разрешает `localhost:3000` (`main.py:_origins`).

Для prod (без env) — fallback на `/api/backend`, потому что Vercel/nginx нормально стримят SSE.

После перезапуска Next dev + hard refresh браузера — fetch стал идти на `localhost:8000`. Confirmed через DevTools Network: Request URL = `http://localhost:8000/api/stream/...`, CORS preflight 200 OK.

---

## 8. Bug F — Chrome fetch reader

После Bug E думал — всё, готово. Но снова ошибка через 1 минуту в браузере. DevTools показывал:
- Request URL = `http://localhost:8000/...` ✓ (bypass работает)
- Status: 200 OK
- Time: Pending → timeout
- Transferred: ~255 B (header'ы)

Параллельный curl напрямую: тоже долго, но heartbeats доставлялись.

**Эксперимент:** запустил curl на 35с, отслеживая размер выходного файла. Размер: 0 → 13 → 92 байт. **13 байт ровно = один heartbeat-комментарий `: keepalive\n\n`** (1+1+9+2 = 13). После 30с openai-чанки начали капать, размер вырос до 92.

Затем 90-секундный curl на медленном reasoning: 52 байта = ровно 4 heartbeat'а × 13. То есть **на curl heartbeat доставляется**.

В браузере же idle abort. Гипотеза: **Chrome fetch ReadableStream reader не выдаёт мелкие SSE-чанки в JS** во время reasoning-only фазы. Это не Nagle на TCP (curl получал бы тоже задержки), это уровень Chrome network → fetch → reader.

**Fix:** padded heartbeat до ~2KB:
```python
HEARTBEAT_LINE = ": keepalive " + (" " * 2048) + "\n\n"
```
2KB превышает порог буферизации Chrome → reader.read() резолвится → useSSE bumpIdleTimer сбрасывает таймер.

Стандартный приём для SSE-прокси, упомянутый в спецификации EventSource (рекомендация 2KB initial padding для IE compatibility) — сработал и для Chrome.

---

## 9. Bug G — routing render

После рестарта бэка с padded heartbeat — стрим прошёл успешно. Backend сохранил `state.design`. Frontend store обновился. UI начал рендерить survey…

Падает с TypeError:
```
Cannot read properties of undefined (reading 'join')
at DesignScreen.tsx:450
```

Строка:
```tsx
{r.if_answer_in.join(" / ")}
```

Модель в одном из routing-правил использовала `if_answer_not_contains` (как и в smoke-тесте ранее, я об этом писал тогда как замечание). Поле `if_answer_in` у этого правила — `undefined`, `.join()` падает.

**Fix (defensive):** `(r.if_answer_in ?? []).join(" / ")`. Если поля нет — рисуем пустой набор.

Альтернативное решение — расширить тип `SurveyRoutingRule` и в промпте запретить такую вариативность; пока оставил defensive guard, оба варианта валидны.

---

## 10. Heartbeat-плюмбинг

В `backend/api/stream.py` `event_generator` была простая `async for chunk in orchestrator.stream(...)`. Долгий reasoning = долгая тишина = клиентский idle. Решение — отдельная heartbeat-coroutine.

Архитектура через `asyncio.Queue`:
- **produce_chunks** — async-task, читает чанки из агента, кладёт в queue как `("data", chunk)`
- **heartbeat** — async-task, каждые 20с кладёт в queue `("ping", None)`
- **main loop** — `await queue.get()`, в зависимости от kind yield'ит `data: ...` или `HEARTBEAT_LINE`

В `finally` — `producer.cancel()` и `hb.cancel()`, чтобы при client disconnect задачи корректно останавливались.

Это **не временный костыль** — это правильная архитектура SSE с keep-alive под reasoning-модели. Любое будущее использование long-running агентов будет жить под этим heartbeat'ом.

---

## 11. Эпистемические уроки

Сегодня stop-hook самопроверки (4 вопроса в конце каждого ответа) реально работал — несколько раз ловил меня на:
- Наследовании непроверенных гипотез (например, я сначала выдал «proxy buffering» как факт, потом был вынужден переписать как «гипотеза, не подтверждена»)
- Сокрытии собственной регрессии — мой Bug B-фикс (240→90с) сократил окно до первого байта, и я об этом сначала не сказал, пока чек-лист не заставил
- Перескакивании к фиксу до диагностики (например, hypothesis о Nagle padding для heartbeat — я начал применять, потом откатился и сделал эмпирический тест размером файла, который дал чистый ответ «4 heartbeat'а × 13 байт ровно»)

**Главный паттерн:** **между «curl работает» и «browser работает» есть несколько слоёв (Next.js proxy, Chrome fetch reader), каждый со своими буферами.** Каждый слой надо проверять отдельно и эмпирически — иначе можно неделями менять таймауты в одном файле, пока корень в другом.

Серия багов A → D → E → F иллюстрирует это: с каждым исправлением я двигался ещё на один слой ближе к браузеру. Никакой один фикс не давал зелёного. Только все вместе + диагностика «что изменилось между точками A и B».

---

## 12. Что осталось открытым

- **Длина анкеты при 12 гипотезах** заведомо >12 минут — это нарушает методичку, но пользователь явно принял этот компромисс на этом прогоне. В будущем стоит либо ограничить выбор до 5–6 в UI, либо расширить промпт инструкцией «не более 3 вопросов на гипотезу».
- **Routing schema variation** — модель иногда использует `if_answer_not_contains` вместо `if_answer_in`. Пока висит defensive guard на фронте; правильнее расширить промпт явной нотацией, какие поля допустимы.
- **`numeric`-вопросы без `unit/min/max`** — в smoke-тесте модель проигнорировала явное требование. На прод-прогоне не проверил. Возможно требует усиления в промпте.
- **Покрытие задач исследования** — третий main_block иногда уезжает в «общие барьеры» без `hypothesis_ids`. Серая зона, нужно решить методологически.
- **OpenAI variability** — reasoning на одном и том же промпте от 65 до 200+ секунд. Иногда (особенно днём) — стабильно >100с. Не зависит от нашего кода; принимаем как факт жизни.

---

*Конец итерации 10.*
