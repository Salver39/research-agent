# Итерация 3 — Research Preparation Agent

## Обзор

Итерация сосредоточена на трёх направлениях:
1. Расширение онбординга — добавлен бизнес-контекст до исследовательского вопроса
2. Массовый баг-фикс — устранены все блокеры флоу (кнопки, стейдж-переходы, пустые экраны)
3. Перестройка агента дизайна — специализация по методам исследования

---

## 1. Новый онбординг — 3-шаговый лендинг

**Файлы:** `frontend/app/page.tsx`, `backend/api/session.py`, `backend/agents/brief.py`

Лендинг превращён в 3-шаговую форму:
- Шаг 1 — **Бизнес цель**: какого результата хочет достичь команда
- Шаг 2 — **Бизнес контекст**: ситуация, из-за которой появилась задача *(подсказка: "Опишите ситуацию в продукте или бизнесе, из-за которой появилась задача")*
- Шаг 3 — **Что хотим исследовать**: текущее поле `task`

`CreateSessionRequest` расширен полями `business_goal` и `business_context`. `BriefAgent` теперь включает их в контекст для всех стадий (`intake`, `diagnosis`, `brief`).

---

## 2. Баг-фиксы

### 2.1 Кнопка «Подтвердить понимание» не работала

**Файл:** `frontend/app/session/[id]/page.tsx`

**Причина A:** `onDiagnosisConfirm` читал данные из `diagnosticAnswersRef.current`, который сбрасывается при любом обновлении страницы.

**Фикс:** Убрали зависимость от `diagnosticAnswersRef` — теперь данные берутся напрямую из `store.diagnosis`, который расширяет `DiagnosticAnswers`.

**Причина B:** `onDone` callback проверял `diagnosticAnswersRef.current` как обязательное условие перед установкой диагноза в store.

**Фикс:** Убрали условие `&& diagnosticAnswersRef.current`. Добавили проверку `d.needed_for_quality` чтобы отличать диагноз от ответа контекстного агента (у которого тоже есть поле `summary`).

### 2.2 Advance endpoint падал с 500

**Файл:** `backend/api/stream.py`

**Причина:** `state.setdefault("method", {}).update(body.method_patch)` — ключ `"method"` существовал в стейте со значением `None`. `setdefault` возвращал `None`, и `None.update(...)` бросал `AttributeError`.

**Фикс:**
```python
if not isinstance(state.get("method"), dict):
    state["method"] = {}
state["method"].update(body.method_patch)
```

### 2.3 Неверные названия моделей OpenAI

**Файлы:** `backend/.env`, `backend/agents/base.py`

`gpt-5.5` и `gpt-5.4-mini` в `.env` были опечатками. Исправлено на актуальные модели. Дефолтный фолбэк в `base.py` также обновлён.

### 2.4 Модель оборачивала JSON в markdown

**Файлы:** `frontend/app/session/[id]/page.tsx`, `backend/api/stream.py`

Модель иногда возвращала ответ в виде:
```
```json
{ ... }
```
```
`JSON.parse` падал, диагноз не устанавливался, экран оставался пустым.

**Фикс (фронтенд):** Перед парсингом срезаем markdown-обёртку:
```typescript
const cleaned = full.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
```

**Фикс (бэкенд):** Функция `_clean_json()` в `stream.py` делает то же самое перед `json.loads`.

Также убран silent catch — ошибки парсинга теперь логируются в `console.error`.

### 2.5 Кнопка «Начать исследование» зависала

**Файл:** `frontend/app/page.tsx`

**Причина:** `loading = true` устанавливался при клике. Если пользователь нажимал «← Назад» пока запрос шёл, компонент не размонтировался, и `loading` оставался `true`. При возврате на шаг 3 кнопка была заблокирована навсегда.

**Фикс:** Кнопка «← Назад» на шаге 3 явно сбрасывает `loading(false)`. Добавлена проверка `if (!res.ok) throw new Error(...)` чтобы HTTP-ошибки корректно попадали в `catch`.

### 2.6 Пустой экран на этапе дизайна

**Причина:** `DesignUsabilityAgent` возвращал новый формат (`pre_interview`, `tasks`, `sus`, `closing`), но фронтенд и бэкенд ожидали старый формат с `guide_blocks`.

**Фикс:**
- `store.ts` — `Design` расширен опциональными полями нового формата
- `onDone` — детектирует `d.tasks || d.pre_interview` как дизайн
- `stream.py` — `_persist_agent_output` сохраняет оба формата
- `DesignScreen` — рендерит оба формата: usability (задания, SUS, follow-up) и классический (guide_blocks)

