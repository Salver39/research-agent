from __future__ import annotations

from typing import Optional
from fastapi import Depends, Header, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from db.database import get_db
from db.models import Session as DBSession


async def require_owner(
    session_id: str,
    x_owner_token: Optional[str] = Header(default=None, alias="X-Owner-Token"),
    token: Optional[str] = Query(default=None),
    db: AsyncSession = Depends(get_db),
) -> DBSession:
    """Resolve session by id and verify the caller owns it.

    Token is taken from `X-Owner-Token` header (preferred) or `?token=` query
    parameter as a fallback for plain `<a href>` downloads.
    """
    provided = x_owner_token or token
    if not provided:
        raise HTTPException(status_code=401, detail="Missing owner token")

    result = await db.execute(select(DBSession).where(DBSession.id == session_id))
    db_session = result.scalar_one_or_none()
    if not db_session:
        raise HTTPException(status_code=404, detail="Session not found")
    if db_session.owner_token != provided:
        raise HTTPException(status_code=403, detail="Forbidden")
    return db_session
