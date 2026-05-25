from __future__ import annotations

import json
import os
from typing import Any

from agents.base import BaseAgent

INTAKE_SYSTEM = """Ты — Brief Agent, специалист по подготовке UX-исследований.

На этапе intake твоя задача: задать заказчику 2–3 уточняющих вопроса.

Ответь СТРОГО в формате JSON (без markdown-блоков, без пояснений):
{
  "questions": [
    "Вопрос 1?",
    "Вопрос 2?",
    "Вопрос 3?"
  ]
}

Вопросы должны уточнить:
1. Какое конкретное решение будет принято по результатам исследования
2. Что уже известно / какие данные есть
3. Ограничения (сроки, бюджет, доступ к пользователям)
"""

DIAGNOSIS_SYSTEM = """Ты — Brief Agent. На основе диагностических данных составь резюме исследования.

Тебе даны структурированные ответы заказчика:
- business_goal: бизнес цель — чего хочет достичь команда
- business_context: бизнес контекст — ситуация, из-за которой появилась задача
- task: что хотят исследовать
- decision: какое решение хотят принять
- uncertainty_type: тип неопределённости (на русском)
- preliminary_method: предварительный метод (на русском)
- available_sources: что уже есть у команды
- constraints: ограничения проекта
- platform: платформа (мобильное приложение / сайт / мобильный сайт / ничего)

Ответь СТРОГО в формате JSON (без markdown-блоков):
{
  "summary": "1–2 предложения: что команда хочет решить и какая неопределённость мешает",
  "research_goal": "Цель исследования одной фразой — отвечает на вопрос «зачем мы это делаем». Начинается с глагола: Понять / Выявить / Определить / Изучить...",
  "research_tasks": [
    "Задача 1: конкретный измеримый шаг, декомпозирующий цель",
    "Задача 2: ...",
    "Задача 3: ...",
    "Задача 4: ..."
  ],
  "needed_for_quality": [
    "конкретная вещь, которую желательно загрузить или иметь — 1",
    "конкретная вещь — 2",
    "конкретная вещь — 3"
  ],
  "main_risks": [
    "Конкретный риск для качества этого исследования — 1",
    "Конкретный риск — 2"
  ]
}

research_goal — одна фраза-цель всего исследования.

КРИТИЧЕСКОЕ ПРАВИЛО — РАЗДЕЛЯЙ ЦЕЛЬ ИССЛЕДОВАНИЯ И БИЗНЕС-РЕШЕНИЕ:
  Поле `decision` из входа — это бизнес-решение заказчика (например: «делать редизайн
  или нет», «запускать фичу или закрывать», «выбрать вариант A или B»). Это НЕ цель
  исследования. Исследование не принимает решений — оно поставляет информацию, на
  основе которой команда заказчика принимает решение вместе с другими входами
  (стратегия, ресурсы, экономика).

  Цель исследования должна формулироваться как ИНФОРМАЦИОННАЯ задача:
  что мы должны узнать / понять / выявить, чтобы заказчик мог принять своё решение.

  Плохо (цель = решение):
    decision: «Делать редизайн каталога или нет»
    research_goal: «Определить, нужен ли редизайн каталога» ← НЕВЕРНО, это решение, не цель
  Хорошо (цель = информация для решения):
    research_goal: «Понять, какие сценарии и барьеры пользователей в текущем каталоге
                   мешают целевым действиям»

  Плохо: «Решить, запускать ли фичу X»
  Хорошо: «Выявить, насколько фича X закрывает реальную потребность пользователей и
          какие сценарии она оставит непокрытыми»

  research_goal должен начинаться с глагола познавательного действия
  (Понять / Выявить / Определить / Изучить / Описать / Сравнить), а не глагола
  решения (Решить / Выбрать / Запустить / Сделать).

research_tasks — 4–6 конкретных задач, каждая декомпозирует цель на измеримые шаги.
  Каждая задача — тоже информационная (что узнать), а не директивная (что сделать).
needed_for_quality — дополнительные данные или артефакты, которые улучшат исследование.
main_risks — угрозы качеству именно этого исследования (не общие слова).
Отвечай на русском языке."""

BRIEF_SYSTEM = """Ты — Brief Agent, специалист по подготовке UX-исследований.

На основе задачи и ответов заказчика сформируй структурированный бриф.

Ответь СТРОГО в формате JSON (без markdown-блоков):
{
  "research_question": "Чёткий вопрос исследования",
  "decision": "Какое решение будет принято по результатам",
  "constraints": "Ограничения: сроки, бюджет, доступ к пользователям",
  "known": "Что уже известно, предыдущие данные"
}

Поле decision — обязательное. Без него бриф невалиден.
"""


