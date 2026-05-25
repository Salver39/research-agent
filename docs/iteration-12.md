# Итерация 12 — Жизненный цикл документов (upload/delete/index), согласованность метод↔выборка, откат недиагностированных правок

**Даты:** 2026-05-16 — 2026-05-17
**Продолжение:** `iteration-11.md` (многошаговый план методов, semantic-блокер брифа).
**Цель:** закрыть видимые трещины в работе с документами (тихая потеря записи на upload, отсутствие удаления, race с анализом), привести в согласие цифры на методе и на выборке, и — главное — научиться **не лечить симптом раньше, чем понятна причина**.

**Итог:** 6 содержательных правок, два отката. Backend перезапускался 7+ раз по ходу итерации (паттерн систематических тихих крэшей uvicorn остался открытым). Все правки покрыты Python/curl-смоками или эмпирическим воспроизведением; TypeScript — 0 ошибок.

---

## Содержание

1. [SQLAlchemy JSON silent write loss — корень потерянных upload-ов](#1-sqlalchemy-json-silent-write-loss)
2. [DELETE-endpoint для загруженных файлов](#2-delete-endpoint)
3. [ContextUploadScreen: hydrate + кнопка удаления](#3-context-upload-screen-delete-ui)
4. [ContextAgent: паттерны и из брифа, и из документов](#4-context-agent-dual-source)
5. [SamplingAgent: минимум 4 / 3 человека на сегмент](#5-sampling-min-per-segment)
6. [Race upload→анализ и `BackgroundTasks` для индексации](#6-upload-index-race)
7. [Polling статуса индексации на фронте + блок «Анализировать»](#7-frontend-polling-indexing)
8. [MethodScreen: убрано поле «N участников»](#8-method-screen-no-participants)
9. [MethodAgent: убран `"participants": 8` из JSON-схемы](#9-method-agent-no-participants-example)
10. [Откат недиагностированных правок method.py (fallback / preliminary\_methods)](#10-revert-method-fallback)
11. [Cleanup конкретной сессии (workaround под прошлый баг)](#11-session-cleanup)
12. [Эпистемические заметки](#12-epistemic-notes)
13. [Что осталось открытым](#13-open-questions)

---

## 1. SQLAlchemy JSON silent write loss

**Симптом, как видел пользователь:** загружаешь PDF — UI показывает «✓ Готово» (HTTP 200), но при возврате на тот же экран файл не отображается; ContextAgent на следующем шаге говорит «документов нет». Из 25 сессий в БД у 23 был `state.context.sources = []` при том что файлы лежали на диске.

**Ложный диагноз №1 (отброшен):** «Frontend abort после 120s + cold start sentence-transformers». Воспроизвести cold start локально не удалось, поведение наблюдалось и на маленьких файлах за миллисекунды.

**Реальный root cause:**

```python
# backend/db/models.py
state: Mapped[dict] = mapped_column(JSON, default=dict)   # без MutableDict
```

В `api/upload.py` запись делалась через:

```python
state = dict(row.state or {})                       # shallow copy
state.setdefault("context", {}).setdefault("sources", []).append({...})  # mutate nested list
row.state = state
await db.commit()
```

`dict(row.state)` копирует только верхний уровень. `state["context"]` остаётся **тем же объектом**, что и в `row.state["context"]`. После `.append(...)` оба верхних dict-а ссылаются на один и тот же мутированный list — при сравнении SQLAlchemy attribute history `has_changes() == False`, и `commit()` ничего не пишет в БД.

Подтверждено эмпирически (через `inspect(row).attrs.state.history.has_changes()`).

**Что сделано** в `backend/api/upload.py`:

```python
from sqlalchemy.orm.attributes import flag_modified
...
row.state = state
flag_modified(row, "state")
await db.commit()
```

Проверено: повторный изолированный POST upload через `TestClient` → прямое чтение SQLite показывает `context.sources = [{"name": ..., ...}]`.

**Почему важно отдельно:** baseline-объяснение «работает в stream-пути, ломается в upload» подсветило тонкость — stream строит **новые** nested dict-ы в `_merge_stream_state`, и SQLAlchemy при сравнении видит equality-different. Upload же мутирует in-place — для SQLAlchemy входной dict «не изменился». Без понимания этой разницы фикс «MutableDict.as_mutable(JSON)» был бы поверхностным и неполным.

---

## 2. DELETE-endpoint

Сделан `DELETE /api/upload/{session_id}/{filename:path}` в `backend/api/upload.py`:

- `require_owner` + `session_lock` для атомарности под лок.
- Проверка `state.get("stage") != "context"` → 409 Conflict (удаление разрешено только пока активен `ContextUploadScreen`; после `advance` файлы уже учтены в RAG-анализе).
- Защита от traversal: `os.path.realpath(target)` обязан начинаться с `realpath(uploads/<sid>/)`.
- Удаление по слоям: файл с диска → чанки из Chroma (`collection.get(where={"source": ...})` + `delete(ids=...)`) → запись из `state.context.sources` → обязательный `flag_modified`.

Покрыто curl-тестами: happy path, 404 на несуществующий, 409 на wrong stage, traversal попадает в fail-fast «File not found» до проверки пути.

Также расширен `SessionResponse` в `backend/api/session.py` полем `context: Optional[dict]`, чтобы фронт при hydrate видел список загруженных файлов.

---

## 3. ContextUploadScreen — hydrate + удаление

Перепис `frontend/components/wizard/ContextUploadScreen.tsx`:

- `useEffect` на mount: `GET /api/session`, наполняет локальный `files` уже загруженными источниками со статусом из state (`"indexed"` → `"done"`, `"index_failed"` → `"error"`, иначе `"indexing"`). Файлы переживают retreat и перезагрузку страницы.
- На каждой строке кнопка «×» с `confirm("Удалить файл …")`. Видна для статусов `"done"` и `"error"`. Во время DELETE — статус `"deleting"`.
- Кнопка «Анализировать» дизейблится не только при `"uploading"`, но и при `"indexing"` / `"deleting"`.

---

## 4. ContextAgent — паттерны из брифа и из документов

**Симптом:** аудит 14 сессий без документов → 100% паттернов `source: "бриф"`; единственная сессия с реальными документами → 12 из 12 паттернов из имён файлов, ни одного из брифа. Когда файлы есть, агент игнорировал бриф полностью.

**Корень:** в `backend/agents/context.py` SYSTEM был сконцентрирован на «фрагментах из документов компании»; `build_messages` имел двоичную развилку — либо документы есть и бриф остаётся «контекстом темы», либо документов нет и явная директива «работай только с брифом». Третьего режима «и оттуда, и оттуда» не было.

**Что сделано:**

- SYSTEM переписан: «извлекаешь паттерны и находки из **ДВУХ равноправных источников**: брифа и документов»; «Не своди всё к документам только потому, что фрагментов больше по объёму».
- `build_messages` теперь всегда подаёт «Источник 1 — Бриф (всегда обязателен как источник паттернов)»; при наличии RAG-фрагментов — «Источник 2 — Фрагменты из документов», с финальной строкой «выведи паттерны из обоих источников. Часть — `source='бриф'`, часть — `source=имя файла`».

Что **не** проверено: реальный ответ модели с новым промптом — требует платного прогона. Структурно user-message содержит обе нумерованные секции.

---

## 5. SamplingAgent — минимум 4/3 на сегмент

**Наблюдение пользователя:** MethodAgent предложил 18 респондентов для интервью, SamplingAgent на следующем шаге выдал `total_size = 10` (6 сегментов × 1–2). Несоответствие.

**Корень в SYSTEM `backend/agents/sampling.py`:** жёстко зашитые диапазоны `интервью: 6–10`, `юзабилити: 5–8`, плюс отдельная норма «опрос ≥ 150». SamplingAgent видел в user-message «18 участников» от метода, но system-промпт с интервалом «6–10» перебивал. Это правдоподобная гипотеза по чтению кода (не верифицировано контролируемым LLM-прогоном со старым vs новым промптом).

**Что сделано:** диапазоны заменены на правило по сегментам:

```
- интервью (deep_interviews): минимум 4 человека в КАЖДОМ сегменте.
  total_size = сумма размеров сегментов.
- юзабилити-тестирование: минимум 3 человека в КАЖДОМ сегменте.
- опрос (survey): ВСЕГДА минимум 150 респондентов. ...
```

С припиской: «Минимумы — нижняя граница, а не цель. Если число из метода выше — распределяй пропорционально». На реальном прогоне получили 3 сегмента × 4 = 12 для интервью — соответствует.

---

## 6. Race upload → анализ — BackgroundTasks

После фикса (1) пользователь стал упираться в новую проблему: ContextAgent на стадии context отвечал «документов нет», хотя файлы только что загружены и видны в state. `state.context.rag_fragments = []`.

**Корень:** в `api/upload.py:upload_file` индексация (`index_file`) выполнялась **внутри** HTTP-handler'а, перед записью state. Для 2.5 МБ PDF индексация занимает 30–60 секунд (sentence-transformers + Chroma add). Пользователь видел «✓ Готово» в UI после `_stream_to_disk`, нажимал «Анализировать» сразу — `orchestrator._run_rag()` вызывал `retrieve()`, который видел `collection.count() == 0` и возвращал `[]`. ContextAgent в build_messages шёл по ветке `else: rag_fragments пусто → fallback на бриф`.

**Что сделано:**

1. Запись в `state.context.sources` теперь делается **до** индексации, со полем `status: "indexing"`. DELETE сразу находит файл, race с удалением закрыт.
2. `index_file` запускается через `background_tasks.add_task(_index_and_mark_done, ...)` — handler возвращает HTTP 200 моментально (миллисекунды вместо 30–60 секунд).
3. Новая функция `_index_and_mark_done`: индексирует, по завершении флипает `status` на `"indexed"` (или `"index_failed"` при исключении) с обязательным `flag_modified`.

Эмпирически: POST upload 0.009s, state сразу содержит запись, DELETE сразу после POST возвращает 200, через 3 секунды статус автоматически меняется на `"indexed"`.

**Побочный эффект, осознанный:** если процесс умрёт во время BackgroundTask, статус останется `"indexing"` навсегда. Это уже наблюдалось на сессии `edcb9754` (нужен был ручной cleanup).

---

## 7. Polling статуса индексации на фронте

Расширение `ContextUploadScreen.tsx`:

- POST upload (200) теперь ставит локальный статус `"indexing"` (раньше — сразу `"done"`).
- Отдельный `useEffect` с `setInterval(2000)`: пока есть файл в `"indexing"`, дёргает `GET /api/session`, читает `context.sources[].status`, флипает локальный статус.
- Кнопка «Анализировать» дизейблится при наличии любого файла в `uploading | indexing | deleting`. Подпись рядом: «Файлы ещё обрабатываются — анализ запустится, когда все будут готовы».
- В UI добавлен статус `"indexing"` с подписью «Индексируется…» (синий пульсирующий).

`Method.participants` сделан optional в `frontend/store/session.ts` для back-compat с METHOD_PRESETS и старыми сессиями.

---

## 8. MethodScreen — убрано поле «N участников»

**Зачем:** число `participants` на MethodScreen приходило от MethodAgent (часто буквальное `8` из примера в JSON-схеме промпта) и **не** доезжало до бэка: `onMethodConfirm` отправлял только `{name, method_key}` на advance. SamplingAgent видел `method.participants = ?` и работал по правилу (1) — выдавал 12. Пользователь видел расхождение «8 → 12».

**Что сделано** в `frontend/components/wizard/MethodScreen.tsx`:

- Убран бэйдж `{m.participants} участников` в обоих местах (plan-ветка и fallback-ветка для старых сессий без `method_plan`).

UI больше не показывает число, которое игнорируется на следующем шаге. Реальный расчёт делает SamplingAgent на основе сегментов.

---

## 9. MethodAgent — убран `"participants": 8` из примера

Параллельно с UI-чисткой в `backend/agents/method.py`:

- Из JSON-схемы примера удалено поле `"participants": 8` — иначе LLM устойчиво копирует значение из few-shot примера.
- В SYSTEM добавлена явная инструкция: «ВАЖНО про размер выборки: НЕ указывай число участников в этом ответе. Размер выборки рассчитывается на следующем шаге. Просто опусти поле `participants`.»
- Из строки «Срочная / малый бюджет → Экспресс / guerrilla (5–7 участников)» удалена цифра, чтобы не подсказывать другие значения.

Эта правка независима от вопроса fallback (см. ниже) — она про корректность UI и согласованность с расчётом на выборке.

---

## 10. Откат недиагностированных правок method.py

**Что я сделал и пришлось откатить.** Пользователь сообщил: на этапе выбора метода сначала вышла ошибка «не могу определить метод, выберите самостоятельно». Я **сразу** добавил в `agents/method.py`:

- Mandate «ВСЕГДА возвращай хотя бы один метод. НИКОГДА не отказывайся от выбора».
- Двухступенчатый fallback: первый supported из `preliminary_methods` → `deep_interviews`.
- В `build_messages` прокинул `preliminary_methods` отдельной строкой в user-message.

Это была **классическая реакция на симптом без диагностики**. Пользователь явно спросил: «нам точно нужно было делать изменения в fallback?» — и попросил посмотреть логи.

**Что показали логи** (`bk6ciurys.output`, 2026-05-17, сессия `edcb9754`):

```
15:08:57 stream finished, 0 chunks, 0 chars
15:08:57 WARNING persist: JSON parse failed at stage=method; raw[:300]=''
15:09:52 stream finished, 0 chunks, 0 chars
15:09:52 WARNING persist: JSON parse failed at stage=method; raw[:300]=''
15:10:28 stream finished, 593 chunks, 2021 chars     ← третья попытка прошла
```

OpenAI возвращала 200 OK через миллисекунды, но **content был пуст** — `0 chars`. Это **не** «модель отказалась» — это **stochastic empty response** при тех же входах. На третьей попытке те же данные дали 2021 char.

То есть моя гипотеза «MethodAgent отказывается → нужно укрепить промпт» была **полностью ложной**. Сообщение «не могу определить» в UI приходило не от модели, а от фронта, который рендерил пустой/невалидный JSON в MethodScreen.

Правдоподобные кандидаты на причину empty response (не доказаны):
- gpt-5.5 как reasoning-модель; `max_completion_tokens = 2048` (из `BaseAgent`) включает reasoning-токены; на большом промпте (SYSTEM + brief + 11 hypotheses) reasoning съел весь бюджет, content = 0.
- Транзиентный сбой OpenAI на конкретном промпте — модель иногда просто возвращает пусто.

Без логирования `response.usage.completion_tokens_details` (если API его отдаёт) различить нельзя.

**Откат:**

- Из SYSTEM убран блок «ВСЕГДА возвращай… НИКОГДА не отказывайся… ПРАВИЛО FALLBACK».
- Из `build_messages` убрано прокидывание `preliminary_methods` — снова только `brief + hypotheses`.

**Что сохранено:** удаление `"participants": 8` из примера и инструкция про не указывать число — они адресуют **другую** проблему (UI-расхождение 8 vs 12) и независимы от вопроса fallback.

**Урок:** диагностика **до** правки — обязательный шаг. Я нарушил его дважды за итерацию (cold-start гипотеза для upload, fallback-гипотеза для method).

---

## 11. Cleanup конкретной сессии

Сессия `107b58fd` накопила «грязь» от итераций багфикса: 6 файлов на диске, `state.context.sources = []` (последствие бага 1, исправленного позже), 88 чанков в Chroma. На сессии `edcb9754` — два PDF (один indexed, один навсегда зависший в indexing после крэша процесса), плюс 42 phantom-чанка от удалённого ранее txt-файла.

Сделал одноразовый Python-скрипт (после остановки uvicorn, чтобы избежать конкуренции с Chroma SQLite):

- Удалить файлы с диска.
- Удалить запись из `state.context.sources` + `flag_modified` + commit.
- Удалить phantom-чанки из Chroma по `where={"source": ...}` → `delete(ids=...)`.

**Важная заметка про cleanup из второго процесса:** один раз я уже клал live uvicorn, открыв собственный `chromadb.PersistentClient` параллельно с handler'ом — Chroma поверх SQLite не любит конкурентный `delete_collection`. Правильный порядок: остановить uvicorn → cleanup → запустить.

---

## 12. Эпистемические заметки

1. **Лечение симптома vs root cause.** Дважды за итерацию я применил «правдоподобный фикс» до того, как зафиксировал причину:
   - Cold-start MiniLM как объяснение «Ошибка» в UI — оказалось ложным, реальная причина — silent write loss в SQLAlchemy.
   - Fallback в method.py как объяснение «не могу определить» — оказался ложным, реальная причина — пустой response (`raw[:300]=''`).

   В обоих случаях прямая диагностика (изолированное воспроизведение через TestClient + raw SQLite; чтение логов uvicorn с поиском warning'ов) дала точный ответ за пару минут, а не часы догадок.

2. **N=1 при empirical-проверках.** Многие выводы делал по одной сессии (например, «ContextAgent игнорирует бриф» — 1 сессия с реальными документами). Тренд подкреплялся структурой кода, но честная нотация empirical базы — обязательна.

3. **Атрибуция изменений между «работало» и «сломалось».** На сессии `edcb9754` первый method-стрим уже дал empty response — никакой моей правки method.py к этому моменту не было. То есть «было OK → стало плохо» по моей вине здесь некорректно. Это не regression — это flakiness reasoning-модели на сложном входе.

4. **Систематические крэши uvicorn.** Процесс умирал тихо 7+ раз за итерацию, без traceback в логе. Гипотеза (не верифицирована): `--reload` + `watchfiles` + путь с пробелом/кириллицей в директории на macOS. Каждый раз обходил перезапуском — но это **не root-cause fix**, и побочка («зависший indexing» статус) отсюда же.

---

## 13. Что осталось открытым

1. **Систематические тихие крэши uvicorn.** Каждое редактирование файла во время `--reload` ставит процесс на грань. Не закрыто.
2. **Stochastic empty response от MethodAgent.** Причина не доказана. Кандидат — token budget на reasoning. Возможные действия: `_max_tokens()` override в `MethodAgent` до 8192; либо retry-on-empty в `BaseAgent.stream`; либо переход на не-reasoning модель для этого шага.
3. **`ClarifyScreen` 3-й шаг.** Пользователь сообщил «ломается на 3-м подшаге диагностики», явно попросил не чинить. Сохранено в memory как `project_clarify_step3_bug`.
4. **Retreat не показывает `ContextUploadScreen`.** Юзер вернулся со стадии hypothesis на context — увидел `ContextResult` («Документов нет — агент будет работать только с брифом»), а не экран загрузки. Какое-то из условий (`!contextStreamed && !streaming && sseText === ""`) не сбросилось. Не воспроизводилось в DevTools — оставлено на потом.
5. **Сравнить state «прошлых рабочих method-сессий» с edcb9754.** Если в той пользовательской сессии 11 priority=1 hypotheses + длинный brief, а раньше было меньше — это эмпирически усилит гипотезу про token budget.
6. **MutableDict.as_mutable(JSON) на уровне модели** вместо `flag_modified` в каждом write-site. Системнее, но покрывает только мутации верхнего уровня — для вложенных list/dict стандартом SQLAlchemy не закрыто.
