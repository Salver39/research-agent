from __future__ import annotations

import json
from typing import Any

from agents.base import BaseAgent, selected_hypotheses
from prompts.design import SYSTEM


class DesignAgent(BaseAgent):
    def _max_tokens(self) -> int:
        return 16000

    @property
    def system_prompt(self) -> str:
        return SYSTEM

    def build_messages(self, state: dict[str, Any], user_input: str) -> list[dict]:
        content = (
            f"Полный стейт исследования:\n"
            f"Бриф: {json.dumps(state.get('brief') or {}, ensure_ascii=False)}\n"
            f"Метод: {json.dumps(state.get('method') or {}, ensure_ascii=False)}\n"
            f"Выборка: {json.dumps(state.get('sample') or {}, ensure_ascii=False)}\n"
            f"Гипотезы: {json.dumps(selected_hypotheses(state), ensure_ascii=False)}"
        )
        return [{"role": "user", "content": content}]
