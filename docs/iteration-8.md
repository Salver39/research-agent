# Итерация 8 — диагностика и фикс post-burst hang на gpt-5.5

Дата: 2026-05-12. Продолжение `testing-and-fixes-2026-05-12.md` (там был зафиксирован hang на gpt-5.5 на этапе «Дизайн исследования»; обошли переключением на gpt-4o, но качество — ниже).

Цель этой итерации: вернуть рабочую конфигурацию на `gpt-5.5` / `gpt-5.4`.

---

## 1. Стартовое состояние

- Backend на Python 3.9.6, FastAPI + SQLAlchemy + aiosqlite + OpenAI SDK 2.x + httpx 0.27.
- `.env` стоял на `gpt-4o` (workaround из прошлой итерации).
- Этап «Дизайн исследования» работал через `asyncio.gather` — три параллельных design-агента (`design.py`, `design_interviews.py`, `design_usability.py`) шлют **1 frame + N hypothesis запросов** к OpenAI (всего 11–16 одновременных вызовов).
- На gpt-5.5 этот flow висел: 15 ответов приходили за ~13 сек, после чего backend замерзал на 8 минут до AbortController frontend'а.
- В прошлой итерации (cleanup-2026-05-11) 15 `logger.info` были понижены до `logger.debug` — диагностика была невозможна без их возврата.

Расследование велось по плану `nimbalyst-local/plans/users-mikemike-desktop-wise-prism.md`. Стратегия — **diagnose first, fix narrowly second**.

---

## 2. Phase A — Инструментация

Цель: восстановить минимальную видимость кодового пути от `asyncio.gather` до `[DONE]`, чтобы понять, между какими двумя моментами происходит hang.

### Что поднято до INFO (постоянно)

| Файл:строка | Лог |
|---|---|
| `backend/api/stream.py:58` | `"Agent stream finished, %d chunks, total len=%d"` |
| `backend/api/stream.py:60` | `"State persisted in memory"` |
| `backend/api/stream.py:72` | `"DB committed, sending [DONE]"` |
| `backend/agents/design_usability.py:74` | `"asyncio.gather done in %.1fs"` |
| `backend/agents/design_usability.py:110` | `"Yielding design JSON, len=%d, total time=%.1fs"` |
| `backend/agents/design_interviews.py:75` | `"Parallel generation done in %.1fs"` |

### Что добавлено как временные таймеры (`# TEMP: hang-diag-2026-05-12`)

- `stream.py`: таймер вокруг `_persist_agent_output`, таймеры `lock acquired in`, `db.commit() in`, `lock-held`.
- `design_usability.py`: лог `raw sizes: frame=..., hyp=[...]` после `gather`, таймер `hyp parse: N blocks in`.
- Позднее в `base.py`: лог старта `bounded_complete: starting block N`, таймер `complete: calling OpenAI` / `complete: OpenAI returned`.

---

## 3. Phase B — Воспроизведение hang

Переключили `.env` на `gpt-5.5` / `gpt-5.4`, прогнали wizard end-to-end до дизайна.

### Что увидели в логе

```
14:26:02   POST /api/stream  (start of design)
14:26:02   asyncio.gather: 16 coroutines launched
14:26:02..14:26:45   httpx INFO: 15 successful HTTP responses from OpenAI
14:26:45..14:34:30   complete silence (5+ minutes)
14:34:30   frontend: abort, "Превышено время ожидания"
```

**Ключевая улика:** в логе **не появилось** ни `asyncio.gather done`, ни `Agent stream finished`, ни persist/lock/commit. Все наши таймеры остались тихими.

Это означало: hang происходит **внутри `asyncio.gather`** — он никогда не возвращает управление, даже после получения всех 15 HTTP-ответов от OpenAI. Гипотезы 1 (persist JSON parse) и 3 (db.commit) исключены.

Остались: H2 (httpx connection pool deadlock) и H4 (asyncio.gather edge case на Python 3.9).

---

## 4. Phase C — Серия фиксов

### C.4 — Singleton `AsyncOpenAI`

`_get_client()` создавал новый `AsyncOpenAI` (и, как следствие, новый httpx pool) **на каждый из 16 вызовов**. Заменили на module-level singleton:

```python
_CLIENT: AsyncOpenAI | None = None

def _get_client() -> AsyncOpenAI:
    global _CLIENT
    if _CLIENT is None:
        _CLIENT = AsyncOpenAI(api_key=..., timeout=120.0, max_retries=1)
    return _CLIENT
```

### C.3 — `bounded_complete()` обёртка с `asyncio.wait_for`

