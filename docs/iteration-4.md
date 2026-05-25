# Итерация 4 — Лог изменений

## 1. Диагностика багов (раунд 1)

Проведена полная диагностика проекта. Найдено 10 проблем:

| # | Файл | Уровень |
| --- | --- | --- |
| 1 | `agents/base.py` — модель `gpt-5.5` (оказалась реальной, снята) | — |
| 2 | `orchestrator.py` — DesignInterviewsAgent и DesignSurveyAgent не используются | 🔴 |
| 3 | `rag/retriever.py` — Chroma падает если чанков меньше n_results | 🔴 |
| 4 | `api/stream.py` — переносы строк ломают SSE-протокол | 🟠 |
| 5 | `api/upload.py`, `rag/` — синхронный IO в async-эндпоинтах | 🟠 |
| 6 | `session/[id]/page.tsx` — stale closure в onBack() | 🟠 |
| 7 | `documents/generator.py` — каждый документ генерировался дважды | 🟠 |
| 8 | `db/models.py` — `datetime.utcnow` deprecated в Python 3.12+ | 🟡 |
| 9 | `hooks/useSSE.ts` — нестабильная ссылка на options | 🟡 |
| 10 | `README.md` — неверная инструкция по ключу API | 🟡 |

### Исправлено (баги #3–10)

**`rag/retriever.py`**
- Clamp `n_results` до реального размера коллекции — защита от ValueError
- Все вызовы Chroma вынесены в `asyncio.to_thread`

**`rag/indexer.py`**
- `_extract_text` и `collection.add` → `asyncio.to_thread`

**`api/upload.py`**
- `shutil.copyfileobj` заменён на `await file.read()` + `asyncio.to_thread`

**`api/stream.py`**
- Чанки JSON-кодируются (`json.dumps`) перед отправкой в SSE — защита от переносов строк

**`hooks/useSSE.ts`**
- Чанки декодируются через `JSON.parse` на клиенте
- `onDone` сохраняется в ref, убран `options` из deps `useCallback`

**`session/[id]/page.tsx`**
- `onBack()`: `store.stage` → `newStage` (исправлен stale closure)

**`documents/generator.py`**
- Каждый документ теперь строится один раз (`doc = fn(state)`), используется для docx и pdf

**`db/models.py`**
- `datetime.utcnow` → `datetime.now(timezone.utc)`

**`README.md`**
- Исправлена инструкция: `OPENAI_API_KEY` (для агентов), а не `ANTHROPIC_API_KEY`

---

## 2. Комментарии по юзабилити-тестированию

Обновлён `DesignUsabilityAgent` на основе 6 принципов:

1. **Гипотеза первой** — новое поле `hypothesis_text` в каждом задании, зелёный блок в UI
2. **SUS опциональный** — кнопка-тогл «Включена / Отключена» в `DesignScreen`
3. **От общего к частному** — первое задание обзорное (весь путь), следующие — детальные
4. **Нет вопросов с «или»** — явный запрет, разбивка на два вопроса
5. **Опора на прошлый опыт** — задания строятся вокруг того, что участник уже делал
6. **Легенда и задание подписаны** — отдельные метки «Легенда» и «Задание» в UI

**Изменённые файлы:** `agents/design_usability.py`, `store/session.ts`, `components/wizard/DesignScreen.tsx`

---

## 3. Агент по глубинным интервью

Создан полноценный `DesignInterviewsAgent` на основе документа-инструкции.

**Структура гайда:**
- Методологическая шапка (цель, задачи, ЦА)
- Вступление (7 обязательных элементов: представление, снятие тревожности, согласие на запись и др.)
- 5–7 блоков от общего к частному (разогрев → общий опыт → конкретный кейс → ожидания vs реальность → гипотезы → завершение)
- Зондирующие вопросы (`probes`) в каждом блоке
- Завершение с открытым вопросом «Что важное я не спросил?»

**Правила в промпте:** открытые вопросы, факт→причина, реальный опыт (не гипотетика), вопросы про эмоции/сомнения/альтернативы, запрет «или», ретроспектива ожиданий

**Исправлен баг оркестратора** — `deep_interviews` → `DesignInterviewsAgent`, `survey` → `DesignSurveyAgent`

**Новые типы** в `store/session.ts`: `InterviewMeta`, `InterviewIntro`, поле `probes` в `GuideBlock`

**UI** (`DesignScreen.tsx`): синяя методологическая шапка, раскрываемый блок вступления, зондирующие вопросы с отступом

**Документ** (`generator.py`): методологическая шапка, вступление и зондирующие вопросы в `_guide`

---

## 4. Цель и задачи исследования на этапе диагноза

`BriefAgent` (stage="diagnosis") теперь генерирует дополнительные поля:

```json
{
  "research_goal": "Цель одной фразой, начинается с глагола",
  "research_tasks": ["Задача 1", "Задача 2", ...]
}
```

**Отображение** в `ResearchDiagnosisScreen` — синий блок с целью и нумерованным списком задач, появляется над блоком «Ключевое решение»

**Привязка к дизайн-агентам** — `DesignInterviewsAgent` и `DesignUsabilityAgent` получают цель и задачи verbatim через `build_messages` и используют их вместо самостоятельной генерации

**Изменённые файлы:** `agents/brief.py`, `types/research.ts`, `components/wizard/ResearchDiagnosisScreen.tsx`, `agents/design_interviews.py`, `agents/design_usability.py`

---

## 5. Агент по гипотезам

