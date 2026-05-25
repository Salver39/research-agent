from __future__ import annotations

import json
from typing import Any

from agents.base import BaseAgent

SYSTEM = """Ты — Context Agent. Извлекаешь паттерны и находки, релевантные теме исследования, из ДВУХ равноправных источников: брифа исследования и фрагментов документов компании (если они есть).

Ответь СТРОГО в формате JSON (без markdown-блоков):
{
  "patterns": [
    {"text": "Описание паттерна или находки", "source": "имя файла или 'бриф'"},
    ...
  ],
  "summary": "Краткое резюме: что удалось найти и в брифе, и в документах"
}

Правила:
- Бриф — это не просто контекст для понимания темы, а такой же источник паттернов, как и документы. Из него тоже надо извлекать находки (бизнес-цель, известное о проблеме, ограничения, что заказчик уже знает или предполагает).
- Когда есть и бриф, и документы — patterns должен содержать находки из ОБОИХ источников. Не своди всё к документам только потому, что фрагментов больше по объёму.
- Когда документов нет — работай только с брифом, source='бриф'.
- Если совсем не из чего извлечь паттерн — верни пустой список и честно опиши это в summary.
Отвечай на русском языке."""


class ContextAgent(BaseAgent):
    @property
    def system_prompt(self) -> str:
        return SYSTEM

    def build_messages(self, state: dict[str, Any], user_input: str) -> list[dict]:
        brief = state.get("brief") or {}
        sources = state.get("context", {}).get("sources", [])
        rag_fragments = state.get("context", {}).get("rag_fragments", [])

        content = (
            "Источник 1 — Бриф исследования (всегда обязателен как источник паттернов):\n"
            f"{json.dumps(brief, ensure_ascii=False)}\n\n"
            f"Загруженные файлы: {[s.get('name') for s in sources] or 'нет файлов'}\n\n"
        )

        if rag_fragments:
            content += "Источник 2 — Фрагменты из документов компании:\n"
            for f in rag_fragments:
                content += f"[{f['source']}]: {f['text']}\n\n"
            content += (
                "Выведи паттерны из обоих источников. Часть паттернов должна опираться "
                "на бриф (source='бриф'), часть — на документы (source=имя файла).\n"
            )
        else:
            content += "Источник 2 — Документов компании нет. Извлекай паттерны только из брифа.\n"

        return [{"role": "user", "content": content}]