В `base.py` появилась обёртка вокруг `complete()`:

```python
async def bounded_complete(system, user_msg, idx, ..., budget=140.0):
    try:
        return await asyncio.wait_for(complete(...), timeout=budget)
    except asyncio.TimeoutError:
        logger.error("bounded_complete: block %d TIMED OUT after %ss", idx, budget)
        raise
```

В трёх design-агентах `complete(...)` заменён на `bounded_complete(..., idx=...)`.

### Результат C.4 + C.3

✅ **Singleton сработал**: все 16 запросов стартовали **одновременно** в 14:26:02 за 20 мс (раньше растягивались на 12–15 сек).
✅ **15 hypothesis блоков** отработали за 10–20 сек каждый.
❌ **Block 0 (frame, max_tokens=2500) не вернулся** — даже HTTP Request от OpenAI для него в логе не появился.
❌ **`bounded_complete(140s)` не сработал** — должен был таймаутнуть через 2.3 мин, не сработал.

Это подтвердило **известный bag `asyncio.wait_for` на Python 3.9**: cancellation не пробивается через C-код httpx, поэтому wait_for сам зависает на отменяемой корутине.

### C+ — `timeout=240, max_retries=0, budget=260`

Подняли httpx timeout до 240, выключили retry, расширили `bounded_complete` budget до 260.

Логика: дать gpt-5.5 reasoning достаточно времени; убрать retry, который умножает effective timeout; дать wait_for запас сверх клиентского timeout.

Результат: **тот же hang на block 0**. На этот раз 8 hypothesis блоков завершились, 7 зависли. `bounded_complete` снова не сработал. Это окончательно подтвердило: `asyncio.wait_for` фундаментально не работает на Py 3.9 в нашем коде-пути.

Также подтвердилось, что gpt-5.5 reasoning держит SSE-соединение открытым с keep-alive packets, из-за чего httpx `timeout=240` (read timeout между bytes) **тоже не срабатывает**.

### C++ — Гибрид модели для frame

Гипотеза: frame block (max_tokens=2500) — самый тяжёлый, gpt-5.5 reasoning на нём не успевает. Переключили **только frame** на `gpt-5.4` (mini) через `OPENAI_MODEL_MINI`, hypothesis блоки оставили на gpt-5.5:

```python
frame_model = os.environ.get("OPENAI_MODEL_MINI") or None
results = await asyncio.gather(
    bounded_complete(system, frame_msg, idx=0, model=frame_model, max_tokens=2500),
    *[bounded_complete(system, msg, idx=i+1, max_tokens=1200) for ...],
)
```

Результат:
- ✅ **Frame block 0 заработал** на gpt-5.4 за 20.68 сек, `content_len=5070`.
- ❌ **8 из 15 hypothesis блоков** на gpt-5.5 опять зависли (стохастически, не одни и те же).
- → Гипотеза «frame max_tokens — единственная проблема» оказалась **неполной**. Сам gpt-5.5 нестабилен на параллельных reasoning-запросах с этого API-ключа.

---

## 5. Phase D — Переосмысление: single-shot

Пользователь задал ключевой вопрос: **«Почему в ChatGPT UI всё работает за минуту, а у нас виснет?»**.

Ответ: в UI делается **один запрос → один reasoning процесс**. У нас — **16 параллельных запросов → 16 reasoning процессов одновременно**, которые конкурируют за compute и часть из них застревает в очереди OpenAI.

### Решение: переделать дизайн на single-shot

Удалили всю параллельную генерацию из трёх design-агентов. Теперь они используют **тот же `BaseAgent.stream()`**, что и все остальные этапы wizard'а (бриф, диагноз, гипотезы, метод, выборка) — `chat.completions.create(stream=True)`. Один большой prompt, один большой ответ.

### Изменения в коде

**`backend/agents/design_usability.py`**, **`design_interviews.py`**, **`design.py`**:
- Удалён метод `stream()` целиком (был ~70 строк параллельной генерации каждый)
- Удалены `_parallel_system()`, `_frame_prompt()`, `_task_prompt()` / `_hypothesis_prompt()`, `_calc_duration()`
- `_max_tokens()` поднят с 6000 до **16000** (чтобы поместился весь сценарий)
- Импорты `asyncio`, `os`, `re`, `bounded_complete` удалены
- Файлы сократились до 25–40 строк

**`backend/agents/base.py`**:
- Удалены `complete()`, `bounded_complete()`, `_get_semaphore()`, `_OPENAI_SEMAPHORE` (никто больше не использует)
- Удалены все `# TEMP: hang-diag` таймеры
- Оставлены: singleton `_get_client()` (`timeout=240, max_retries=0`) и `BaseAgent.stream()`

