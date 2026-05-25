from __future__ import annotations

import json
from typing import Any

from agents.base import BaseAgent, selected_hypotheses

SYSTEM = """Ты — Sampling Agent. Определяешь выборку и критерии рекрутинга для исследования.

Будь лаконичен: короткие описания сегментов, чёткие критерии без лишних пояснений.

Ответь СТРОГО в формате JSON (без markdown-блоков):
{
  "segments": [
    {"name": "Название сегмента", "description": "Кто это и почему важен", "size": 3}
  ],
  "total_size": 8,
  "criteria": {
    "include": ["критерий включения 1", "критерий включения 2"],
    "exclude": ["критерий исключения 1"]
  },
  "screener": [
    "Вопрос скринера 1?",
    "Вопрос скринера 2?",
    "Вопрос скринера 3?"
  ]
}

Количество участников рассчитывается ПО СЕГМЕНТАМ:
- интервью (method_key=deep_interviews): минимум 4 человека в КАЖДОМ сегменте. total_size = сумма размеров сегментов.
- юзабилити-тестирование (method_key=usability_testing): минимум 3 человека в КАЖДОМ сегменте. total_size = сумма размеров сегментов.
- опрос (method_key=survey): ВСЕГДА минимум 150 респондентов. Это нижняя граница без исключений — даже для пилота, экспресс-замера или узкой ниши. Если ЦА сегментирована, 150 — это минимум на каждое значимое сравнение сегментов; общий total_size соответственно выше. Меньше 150 ставить нельзя ни при каких ограничениях бюджета/времени.

Минимумы на сегмент для интервью/юзабилити — нижняя граница, а не цель. Если число участников из выбранного метода (см. ниже в сообщении) выше этого минимума и оправдано числом гипотез/глубиной сравнения сегментов — распределяй большее число пропорционально между сегментами.

ВАЖНО — про блок "screener":
- Если метод "Опрос" (method_key=survey), всегда возвращай "screener": [] (пустой массив). У опроса свой блок скрининг-вопросов внутри анкеты, который сгенерирует Design-агент на следующем шаге, — здесь дублировать нельзя.
- Для интервью / юзабилити / прочих методов — блок "screener" заполняй как обычно: 2–4 коротких вопроса, отсеивающих нецелевых.

Сегменты должны покрывать все ключевые гипотезы.
Отвечай на русском языке."""


class SamplingAgent(BaseAgent):
    def _max_tokens(self) -> int:
        return 1500

    @property
    def system_prompt(self) -> str:
        return SYSTEM

    def build_messages(self, state: dict[str, Any], user_input: str) -> list[dict]:
        brief = state.get("brief") or {}
        method = state.get("method") or {}
        hypotheses = selected_hypotheses(state)

        content = (
            f"Бриф:\n{json.dumps(brief, ensure_ascii=False)}\n\n"
            f"Метод: {method.get('name', '—')} (method_key={method.get('method_key', '?')}, "
            f"{method.get('participants', '?')} участников)\n\n"
            f"Гипотезы:\n{json.dumps(hypotheses, ensure_ascii=False)}"
        )
        return [{"role": "user", "content": content}]