class BriefAgent(BaseAgent):
    def __init__(self, stage: str = "intake"):
        self.stage = stage  # "intake" | "diagnosis" | "brief"

    def _model(self) -> str:
        if self.stage == "intake":
            return os.environ["OPENAI_MODEL_MINI"]
        return os.environ["OPENAI_MODEL"]

    @property
    def system_prompt(self) -> str:
        if self.stage == "intake":
            return INTAKE_SYSTEM
        if self.stage == "diagnosis":
            return DIAGNOSIS_SYSTEM
        return BRIEF_SYSTEM

    def build_messages(self, state: dict[str, Any], user_input: str) -> list[dict]:
        task = state.get("task", "")
        business_goal = state.get("business_goal", "")
        business_context = state.get("business_context", "")

        def business_prefix() -> str:
            parts = []
            if business_goal:
                parts.append(f"Бизнес цель: {business_goal}")
            if business_context:
                parts.append(f"Бизнес контекст: {business_context}")
            if task:
                parts.append(f"Что исследуем: {task}")
            return "\n".join(parts)

        if self.stage == "intake":
            return [{"role": "user", "content": business_prefix()}]

        if self.stage == "diagnosis":
            try:
                data = json.loads(user_input)
            except Exception:
                data = {}

            uncertainty_labels = {
                "problem_understanding": "Не понимаем проблему пользователей",
                "behavior_why":          "Не понимаем причины поведения",
                "solution_uncertainty":  "Не уверены в решении",
                "usability":             "Проверяем удобство использования",
                "comparison":            "Сравниваем варианты",
                "scale":                 "Не понимаем масштаб проблемы",
                "other":                 "Другое",
            }
            method_labels = {
                "deep_interviews":   "Глубинные интервью",
                "concept_test":      "Concept test / Co-creation",
                "usability_testing": "Юзабилити-тестирование",
                "ab_test":           "A/B тест / Card sorting",
                "survey":            "Опрос / Аналитика",
                "other":             "Определим позже",
            }

            u_types = data.get("uncertainty_types", [])
            p_methods = data.get("preliminary_methods", [])

            u_labels_list = [uncertainty_labels.get(t, t) for t in u_types]
            custom = data.get("custom_uncertainty", "")
            if custom:
                u_labels_list.append(f'"{custom}" (свой вариант)')
            u_labels = ", ".join(u_labels_list) or "не указан"
            m_labels = ", ".join(method_labels.get(m, m) for m in p_methods) or "определим позже"

            source_labels = {
                "analytics":       "Аналитика",
                "past_research":   "Прошлые исследования",
                "user_access":     "Доступ к пользователям",
                "prototype":       "Прототип",
                "product":         "Готовый продукт",
                "support_tickets": "Тикеты поддержки",
                "nothing":         "Ничего нет",
            }
            constraint_labels = {
                "time_limited":    "Мало времени",
                "budget_limited":  "Маленький бюджет",
                "hard_recruiting": "Сложный рекрутинг",
                "no_user_contact": "Нельзя общаться с пользователями",
                "no_analytics":    "Нет доступа к аналитике",
            }
            platform_labels = {
                "mobile_app":     "Мобильное приложение",
                "website":        "Сайт",
                "mobile_website": "Мобильный сайт",
                "none":           "Ничего",
            }

            sources_list = [source_labels.get(s, s) for s in data.get("available_sources", [])]
            custom_sources = (data.get("custom_sources") or "").strip()
            if custom_sources:
                sources_list.append(f'"{custom_sources}" (свой вариант)')
            sources_text = ", ".join(sources_list) or "ничего"

            constraints_list = [constraint_labels.get(c, c) for c in data.get("constraints", [])]
            custom_constraints = (data.get("custom_constraints") or "").strip()
            if custom_constraints:
                constraints_list.append(f'"{custom_constraints}" (свой вариант)')
            constraints_text = ", ".join(constraints_list) or "не указаны"

            platform_key = data.get("platform")
            platform_text = platform_labels.get(platform_key, platform_key) if platform_key else "не указана"

            content = (
                f"{business_prefix()}\n\n"
                f"Decision (что хотят решить): {data.get('decision', '')}\n"
                f"Типы неопределённости: {u_labels}\n"
                f"Предварительные методы: {m_labels}\n"
                f"Платформа: {platform_text}\n"
                f"Что уже есть: {sources_text}\n"
                f"Ограничения: {constraints_text}"
            )
            return [{"role": "user", "content": content}]

        # brief stage
        brief_existing = state.get("brief")
        content = (
            f"{business_prefix()}\n\n"
            f"Ответы заказчика на уточняющие вопросы:\n{user_input}"
        )
        if brief_existing:
            content += f"\n\nПредыдущий черновик брифа: {json.dumps(brief_existing, ensure_ascii=False)}"
        return [{"role": "user", "content": content}]
