"""Clarity validator: проверяет, что ключевые поля брифа сформулированы чётко.

Не агент в классическом смысле — один не-стримящий LLM-вызов с JSON-выходом.
Используется как блокер до запуска тяжёлых шагов (intake / diagnosis).
"""

from __future__ import annotations

import json
import logging
import os

import openai

from agents.base import _clean_json_text, _get_client

logger = logging.getLogger(__name__)

FIELD_LABELS = {
    "business_goal":    "Бизнес-цель",
    "business_context": "Бизнес-контекст",
    "task":             "Что исследуем",
    "decision":         "Какое решение будет принято",
}

SYSTEM = """Ты — редактор-валидатор брифа UX-исследования. Проверяешь, насколько чётко сформулированы поля заказчика, прежде чем агент пойдёт работать дальше.

Критерии «поле ОК»:
- business_goal: понятно, какого измеримого бизнес-результата хочет команда (есть метрика, целевое значение или явный итог).
- business_context: понятно, какая ситуация в продукте/бизнесе породила задачу (факты, цифры, изменения, что и когда произошло).
- task: понятно, что именно нужно изучить у пользователей (конкретная сторона поведения / опыта / барьеров).
- decision: понятно, какое продуктовое решение команда примет по итогам (бинарный или мультивариантный выбор).

Поле НЕ ОК, если:
- слишком общее или расплывчатое («улучшить UX», «понять пользователей», «что-то с продуктом»);
- мусор / случайные буквы / бессмыслица;
- формулирует не то, что просили (например, в business_goal указано решение, а не цель);
- слишком короткое, чтобы быть полезным;
- противоречивое.

Будь умеренно строгим: пропускай разумные формулировки, даже если они не идеальны. Блокируй только реально расплывчатые или мусорные ответы.

Для каждого присланного поля верни:
- ok: true/false
- issue: если ok=false — короткое объяснение пользователю простым языком (1–2 предложения, на «вы»), ЧТО не так и КАК переформулировать. Если ok=true — null.

Поле, которого нет на входе, не упоминай.

Ответь СТРОГО JSON без markdown:
{
  "fields": {
    "business_goal":    {"ok": true, "issue": null},
    "business_context": {"ok": false, "issue": "..."},
    "task":             {"ok": true, "issue": null},
    "decision":         {"ok": true, "issue": null}
  }
}"""


async def validate_clarity(fields: dict[str, str | None]) -> dict:
    """Run clarity validation. Returns {ok, issues: {field_key: text}}.

    Fail-open: при ошибке LLM не блокируем (ok=True, issues={}), чтобы
    пользователь мог двигаться дальше, если валидатор временно недоступен.
    """
    provided: dict[str, str] = {}
    for k, v in fields.items():
        if k not in FIELD_LABELS:
            continue
        s = (v or "").strip()
        if s:
            provided[k] = s

    if not provided:
        return {"ok": True, "issues": {}}

    user_content = "Поля для проверки:\n" + "\n".join(
        f'- {FIELD_LABELS[k]} ({k}): "{v}"' for k, v in provided.items()
    )

    model = os.environ["OPENAI_MODEL_MINI"]

    try:
        client = _get_client()
        response = await client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": SYSTEM},
                {"role": "user", "content": user_content},
            ],
            max_completion_tokens=600,
            response_format={"type": "json_object"},
        )
        raw = response.choices[0].message.content or "{}"
        if response.usage:
            logger.info(
                "openai_call agent=validator model=%s prompt=%d completion=%d finish=%s",
                model, response.usage.prompt_tokens, response.usage.completion_tokens,
                response.choices[0].finish_reason or "?",
            )
            from db.usage import log_usage
            await log_usage(model, response.usage.prompt_tokens, response.usage.completion_tokens)
    except openai.NotFoundError as e:
        # Misconfigured OPENAI_MODEL_MINI — visible as a single line in logs
        # instead of a stack trace, since this is config, not a transient error.
        logger.error("validate_clarity: model %r not available — check OPENAI_MODEL_MINI env (%s)", model, e)
        return {"ok": True, "issues": {}}
    except Exception:
        logger.exception("validate_clarity: LLM call failed, failing open")
        return {"ok": True, "issues": {}}

    try:
        data = json.loads(_clean_json_text(raw))
    except Exception:
        logger.warning("validate_clarity: invalid JSON from LLM: %r", raw[:200])
        return {"ok": True, "issues": {}}

    field_results = data.get("fields") or {}
    issues: dict[str, str] = {}
    for k in provided:
        info = field_results.get(k)
        if isinstance(info, dict) and info.get("ok") is False:
            text = (info.get("issue") or "").strip() or "Сформулируйте, пожалуйста, чётче."
            issues[k] = text

    return {"ok": not issues, "issues": issues}
