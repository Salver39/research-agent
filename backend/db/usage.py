"""Budget tracking for the kill-switch.

We record every OpenAI call into `usage_log` (model + tokens) and sum the
estimated cost over the last 24h. When the running cost exceeds
DAILY_BUDGET_USD the signup endpoint returns 503 so abusers can't keep
spawning fresh sessions while existing ones drain to completion.

Pricing here is a **conservative over-estimate** — real OpenAI prices for
gpt-5.x are volatile, so we bias high to fail safe.
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from db.database import SessionLocal
from db.models import UsageLog

logger = logging.getLogger(__name__)

# Per-1M-token USD pricing. Add new models here as they appear; the default
# row deliberately over-estimates so unknown models don't sneak past the
# budget check.
PRICING: dict[str, dict[str, float]] = {
    "gpt-5.5":      {"input": 5.0, "output": 15.0},
    "gpt-5.5-mini": {"input": 0.5, "output": 1.5},
    "gpt-5.4":      {"input": 5.0, "output": 15.0},
    "gpt-5.4-mini": {"input": 0.5, "output": 1.5},
    "gpt-4o":       {"input": 5.0, "output": 15.0},
    "gpt-4o-mini":  {"input": 0.15, "output": 0.6},
    "default":      {"input": 10.0, "output": 30.0},
}


def estimate_cost_usd(model: str, prompt_tokens: int, completion_tokens: int) -> float:
    p = PRICING.get(model) or PRICING["default"]
    return (prompt_tokens * p["input"] + completion_tokens * p["output"]) / 1_000_000


async def log_usage(model: str, prompt_tokens: int, completion_tokens: int) -> None:
    """Record one OpenAI call. Best-effort: never raises into the caller."""
    try:
        async with SessionLocal() as db:
            db.add(UsageLog(
                model=model,
                prompt_tokens=prompt_tokens or 0,
                completion_tokens=completion_tokens or 0,
            ))
            await db.commit()
    except Exception:
        logger.exception("log_usage failed (model=%s) — continuing without record", model)


async def current_day_cost_usd(db: AsyncSession) -> float:
    """Sum estimated USD cost over the last 24h."""
    since = datetime.now(timezone.utc) - timedelta(hours=24)
    result = await db.execute(
        select(UsageLog.model, func.sum(UsageLog.prompt_tokens), func.sum(UsageLog.completion_tokens))
        .where(UsageLog.created_at >= since)
        .group_by(UsageLog.model)
    )
    total = 0.0
    for model, p, c in result.all():
        total += estimate_cost_usd(model, int(p or 0), int(c or 0))
    return total


async def check_budget(db: AsyncSession) -> None:
    """Raise 503 if daily budget is exceeded. No-op when budget is not set."""
    budget_str = os.getenv("DAILY_BUDGET_USD")
    if not budget_str:
        return
    try:
        budget = float(budget_str)
    except ValueError:
        return
    if budget <= 0:
        return
    cost = await current_day_cost_usd(db)
    if cost >= budget:
        logger.warning("budget exceeded: cost=$%.2f >= limit=$%.2f", cost, budget)
        raise HTTPException(
            status_code=503,
            detail={
                "error": "budget_exceeded",
                "message": "Сервис временно недоступен — превышен дневной лимит. Попробуйте завтра.",
            },
        )
