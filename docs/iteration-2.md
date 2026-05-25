# Итерация 2 — Research Preparation Agent

**Дата:** 7 мая 2026  
**Стек:** Next.js 14 + FastAPI + OpenAI SDK + Chroma + SQLite

---

## Обзор проекта

Перед началом работы был проведён полный аудит проекта. Структура:

```
├── frontend/          Next.js 14, App Router, Zustand, Tailwind
│   ├── app/
│   │   ├── page.tsx                  — Стартовый экран
│   │   └── session/[id]/page.tsx     — Wizard
│   ├── components/wizard/            — Экраны по этапам
│   ├── hooks/useSSE.ts               — SSE стриминг
│   └── store/session.ts              — Zustand store
│
└── backend/           FastAPI, SQLAlchemy, OpenAI SDK
    ├── main.py
    ├── orchestrator.py               — State machine
    ├── agents/                       — 6 агентов
    ├── rag/                          — Chroma
    ├── documents/                    — python-docx генератор
    └── db/                           — SQLite
```

**Стадии wizard:** `intake → clarify → brief → context → hypothesis → method → sampling → design → done`

---

## 1. Исправление критических проблем

### 1.1 Race condition в stream (проблема #3)

**Файл:** `backend/api/stream.py`

**Проблема:** `save_state` регистрировался как `BackgroundTask` до завершения SSE-генератора. Если клиент отключался раньше `[DONE]`, функция `_persist_agent_output` не вызывалась, но `save_state` всё равно сохранял устаревшее состояние.

**Решение:** Перенос сохранения состояния внутрь `event_generator` — строго после `_persist_agent_output` и до отправки `[DONE]`. `BackgroundTasks` полностью убран.

```python
async def event_generator():
    try:
        async for chunk in orchestrator.stream(body.user_input):
            full_response.append(chunk)
            yield f"data: {chunk}\n\n"

        _persist_agent_output(orchestrator.state, "".join(full_response))

        async with SessionLocal() as db:
            ...  # сохранение state
            await db.commit()

        yield "data: [DONE]\n\n"
    except Exception as e:
        yield f"data: [ERROR] {json.dumps(str(e))}\n\n"
```

### 1.2 PDF-генерация не работала (проблема #2)

**Файлы:** `backend/documents/generator.py`, `backend/requirements.txt`

**Проблема:** `WeasyPrint` конвертирует HTML→PDF, но код передавал ему путь к `.docx` файлу — конвертация молча падала и возвращала `.docx` вместо `.pdf`.

**Решение:** Добавлен `mammoth` для промежуточного шага `.docx` → HTML → PDF.

```python
import mammoth
from weasyprint import HTML

with open(docx_path, "rb") as f:
    html_content = mammoth.convert_to_html(f).value
HTML(string=html_content).write_pdf(pdf_path)
```

---

## 2. Исправление незначительных проблем

| # | Файл | Изменение |
|---|---|---|
| 4 | `frontend/store/session.ts` | Удалена несуществующая стадия `"scenario"` из типа `Stage` |
| 5 | `README.md` | Исправлено `Anthropic SDK` → `OpenAI SDK` |
| 6 | `backend/main.py`, `.env`, `.env.example` | CORS origin вынесен в `CORS_ORIGINS` env-переменную (поддержка нескольких через запятую) |

---

## 3. Переработка этапа диагностики (было: «Уточняющие вопросы»)

Самое крупное изменение итерации. Этап `intake` полностью переработан из набора LLM-генерируемых вопросов в структурированный диагностический флоу.

### Новый флоу

```
intake  →  ClarifyScreen (3-шаговая форма, без LLM)
              Шаг 1: Decision (textarea, обязательный)
              Шаг 2: Тип неопределённости (мультиселект карточки)
              Шаг 3: Контекст (что есть + ограничения, chips)
       ↓
clarify →  ResearchDiagnosisScreen (LLM генерирует summary + риски + рекомендации)
              Кнопки: «Подтвердить понимание» / «← Исправить»
       ↓
context →  загрузка файлов (как прежде)
```

### Архитектурные решения

- **Q1-Q3 — чистый фронтенд, без LLM.** Вопросы фиксированы. LLM вызывается один раз на шаге `clarify` только для генерации резюме, рисков и рекомендаций.
- **Мерж диагностики в store.** Фронтенд объединяет структурированные ответы Q1-Q3 (из `diagnosticAnswersRef`) с LLM-выводом в единый объект `Diagnosis`.
- **`advancedToClarity` ref.** Переход `intake → clarify` выполняется один раз. При нажатии «Исправить» бэкенд остаётся на `clarify`, следующий сабмит просто перегенерирует диагноз.
- **`method_patch` в advance.** При подтверждении диагноза `uncertainty_types[]` и `preliminary_methods[]` сохраняются в `state.method` — MethodAgent использует их как подсказку.

