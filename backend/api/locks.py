"""Per-session asyncio locks for serialising state mutations within one process.

State updates from `advance`, `retreat`, `upload` and the post-stream merge all go
through the same lock so a long-running stream can't clobber a concurrent edit.
The stream itself does NOT hold the lock for its full duration — it only acquires
it briefly at the start (snapshot read) and at the end (merge-write).
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

_locks: dict[str, asyncio.Lock] = {}
_registry_lock = asyncio.Lock()


async def _get_lock(session_id: str) -> asyncio.Lock:
    async with _registry_lock:
        lock = _locks.get(session_id)
        if lock is None:
            lock = asyncio.Lock()
            _locks[session_id] = lock
        return lock


@asynccontextmanager
async def session_lock(session_id: str):
    lock = await _get_lock(session_id)
    async with lock:
        yield
