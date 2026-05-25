from __future__ import annotations

import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.auth import maybe_require_user
from api.deps import require_owner
from db.database import get_db
from db.models import Session as DBSession, User

router = APIRouter()


MAX_INPUT_LEN = 20_000


class CreateSessionRequest(BaseModel):
    task: str = Field(..., max_length=MAX_INPUT_LEN)
    business_goal: str = Field(default="", max_length=MAX_INPUT_LEN)
    business_context: str = Field(default="", max_length=MAX_INPUT_LEN)


class CreateSessionResponse(BaseModel):
    session_id: str
    stage: str
    owner_token: str


class SessionResponse(BaseModel):
    session_id: str
    stage: str
    brief: Optional[dict] = None
    hypotheses: Optional[list] = None
    method: Optional[dict] = None
    method_plan: Optional[dict] = None
    sample: Optional[dict] = None
    design: Optional[dict] = None
    diagnosis: Optional[dict] = None
    context: Optional[dict] = None


@router.post("/session", response_model=CreateSessionResponse)
async def create_session(
    body: CreateSessionRequest,
    db: AsyncSession = Depends(get_db),
    user: Optional[User] = Depends(maybe_require_user),
):
    if user is not None:
        existing_q = await db.execute(select(DBSession).where(DBSession.user_id == user.id))
        existing = existing_q.scalars().first()
        if existing is not None:
            raise HTTPException(
                status_code=409,
                detail={"error": "session_exists", "existing_session_id": existing.id},
            )

    session_id = str(uuid.uuid4())
    owner_token = str(uuid.uuid4())
    initial_state = {
        "session_id": session_id,
        "stage": "intake",
        "business_goal": body.business_goal,
        "business_context": body.business_context,
        "task": body.task,
        "brief": None,
        "context": {"sources": [], "patterns": []},
        "hypotheses": [],
        "method": None,
        "sample": None,
        "documents": {},
    }
    db_session = DBSession(
        id=session_id,
        owner_token=owner_token,
        user_id=user.id if user is not None else None,
        state=initial_state,
    )
    db.add(db_session)
    await db.commit()
    return CreateSessionResponse(session_id=session_id, stage="intake", owner_token=owner_token)


@router.get("/session/{session_id}", response_model=SessionResponse)
async def get_session(session_id: str, db_session: DBSession = Depends(require_owner)):
    state = db_session.state or {}
    return SessionResponse(
        session_id=session_id,
        stage=state.get("stage", "intake"),
        brief=state.get("brief"),
        hypotheses=state.get("hypotheses"),
        method=state.get("method"),
        method_plan=state.get("method_plan"),
        sample=state.get("sample"),
        design=state.get("design"),
        diagnosis=state.get("diagnosis"),
        context=state.get("context"),
    )
