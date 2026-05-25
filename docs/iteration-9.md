# Итерация 9 — Корневая причина hang'а на design-этапе: AsyncOpenAI singleton

**Дата:** 2026-05-13
**Продолжение:** `iteration-8.md` (там single-shot переписан, но финальный тест всё равно завис на >3 минут; обошли gpt-4o, оставили вопрос открытым).
**Цель:** найти и устранить причину зависания production design-этапа на gpt-5.5.

**Итог:** причина найдена — module-level singleton `AsyncOpenAI` в `backend/agents/base.py`. Заменён на fresh client per call. Design теперь стабильно отрабатывает за 130 секунд.

---

## Содержание

1. [Стартовое состояние и установка контекста](#1-стартовое-состояние)
2. [Установка stop-hook самопроверки](#2-stop-hook-самопроверки)
3. [Анализ прошлых 8 итераций](#3-анализ-8-итераций--паттерн-ошибок)
4. [Диагностика gpt-5.5 — direct API tests](#4-диагностика-gpt-55--direct-api-tests)
5. [Обнаружение настоящего агента (DesignUsability vs DesignInterviews)](#5-обнаружение-настоящего-агента)
6. [Инструментация production-кода](#6-инструментация-production-кода)
7. [Воспроизведение hang'а с timing-логами](#7-воспроизведение-hanga)
8. [Локализация: singleton — корневая причина](#8-локализация-singleton)
9. [Финальный фикс и проверка](#9-финальный-фикс-и-проверка)
10. [Очистка и фиксация](#10-очистка-и-фиксация)
11. [Что осталось открытым](#11-что-осталось-открытым)

---

## 1. Стартовое состояние

В конце итерации 8:
- Архитектура design-агента переведена на single-shot streaming (как остальные 6 агентов).
- Параметры: `gpt-5.5`, `max_tokens=16000`, singleton `AsyncOpenAI` client с `timeout=240`, `max_retries=0`.
- Финальный тест: `POST /api/stream` уходит, через 3+ минуты в backend-логах не появляется ни `Agent stream finished`, ни ошибок. Frontend через 8 минут (`AbortController` 480_000 ms) показывает красный баннер «Превышено время ожидания».
- Гипотеза итерации 8: «gpt-5.5 reasoning слишком медленный на этом API-ключе» — оставлена непроверенной, проблема закрыта workaround'ом на gpt-4o с потерей качества.

---

## 2. Stop-hook самопроверки

Перед началом отладки настроена постоянная подкладка для будущих сессий — `~/.claude/hooks/self-check.sh` + `~/.claude/settings.json` с Stop-hook.

Hook впрыскивает 4-пунктный чек-лист как `system-reminder` после каждого содержательного ответа AI:

1. Гипотеза из доков / кода / предыдущей итерации — её финальный результат проверен, или просто наследована?
2. Лечу ли симптом, или задал вопрос «а почему он возникает»?
3. Поведение резко поменялось при смене параметра — переменная это, не код вокруг?
4. «Что изменилось между последним рабочим состоянием и сломанным?» — задан в первую очередь?

Это глобальная настройка, применяется во всех Claude Code проектах. Цель — не повторять паттерн итераций 4–8: лечение симптомов вместо корневой причины и наследование непроверенных гипотез.

---

## 3. Анализ 8 итераций — паттерн ошибок

Перечитаны все 8 предыдущих итераций. Выявлен повторяющийся паттерн:

**Каждая итерация принимала гипотезу предыдущей и строила на ней:**

| Итерация | Гипотеза | Действие |
|---|---|---|
| 4 | «медленно — нужен больший таймаут» | таймаут до 8 минут |
| 5 | «`[DONE]` теряется в SSE-буфере» | фикс useSSE |
| 6 | «параллельный gather → 1 streaming-вызов» | рекомендация, не сделано |
| 7 | «TPM rate limit, нужен семафор» | семафор + переключение на gpt-4o |
| 8 (нач.) | «httpx connection pool deadlock + asyncio.wait_for на Py 3.9» | singleton + bounded_complete |
| 8 (кон.) | «параллельность вообще, удалить gather» | single-shot |
| 8 (тест) | «gpt-5.5 просто медленный, вопрос к OpenAI» | проблема оставлена открытой |

Никто за 5 итераций не вернулся к вопросу: «что изменилось между последним рабочим состоянием (итерация 1, design работал) и сломанным (итерация 4+, design висит)?». Накапливалась сложность вместо движения к причине.

---

## 4. Диагностика gpt-5.5 — direct API tests

Чтобы развязать «модель vs обвязка», написан диагностический скрипт `nimbalyst-local/scripts/diag_design_ttft.py`. Вызывает OpenAI **напрямую**, минуя FastAPI / orchestrator / SSE / locks, c **реальным** state из БД (сессия `926025a5` — 15 гипотез, полный brief/method/sample).

### Первый прогон — 6 конфигов

| Прогон | Модель | max_tokens | TTFT | Total |
|---|---|---|---|---|
| prod-16k-1 | gpt-5.5 | 16000 | 65.3s | 97.5s |
| prod-16k-2 | gpt-5.5 | 16000 | 42.6s | 79.4s |
| prod-16k-3 | gpt-5.5 | 16000 | 31.9s | 68.5s |
| halved-8k | gpt-5.5 | 8000 | 51.7s | 86.4s |
| small-4k | gpt-5.5 | 4000 | 60.4s | 71.8s |
| mini-16k | **gpt-5.4** | 16000 | **1.5s** | **37.9s** |

**Выводы:**
- gpt-5.5 — reasoning-модель: TTFT 30–65 секунд (длинный «think» перед первым токеном).
- gpt-5.4 (mini) — обычная chat-модель: TTFT 1.5 секунды.
- Уменьшение `max_tokens` **не помогает** — reasoning не зависит от размера ответа.
- Direct API на gpt-5.5 **не виснет**: 3/3 успешны за <130 сек.

### Стресс-тест — 20 прогонов на production-конфиге

Скрипт `diag_design_stress.py`. Результат: 14 успешных, 6 ERROR из-за `insufficient_quota` (квота кончилась на 15-м прогоне). Из 14 успешных:

```
TTFT  (n=14):  min=14s  p50=49s  p90=83s  max=87s  mean=50s
Total (n=14):  min=58s  p50=84s  p90=117s max=128s mean=87s
0/14 HUNG
```

Direct API стабилен. Гипотеза «gpt-5.5 случайно зависает» — опровергнута 14-ю прогонами. Значит причина — в production-обвязке.

---

## 5. Обнаружение настоящего агента

Когда добавили инструментацию в backend и воспроизвели hang на сессии `926025a5`, в логах увидели:

```
[T-agent] DesignUsabilityAgent.stream entry
[T-agent] DesignUsabilityAgent calling OpenAI ...
```

**Не** DesignInterviewsAgent. Проверили `method_key` сессии — `"usability_testing"` → orchestrator маршрутизирует в `DesignUsabilityAgent`. Все предыдущие 14+3 прогона были на **DesignInterviewsAgent**'е, который к этой сессии отношения не имел.

Срочный re-test с правильным промптом (`prompts.design_usability.SYSTEM`, 6194 символа против 7304 у interviews):

```
usab-1: TTFT=42s, total=133s, OK (output 28k chars)
usab-2: TTFT=35s, total=135s, OK (output 32k chars)
usab-3: TTFT=42s, total=140s, OK (output 32k chars)
```

3/3 успешны. Usability промпт на gpt-5.5 в direct API работает идентично interviews. **Промпт не виноват.**

---

## 6. Инструментация production-кода

В `backend/api/stream.py` добавлены 7 timing-логов на границах фаз:
- `handler_entry`
- `snapshot_done`
- `first_chunk` (внутри `async for` итератора)
- `stream_finished`
- `persist_done`
- `db_committed`
- `done_yielded`

В `backend/agents/base.py` добавлены 4 лога вокруг OpenAI-вызова:
- `agent.stream entry`
- `calling OpenAI`
- `response object received` (сразу после `await create()`)
- `first content delta (TTFT)`
- `stream end`

Все логи помечены `# TEMP: bottleneck-diag 2026-05-13`. Цель — поймать **точное место**, где production теряет минуты.

---

## 7. Воспроизведение hang'а

Backend перезапущен, сессия `926025a5` откачена на sampling через `rewind_to_design.py`. Frontend нажал «Далее» → start design.

Backend-лог:

```
14:34:53,486  [T] handler_entry sid=926025a5 stage=design
14:34:53,486  [T] snapshot_done 0.00s
14:34:53,497  [T-agent] DesignUsabilityAgent.stream entry
14:34:53,518  [T-agent] DesignUsabilityAgent calling OpenAI model=gpt-5.5 max_tokens=16000
... (ровно тут логи закончились) ...
```

Через 8 минут frontend abort. Backend больше **ничего** не залогировал. Это означало: `await client.chat.completions.create(...)` **не возвращается**. Не возвращается response object, не появляется ни одного chunk.

И при этом в direct-тестах с **тем же** state, **тем же** SYSTEM, **той же** моделью — тот же вызов отвечает за <130 секунд.

Что отличается между production и direct? Прошлись по списку:
- ✗ Промпт — идентичен.
- ✗ State — идентичен (брался из той же БД).
- ✗ Модель и параметры — идентичны.
- ✗ Версия openai SDK — одна и та же venv.
- ✗ Python — одна и та же venv.
- ✓ **Singleton client.** В production base.py: `_CLIENT: AsyncOpenAI | None = None` на module-level, создаётся один раз и переиспользуется. В direct test — `AsyncOpenAI()` на каждый прогон.

---

## 8. Локализация: singleton

`_get_client()` в `backend/agents/base.py` возвращал module-level singleton. Этот паттерн был введён в **итерации 8** специально для экономии httpx connection pool, когда design-агенты делали 16 параллельных вызовов через `asyncio.gather`. В той же итерации параллельность была удалена в пользу single-shot, но singleton остался.

Гипотеза: singleton AsyncOpenAI (точнее, его внутренний httpx pool) в FastAPI/uvicorn event-loop context переходит в состояние, в котором `await chat.completions.create()` не получает управление и виснет навсегда. Точный механизм — не диагностирован (возможные кандидаты: pool reuse после длинной паузы, asyncio event loop binding mismatch, специфический баг httpx 0.27 / openai SDK 2.x при reuse).

---

## 9. Финальный фикс и проверка

Изменение `backend/agents/base.py`:

```python
def _get_client() -> AsyncOpenAI:
    # Fresh client per call — см. iter 9 / project_singleton_landmine memory.
    api_key = os.environ.get("OPENAI_API_KEY", "")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not set")
    return AsyncOpenAI(api_key=api_key, timeout=240.0, max_retries=0)
```

`_CLIENT` module-level переменная удалена.

Backend перезапущен, тот же тест:

```
T=0.00s    handler_entry
T=0.00s    snapshot_done
T=0.01s    DesignUsabilityAgent.stream entry
T=0.03s    calling OpenAI
T=26.33s   response object received  ← await create() вернулся
T=26.41s   first content delta (TTFT)
T=133.52s  stream end (7924 chunks)
T=133.53s  stream_finished (32210 chars)
T=133.58s  db_committed, [DONE]
T=133.58s  done_yielded (END)
```

**Полный design — 133 секунды.** Чёткое совпадение с direct-тестом. Singleton vs fresh — это и есть переменная, отвечающая за 8-минутный hang.

---

## 10. Очистка и фиксация

**`backend/agents/base.py`:**
- `_CLIENT` singleton удалён.
- `_get_client()` оставлен в виде fresh-per-call.
- Над функцией — 8-строчный комментарий с историей бага, цифрами (8 мин hang vs 133 сек OK), предупреждением «если кто-то предложит вернуть singleton — потребовать end-to-end тест на design-этапе перед мержем».
- Все `[T-agent]` TEMP-логи удалены.

**`backend/api/stream.py`:**
- `import time` удалён.
- 7 TEMP `[T]` логов удалены.
- Оставлены 3 INFO-маркера фаз (как в конце iter 8): `"Agent stream finished, N chunks, M chars"`, `"State persisted"`, `"DB committed, sending [DONE]"` — минимальная видимость пайплайна без шума.

**Auto-memory (`~/.claude/projects/.../memory/`):**
- Создан `project_singleton_landmine.md` (тип `project`): подробное описание мины, симптомы до/после, эмпирические цифры, признаки регрессии для будущих проверок.
- `MEMORY.md` обновлён, добавлена ссылка.

**Новые файлы в `nimbalyst-local/scripts/`:**
- `diag_design_ttft.py` — 6 прогонов на разных конфигурациях, инструмент изоляции «модель vs обвязка».
- `diag_design_stress.py` — N последовательных прогонов на production-конфиге, инструмент оценки стабильности direct API.

---

## 11. Что осталось открытым

1. **Глубинный механизм singleton-бага не диагностирован.** Сейчас зафиксирована корреляция (singleton ↔ hang, fresh ↔ работает) и practical fix. Если когда-нибудь появится мотивация вернуть singleton (например, для существенной экономии при многих параллельных вызовах) — нужно докопать до httpx-уровня. До тех пор fresh-per-call — корректное решение.

2. **`design_survey.py` — stub-промпт.** Висит из итерации 7, всё ещё не реализован. Либо реализовать, либо удалить ветку `method_key="survey"` из orchestrator + UI.

3. **Секреты в `backend/.env`.** Из итерации 7, открытый вопрос #1: реальные API-ключи в репозитории. Отозвать в дашбордах OpenAI/Anthropic, выпустить новые, не коммитить.

4. **Stop-hook самопроверки** (см. раздел 2) — глобальная установка, применяется во всех будущих проектах. Если станет шумным или сработает на коротком ответе из-за бага в length-счётчике, поправить порог в `~/.claude/hooks/self-check.sh`.

---

## Файлы текущего состояния

```
backend/agents/base.py                          # fresh client per call, без singleton
backend/api/stream.py                           # 3 INFO-маркера фаз, без TEMP
backend/.env                                    # OPENAI_MODEL=gpt-5.5, OPENAI_MODEL_MINI=gpt-5.4
nimbalyst-local/scripts/diag_design_ttft.py     # инструмент TTFT-измерений
nimbalyst-local/scripts/diag_design_stress.py   # стресс-тест direct API
nimbalyst-local/scripts/rewind_to_design.py     # rewind сессии для повторного теста (был в iter 8)
~/.claude/hooks/self-check.sh                   # глобальный Stop-hook (4-пунктный чек-лист)
~/.claude/settings.json                         # подключение hook'а
~/.claude/projects/.../memory/project_singleton_landmine.md  # project-memory о мине
```

---

## Связанные документы

- `docs/iteration-8.md` — переход на single-shot, нерешённый hang
- `docs/7-итерация.md` — переключение на gpt-4o как workaround
- `docs/testing-and-fixes-2026-05-12.md` — детальная история тестирования