### Маппинг типов неопределённости → методы

| Тип | Метод |
|---|---|
| Не понимаем проблему / причины поведения | Глубинные интервью |
| Не уверены в решении | Concept test / Co-creation |
| Проверяем удобство | Юзабилити-тестирование |
| Сравниваем варианты | A/B тест / Card sorting |
| Не понимаем масштаб | Опрос / Аналитика |
| Другое / свой вариант | Определим позже |

### Новые типы (`frontend/types/research.ts`)

```typescript
type UncertaintyType = "problem_understanding" | "behavior_why" | "solution_uncertainty"
                     | "usability" | "comparison" | "scale" | "other"

type PreliminaryMethod = "deep_interviews" | "concept_test" | "usability_testing"
                       | "ab_test" | "survey" | "other"

type AvailableSource = "analytics" | "past_research" | "user_access"
                     | "prototype" | "product" | "support_tickets" | "nothing"

type ConstraintType = "time_limited" | "budget_limited" | "hard_recruiting"
                    | "no_user_contact" | "no_analytics"

interface DiagnosticAnswers {
  decision: string
  uncertainty_types: UncertaintyType[]
  custom_uncertainty?: string
  preliminary_methods: PreliminaryMethod[]
  available_sources: AvailableSource[]
  constraints: ConstraintType[]
}

interface Diagnosis extends DiagnosticAnswers {
  summary: string
  needed_for_quality: string[]
  main_risks: string[]
}
```

### Изменения бэкенда

**`backend/agents/brief.py`** — добавлен `DIAGNOSIS_SYSTEM` промпт и stage `"diagnosis"`:
```python
# Стадии BriefAgent: "intake" | "diagnosis" | "brief"
"clarify": BriefAgent(stage="diagnosis")  # было: BriefAgent(stage="brief")
```

**`backend/api/stream.py`** — обновлён `AdvanceRequest`:
```python
class AdvanceRequest(BaseModel):
    brief: Optional[dict] = None
    method_patch: Optional[dict] = None  # новое поле
```

**`backend/api/stream.py`** — обновлён `_persist_agent_output`:
```python
if stage == "clarify" and "summary" in data:
    state["diagnosis"] = data
    state.setdefault("context", {})["available_sources"] = ...
elif stage in ("intake", "brief") and data.get("research_question"):
    state["brief"] = data
```

### Изменённые файлы

| Файл | Тип |
|---|---|
| `frontend/types/research.ts` | новый |
| `frontend/store/session.ts` | обновлён (+`diagnosis`, +`setDiagnosis`) |
| `frontend/components/wizard/ClarifyScreen.tsx` | переписан |
| `frontend/components/wizard/ResearchDiagnosisScreen.tsx` | новый |
| `frontend/app/session/[id]/page.tsx` | обновлён |
| `backend/agents/brief.py` | обновлён |
| `backend/orchestrator.py` | обновлён |
| `backend/api/stream.py` | обновлён |

---

## 4. Мультиселект на шаге «Неопределённость»

**Файлы:** `types/research.ts`, `ClarifyScreen.tsx`, `ResearchDiagnosisScreen.tsx`, `brief.py`

Шаг 2 переработан с single-select (радио) на multi-select (чекбокс-карточки). Пользователь может выбрать несколько типов неопределённости одновременно.

- `uncertainty_type: UncertaintyType` → `uncertainty_types: UncertaintyType[]`
- `preliminary_method: PreliminaryMethod` → `preliminary_methods: PreliminaryMethod[]`
- Добавлен хелпер `uncertaintiesToMethods(types[])` — дедуплицирует методы
- Превью выбранных методов обновляется в реальном времени под карточками
- На экране диагноза показываются все выбранные типы и методы

---

## 5. Свой вариант неопределённости

**Файлы:** `types/research.ts`, `ClarifyScreen.tsx`, `ResearchDiagnosisScreen.tsx`, `brief.py`

Добавлено поле `custom_uncertainty?: string` в `DiagnosticAnswers`.

В шаге 2 под карточками появился textarea «Или опишите своими словами». Кнопка «Далее» активируется при любом из условий: выбрана карточка ИЛИ введён текст.

Если введён только кастомный текст (без карточек) — показывается «Определим на этапе метода». Если и карточки, и текст — показывается «+ свой вариант».

---

## 6. Возврат на предыдущий этап

**Файлы:** `backend/orchestrator.py`, `backend/api/stream.py`, `frontend/app/session/[id]/page.tsx`

### Бэкенд

Добавлен `prev_stage()` в оркестраторе со скипом `brief` (этот этап никогда не отображается в UI):

```python
_SKIP_ON_RETREAT = {"brief"}

def prev_stage(current: str) -> str:
    idx = STAGE_ORDER.index(current)
    new_idx = idx - 1
    while new_idx > 0 and STAGE_ORDER[new_idx] in _SKIP_ON_RETREAT:
        new_idx -= 1
    return STAGE_ORDER[max(0, new_idx)]
```