### 2.7 Зависание на этапе выборки

**Файлы:** `frontend/hooks/useSSE.ts`, `frontend/components/wizard/SamplingScreen.tsx`

**Причина:** OpenAI иногда молча перестаёт слать токены mid-stream, не закрывая соединение. Фронтенд ждал `[DONE]` бесконечно.

**Фикс:** Таймаут 2 минуты через `AbortController`:
```typescript
const timeout = setTimeout(() => ctrl.abort(), 120_000);
```
При таймауте показывается понятное сообщение и кнопка **«Попробовать ещё раз»** вместо вечного спиннера.

### 2.8 TypeScript-ошибки в store

**Файл:** `frontend/store/session.ts`

Исправлены типы: `setDiagnosis: (d: Diagnosis | null) => void`, `setSample: (s: Sample | null) => void`.

---

## 3. Перестройка агента дизайна

### 3.1 Специализированные агенты по методам

**Файлы:** `backend/agents/design_interviews.py`, `backend/agents/design_usability.py`, `backend/agents/design_survey.py`, `backend/orchestrator.py`

Вместо одного общего `DesignAgent` — роутинг по полю `method_key`:

```
method_key = "usability_testing"  →  DesignUsabilityAgent
method_key = "deep_interviews"    →  DesignAgent (fallback, промпт в разработке)
method_key = "survey"             →  DesignAgent (fallback, промпт в разработке)
иное                              →  DesignAgent (fallback)
```

### 3.2 method_key в MethodAgent

**Файл:** `backend/agents/method.py`

`MethodAgent` теперь возвращает стандартное поле `method_key` (английский ключ) в дополнение к `name` (русское название). Это убирает хрупкий поиск русских слов в строке.

Допустимые значения: `deep_interviews | usability_testing | survey | concept_test | ab_test | other`

### 3.3 Промпт DesignUsabilityAgent

**Файл:** `backend/agents/design_usability.py`

Написан полный промпт для юзабилити-тестирования. Ключевые правила:

**Обязательные условия:**
- Каждая гипотеза покрыта минимум одним заданием (через `hypothesis_ids`)
- Задание без гипотезы — допустимо (`hypothesis_ids: []`)

**Запрет гипотетических вопросов:**
- «Что бы вы изменили?» → «Приведите пример, как делали раньше / в другом сервисе»
- «Что могло бы привести к...?» → «В каких моментах вы были готовы закрыть? Почему?»

**Структура вывода:**
```json
{
  "pre_interview": { "goal": "...", "questions": [...] },
  "tasks": [
    {
      "title": "...",
      "scenario": "Представьте, что...",
      "task": "Пожалуйста, покажите...",
      "observe": "Фиксируем как...",
      "followup": [...],
      "success_criteria": "...",
      "hypothesis_ids": ["h1"]
    }
  ],
  "sus": { "scale": "...", "statements": [...] },
  "closing": { "questions": [...] },
  "total_duration": "60 мин",
  "quality_checks": { ... }
}
```

---

## 4. Правила для агентов (зафиксированы в промптах и памяти)

Добавлены в дизайн-агенты и сохранены в memory для будущих сессий:

1. **Гипотезы → задания:** каждая гипотеза из списка обязана быть покрыта хотя бы одним заданием/блоком/вопросом. Задание без гипотезы — допустимо.
2. **Без гипотетических вопросов:** вопросы только на основе реального прошлого опыта.
3. **SUS-шкала** в конце юзабилити-тестирования — обязательна.

---

## 5. Оптимизации

### Sampling Agent
- `max_tokens`: `4096 → 1500`
- Добавлена инструкция «Будь лаконичен» в промпт
- Все гипотезы по-прежнему передаются на вход (не ограничиваются)

### .gitignore
Создан `/.gitignore` в корне проекта. Под защитой: `.env`, `node_modules`, `.next`, `__pycache__`, `*.db`, `chroma_db/`, `outputs/`, `uploads/`.

---

## Текущее состояние агентов

| Агент | Статус промпта |
|---|---|
| BriefAgent (intake/diagnosis/brief) | ✅ Готов |
| ContextAgent | ✅ Готов |
| HypothesisAgent | ✅ Готов |
| MethodAgent | ✅ Готов (+ method_key) |
| SamplingAgent | ✅ Готов (оптимизирован) |
| DesignAgent (fallback) | ✅ Готов |
| DesignUsabilityAgent | ✅ Готов |
| DesignInterviewsAgent | 🚧 TODO |
| DesignSurveyAgent | 🚧 TODO |
