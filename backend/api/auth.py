from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, EmailStr
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from db.database import get_db
from db.models import MagicLinkToken, Session as DBSession, User
from db.usage import check_budget

logger = logging.getLogger(__name__)
router = APIRouter()

MAGIC_LINK_TTL_MINUTES = 15


class RequestMagicLinkBody(BaseModel):
    email: EmailStr


class MeResponse(BaseModel):
    email: str
    existing_session_id: Optional[str] = None
    existing_owner_token: Optional[str] = None


def auth_required() -> bool:
    return os.getenv("AUTH_MODE", "disabled").lower() == "required"


async def require_user(
    authorization: Optional[str] = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> User:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing auth token")
    token = authorization[len("Bearer ") :].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Missing auth token")
    result = await db.execute(select(User).where(User.auth_token == token))
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=401, detail="Invalid auth token")
    return user


async def maybe_require_user(
    authorization: Optional[str] = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> Optional[User]:
    """Resolve current User if AUTH_MODE=required, else None (self-host flow)."""
    if not auth_required():
        return None
    return await require_user(authorization=authorization, db=db)


async def _send_magic_link_email(to_email: str, verify_url: str) -> None:
    api_key = os.getenv("RESEND_API_KEY")
    from_addr = os.getenv("RESEND_FROM", "onboarding@resend.dev")
    if not api_key:
        raise HTTPException(status_code=500, detail="Email sender is not configured")

    html = (
        "<p>Здравствуйте!</p>"
        "<p>Перейдите по ссылке, чтобы войти в Research Agent:</p>"
        f'<p><a href="{verify_url}">Войти</a></p>'
        "<p>Ссылка действительна 15 минут. Если вы её не запрашивали — просто проигнорируйте это письмо.</p>"
    )
    payload = {
        "from": from_addr,
        "to": [to_email],
        "subject": "Вход в Research Agent",
        "html": html,
    }
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            "https://api.resend.com/emails",
            json=payload,
            headers={"Authorization": f"Bearer {api_key}"},
        )
    if resp.status_code >= 300:
        logger.error("Resend send failed: status=%s body=%s", resp.status_code, resp.text)
        raise HTTPException(status_code=502, detail="Failed to send email")


@router.post("/auth/request")
async def request_magic_link(body: RequestMagicLinkBody, db: AsyncSession = Depends(get_db)):
    # Kill-switch: block signup once today's estimated OpenAI cost crosses
    # DAILY_BUDGET_USD. Existing sessions continue, only new email signups
    # are stopped — abuse can't keep spawning fresh sessions.
    await check_budget(db)

    email = body.email.lower()
    backend_url = os.getenv("BACKEND_PUBLIC_URL", "http://localhost:8000")

    token_row = MagicLinkToken(
        email=email,
        expires_at=datetime.now(timezone.utc) + timedelta(minutes=MAGIC_LINK_TTL_MINUTES),
    )
    db.add(token_row)
    await db.commit()
    await db.refresh(token_row)

    verify_url = f"{backend_url.rstrip('/')}/api/auth/verify?token={token_row.token}"
    await _send_magic_link_email(email, verify_url)
    return {"ok": True}


@router.get("/auth/verify")
async def verify_magic_link(token: str, db: AsyncSession = Depends(get_db)):
    frontend_url = os.getenv("FRONTEND_URL", "http://localhost:3000").rstrip("/")

    result = await db.execute(select(MagicLinkToken).where(MagicLinkToken.token == token))
    row = result.scalar_one_or_none()
    if row is None:
        return RedirectResponse(url=f"{frontend_url}/auth/error?reason=invalid", status_code=307)
    if row.consumed_at is not None:
        return RedirectResponse(url=f"{frontend_url}/auth/error?reason=consumed", status_code=307)

    expires_at = row.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at < datetime.now(timezone.utc):
        return RedirectResponse(url=f"{frontend_url}/auth/error?reason=expired", status_code=307)

    user_result = await db.execute(select(User).where(User.email == row.email))
    user = user_result.scalar_one_or_none()
    if user is None:
        user = User(email=row.email)
        db.add(user)

    row.consumed_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(user)

    return RedirectResponse(url=f"{frontend_url}/auth/callback?auth_token={user.auth_token}", status_code=307)


@router.get("/me", response_model=MeResponse)
async def me(user: User = Depends(require_user), db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(DBSession).where(DBSession.user_id == user.id))
    existing = result.scalars().first()
    return MeResponse(
        email=user.email,
        existing_session_id=existing.id if existing else None,
        existing_owner_token=existing.owner_token if existing else None,
    )