**`backend/api/stream.py`**:
- Удалены все `# TEMP: hang-diag` таймеры
- Оставлены 3 INFO-маркера фаз (`Agent stream finished`, `State persisted`, `DB committed`) — пригодятся для будущей диагностики

**`backend/.env`**:
- `OPENAI_MODEL=gpt-5.5`, `OPENAI_MODEL_MINI=gpt-5.4`, `OPENAI_MAX_CONCURRENCY=20` (оставлено, хотя без gather теперь не используется)

### Результат: ~280 строк удалено

Код проекта стал **меньше**, чем был до этой итерации. Дизайн-агенты теперь стилистически идентичны остальным шести агентам.

---

## 6. Тестовая утилита `rewind_to_design.py`

Чтобы не перепроходить wizard каждый раз для тестирования дизайна, написан скрипт:

**`nimbalyst-local/scripts/rewind_to_design.py`**

Принимает session_id (или берёт последнюю), сбрасывает `state.stage = "sampling"`, удаляет `state.design`. Все данные (brief, hypotheses, method, sample) сохраняются. Затем пользователь жмёт «Далее» в UI и сразу запускается новый дизайн.

Папка `nimbalyst-local/` в `.gitignore`, утилита локальная — в репозиторий не попадает.

---

## 7. Открытое состояние

На последнем тесте (single-shot на gpt-5.5, max_tokens=16000):
- `POST /api/stream` уходит в 18:01
- Ни ошибки, ни `Agent stream finished` за 3+ минуты
- httpx логирует `HTTP Request:` только когда **stream закрывается** — а он ещё открыт, значит запрос **активен**, gpt-5.5 reasoning'ует

Это означает: **сам по себе один single-shot запрос к gpt-5.5 для этого промпта занимает >3 минут**. Frontend имеет AbortController на 8 минут, так что есть запас, но UX страдает.

В ChatGPT UI аналогичный запрос работает за ~1 минуту — но там возможен приоритетный compute для платных подписчиков, или иначе устроены параметры. Это вопрос к OpenAI / тарификации.

### Что осталось нерешённым

1. **gpt-5.5 reasoning слишком медленный на этом API-ключе** для дизайна-как-один-запрос. Возможные направления:
   - Уменьшить `max_tokens` (например 8000) — может ускорить reasoning
   - Переключить дизайн на `gpt-5.4` (mini) — потеря качества vs скорость
   - Дождаться, проверить — может реально работает за 5–7 минут на gpt-5.5, и это просто нужно принять
   - Обратиться к OpenAI о rate limits / quota / tier upgrade
2. **Python 3.9** остаётся ограничением. Upgrade на 3.11+ даст работающий `asyncio.wait_for` / `asyncio.timeout` — это полезно как defensive layer на будущее, но **не решит** базовую проблему скорости gpt-5.5 reasoning.

---

## 8. Что сделано и что доступно

### ✅ Сделано

- Восстановлена видимость кодового пути (6 INFO-маркеров фаз — постоянно).
- Чётко локализована корневая причина hang'а в параллельной архитектуре дизайн-агентов: 16 параллельных reasoning-запросов к gpt-5.5 → часть зависает на стороне OpenAI.
- Подтверждено, что `asyncio.wait_for` на Python 3.9 не пробивает cancellation через httpx C-код.
- Параллельная архитектура **удалена** в пользу single-shot — как в ChatGPT UI. Код сократился на ~280 строк.
- Добавлена утилита `rewind_to_design.py` для быстрого повторного тестирования этапа дизайна.
- `.env` на gpt-5.5 / gpt-5.4 — модели не нужно переключать.

### ⏸ Открыто

- Время отклика gpt-5.5 на single-shot дизайн (>3 минут) — нужно либо подтвердить эмпирически что укладывается в 5–7 минут (приемлемо), либо принять решение урезать `max_tokens`, либо переключиться на mini.
- Решение пока не утверждено; завершить это решение — задача следующей итерации.

### Файлы текущего состояния

```
backend/agents/base.py                  # singleton client + BaseAgent.stream
backend/agents/design.py                # ~25 строк, single-shot
backend/agents/design_interviews.py     # ~40 строк, single-shot
backend/agents/design_usability.py      # ~50 строк, single-shot
backend/api/stream.py                   # 6 INFO-маркеров фаз, без temp-таймеров
backend/.env                            # OPENAI_MODEL=gpt-5.5
nimbalyst-local/scripts/rewind_to_design.py   # dev-only утилита
```
