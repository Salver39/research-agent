from __future__ import annotations

from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel

from agents.validator import validate_clarity

router = APIRouter()


class ValidateClarityRequest(BaseModel):
    business_goal: Optional[str] = None
    business_context: Optional[str] = None
    task: Optional[str] = None
    decision: Optional[str] = None


class ValidateClarityResponse(BaseModel):
    ok: bool
    issues: dict[str, str]


@router.post("/validate-clarity", response_model=ValidateClarityResponse)
async def validate_clarity_endpoint(body: ValidateClarityRequest) -> ValidateClarityResponse:
    result = await validate_clarity(
        {
            "business_goal":    body.business_goal,
            "business_context": body.business_context,
            "task":             body.task,
            "decision":         body.decision,
        }
    )
    return ValidateClarityResponse(ok=result["ok"], issues=result["issues"])
