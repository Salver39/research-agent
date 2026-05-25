from __future__ import annotations

import json
from typing import Any

from agents.base import BaseAgent, hypotheses_for_method
from prompts.design_survey import SYSTEM


class DesignSurveyAgent(BaseAgent):
    def _max_tokens(self) -> int:
        return 16000

    @property
    def system_prompt(self) -> str:
        return SYSTEM

    def build_messages(self, state: dict[str, Any], user_input: str) -> list[dict]:
        diagnosis = state.get("diagnosis") or {}
        research_goal = diagnosis.get("research_goal", "")
        research_tasks = diagnosis.get("research_tasks", [])

        goal_block = ""
        if research_goal:
            goal_block = (
                f"\nЦель исследования (сформулирована на этапе диагноза, используй verbatim):\n{research_goal}\n"
            )
        if research_tasks:
            goal_block += (
                f"Задачи исследования (сформулированы на этапе диагноза, используй verbatim):\n"
                + "\n".join(f"- {t}" for t in research_tasks) + "\n"
            )

        in_scope, out_of_scope = hypotheses_for_method(state)
        excluded_block = ""
        if out_of_scope:
            excluded_block = (
                "\nИСКЛЮЧЁННЫЕ гипотезы (опрос не подходит для их проверки — НЕ создавай для них вопросов в анкете, НЕ упоминай их):\n"
                + json.dumps(out_of_scope, ensure_ascii=False) + "\n"
            )

        content = (
            f"Бриф: {json.dumps(state.get('brief') or {}, ensure_ascii=False)}\n"
            f"Метод: {json.dumps(state.get('method') or {}, ensure_ascii=False)}\n"
            f"Выборка: {json.dumps(state.get('sample') or {}, ensure_ascii=False)}\n"
            f"Гипотезы для проверки этим методом: {json.dumps(in_scope, ensure_ascii=False)}"
            f"{excluded_block}"
            f"{goal_block}"
        )
        return [{"role": "user", "content": content}]