Новый эндпоинт:
```
POST /api/session/{id}/retreat
```

### Фронтенд

Кнопка «← Предыдущий шаг» отображается на всех этапах, кроме:
- `intake` — первый шаг, некуда возвращаться
- `clarify` — у него уже есть «← Исправить» внутри
- `done` — финальный экран

При переходе назад с `context` оркестратор пропускает `brief` и возвращает `clarify` напрямую. Накопленные данные не сбрасываются.

---

## 7. Улучшения экрана гипотез

### 7.1 Исправление ошибки хуков

**Файл:** `frontend/components/wizard/HypothesesScreen.tsx`

**Ошибка:** `Rendered more hooks than during the previous render` — `useState(false)` и `useState("")` вызывались после раннего `return` (условный возврат внутри компонента).

**Решение:** Оба хука перенесены в начало функции компонента, до любых условных возвратов.

### 7.2 Три чётких состояния стриминга

Добавлены `useEffect` + `useRef` для отслеживания времени последнего чанка:

| Состояние | Условие | UI |
|---|---|---|
| **Подключение** | `streaming && streamText === ""` | Большой пульсирующий индикатор по центру + счётчик секунд |
| **Активный стриминг** | `streaming && streamText !== "" && !isHung` | Статус-бар + прогресс-бар + карточки гипотез. Если пауза ≥5 сек — счётчик в углу |
| **Завис** | 15 сек без нового чанка | Жёлтый баннер «Нет ответа уже N сек. Попробуйте вернуться назад» |

---

## 8. Исправление: шаг 4 не показывал загрузку документов

**Файлы:** `frontend/hooks/useSSE.ts`, `frontend/app/session/[id]/page.tsx`

**Проблема:** После завершения диагностического стрима `sseText` содержал JSON диагноза. При переходе на шаг `context` условие `sseText === ""` было `false`, поэтому `ContextUploadScreen` пропускался и сразу показывался `ContextResult` со старыми данными.

**Решение:** Добавлен `clearText` в `useSSE`:
```typescript
const clearText = useCallback(() => setText(""), []);
return { text, streaming, error, stream, clearText };
```

Вызывается в `onDiagnosisConfirm` и `onBriefConfirm` перед `store.setStage("context")`.

---

## 9. Исправление: кнопка «Далее» на шаге 2 не нажималась

**Файл:** `frontend/components/wizard/ClarifyScreen.tsx`

**Проблема:** `uncertaintyTypes` хранился как `Set<UncertaintyType>`. React сравнивает объекты через `Object.is`, и при определённых условиях изменение Set не гарантирует ре-рендер.

**Решение:** Замена `Set` на обычный массив — идиоматичный React. Новые ссылки гарантированы через `[...prev, t]` и `prev.filter(x => x !== t)`.

```typescript
// было
const [uncertaintyTypes, setUncertaintyTypes] = useState<Set<UncertaintyType>>(new Set());
function toggleUncertainty(t) { setUncertaintyTypes(prev => { const next = new Set(prev); ... }) }

// стало
const [uncertaintyTypes, setUncertaintyTypes] = useState<UncertaintyType[]>([]);
function toggleUncertainty(t) {
  setUncertaintyTypes(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]);
}
```

Также добавлена подсказка под кнопкой: «Выберите хотя бы один вариант или опишите своими словами» — отображается когда ничего не выбрано.

---

## Итоговый список изменённых файлов

### Новые файлы
- `frontend/types/research.ts` — все типы диагностики
- `frontend/components/wizard/ResearchDiagnosisScreen.tsx` — экран диагноза
- `docs/iteration-2.md` — этот документ

### Обновлённые файлы
- `frontend/store/session.ts` — `diagnosis`, `Diagnosis`, `setDiagnosis`
- `frontend/hooks/useSSE.ts` — `clearText`
- `frontend/app/session/[id]/page.tsx` — полный рефакторинг хендлеров и роутинга
- `frontend/components/wizard/ClarifyScreen.tsx` — полная переработка
- `frontend/components/wizard/HypothesesScreen.tsx` — фикс хуков + индикаторы
- `backend/main.py` — CORS из env
- `backend/orchestrator.py` — `retreat()`, `prev_stage()`, `_SKIP_ON_RETREAT`
- `backend/agents/brief.py` — `DIAGNOSIS_SYSTEM`, stage `"diagnosis"`
- `backend/api/stream.py` — `retreat` эндпоинт, `method_patch`, `clearText`
- `backend/documents/generator.py` — PDF через mammoth → WeasyPrint
- `backend/requirements.txt` — `mammoth>=1.6.0`
- `backend/.env` / `.env.example` — `CORS_ORIGINS`
- `README.md` — исправлена ссылка на SDK