Промпт переписан на основе инструкции по формированию гипотез.

**Ключевые правила:**
- Гипотеза — утверждение, не вопрос
- Алгоритм: наблюдение → причина → утверждение → проверка критериев
- Субъект + поведение/убеждение + контекст
- Опровержимость, проверяемость, привязка к решению
- Все типичные ошибки явно запрещены (трюизмы, решения вместо гипотез, вопросы)

**Новые поля в JSON:**
```json
{
  "source_type": "analytics | feedback | expert | past_research | benchmark",
  "verification_method": "Как проверим",
  "action_if_confirmed": "Что сделаем если подтвердится"
}
```

**Количество:** минимум 5, оптимально 10–15, без верхнего лимита

**Привязка к диагнозу** — агент получает `research_goal` и `research_tasks` из стейта

**UI** (`HypothesesScreen.tsx`):
- Иконки источников (📊 Аналитика, 💬 Обратная связь, 🧠 Экспертиза и др.)
- Метод проверки серым текстом
- «Если подтвердится» зелёным
- Подсказка в форме ручного добавления

**Документы** — `_briefing` и `_insights` обновлены под новые поля

**`HypothesisAgent._max_tokens`**** = 6000** (был 2048 — не хватало для 10+ гипотез)

---

## 6. Генерация дополнительных гипотез

Добавлена кнопка **«✦ Сгенерировать ещё гипотезы»** на экране гипотез.

**Механика:**
- Существующие гипотезы передаются в промпт с инструкцией «не повторять»
- Новые гипотезы **добавляются** к списку (не заменяют)
- `appendHypothesesRef` управляет режимом append в `onDone`
- `_persist_agent_output` принимает `user_input` и при `"append"` объединяет с существующими в БД

**Изменённые файлы:** `agents/hypothesis.py`, `api/stream.py`, `components/wizard/HypothesesScreen.tsx`, `app/session/[id]/page.tsx`

---

## 7. UX на экране гипотез

- Баннер hung-detection увеличен с **15 до 60 секунд**
- Текст баннера: «Агент формирует много гипотез — подождите ещё немного»
- Жёлтый баннер-предупреждение вверху: выбирать только гипотезы для исследования, не для аналитики
- Метка **«⚠ Можно проверить аналитикой - выбирать не рекомендуется»** на карточках с `source_type: "analytics"`
- Экран пустого состояния с кнопкой «Сгенерировать гипотезы →» вместо заблокированной кнопки «Далее»

---

## 8. Диагностика багов (раунд 2)

| # | Файл | Уровень |
| --- | --- | --- |
| 1 | `design_survey.py` — TODO промпт | 🔴 (не исправлен) |
| 2 | `stream.py` — append гипотез не сохранялся в БД | 🔴 |
| 3 | `page.tsx` — `onBriefConfirm` лишний advance | 🟠 |
| 4 | `MethodScreen.tsx` — override не менял `method_key` | 🟠 |
| 5 | `generator.py` — мёртвые импорты | 🟡 |
| 6 | `session.ts` — `appendStreamText` мёртвый метод | — (не проблема) |
| 7 | `generator.py` — хрупкий паттерн `runs[0]` | 🟡 |

### Исправлено (баги #2–5, #7)

**`api/stream.py`**
- `_persist_agent_output(state, raw, user_input)` — при `user_input == "append"` объединяет гипотезы вместо замены

**`app/session/[id]/page.tsx`**
- `onBriefConfirm`: убран лишний `advance` (был `brief → context → hypothesis`, стал `brief → context`)
- `onMethodConfirm`: передаёт `method_patch: { name, method_key }` в advance для синхронизации с бэкендом

**`components/wizard/MethodScreen.tsx`**
- `METHODS` теперь массив объектов `{ name, method_key }`
- `handleOverride` обновляет и `name`, и `method_key` в сторе

**`store/session.ts`**
- Добавлено поле `method_key: string` в интерфейс `Method`

**`documents/generator.py`**
- Удалены неиспользуемые импорты `Pt`, `RGBColor`, `WD_ALIGN_PARAGRAPH`
- Паттерн `runs[0].bold = True` → безопасный `add_run(...).bold = True` (3 места)

---

## 9. Таймаут дизайн-агента

**`hooks/useSSE.ts`**
- `stream(userInput, timeoutMs = 240_000)` — таймаут теперь параметр функции

**`app/session/[id]/page.tsx`**
- `onSamplingConfirm` и `onDesignRetry` вызывают `stream("build", 480_000)` — **8 минут** для дизайна

---

## Файлы изменённые в итерации

### Backend
- `agents/brief.py`
- `agents/context.py` (без изменений — проверен)
- `agents/hypothesis.py`
- `agents/design_usability.py`
- `agents/design_interviews.py`
- `agents/design_survey.py` (TODO промпт — не исправлен, запланирован)
- `orchestrator.py`
- `api/stream.py`
- `api/upload.py`
- `db/models.py`
- `documents/generator.py`
- `rag/retriever.py`
- `rag/indexer.py`

### Frontend
- `hooks/useSSE.ts`
- `store/session.ts`
- `types/research.ts`
- `app/page.tsx` (без изменений)
- `app/session/[id]/page.tsx`
- `components/wizard/DesignScreen.tsx`
- `components/wizard/HypothesesScreen.tsx`
- `components/wizard/MethodScreen.tsx`
- `components/wizard/ResearchDiagnosisScreen.tsx`

### Other
- `README.md`
