import asyncio
import os
from fastapi import APIRouter, BackgroundTasks, Depends, File, UploadFile, HTTPException
from sqlalchemy import select
from sqlalchemy.orm.attributes import flag_modified

from api.deps import require_owner
from api.locks import session_lock
from db.database import SessionLocal
from db.models import Session as DBSession
from rag.client import get_collection
from rag.indexer import index_file

router = APIRouter()

UPLOAD_DIR = os.getenv("UPLOAD_DIR", "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

ALLOWED_EXTENSIONS = {".pdf", ".docx", ".txt", ".csv"}

MAX_FILE_BYTES = 25 * 1024 * 1024          # 25 MB per file
MAX_SESSION_BYTES = 50 * 1024 * 1024       # 50 MB total per session
CHUNK_SIZE = 64 * 1024


def _unique_dest(dirpath: str, filename: str) -> tuple[str, str]:
    """Return (final_filename, full_path) avoiding collisions via _2, _3 suffix."""
    base = os.path.basename(filename) or "file"
    stem, ext = os.path.splitext(base)
    candidate = base
    i = 2
    while os.path.exists(os.path.join(dirpath, candidate)):
        candidate = f"{stem}_{i}{ext}"
        i += 1
    return candidate, os.path.join(dirpath, candidate)


async def _stream_to_disk(file: UploadFile, dest: str, max_bytes: int) -> int:
    """Stream upload to disk chunk by chunk; abort and delete if max_bytes exceeded.

    Returns the total written size on success. Raises HTTPException(413) on overflow.
    """
    total = 0

    def _open():
        return open(dest, "wb")

    fh = await asyncio.to_thread(_open)
    try:
        while True:
            chunk = await file.read(CHUNK_SIZE)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                await asyncio.to_thread(fh.close)
                await asyncio.to_thread(_safe_unlink, dest)
                raise HTTPException(
                    status_code=413,
                    detail=f"File exceeds {max_bytes // (1024 * 1024)} MB limit",
                )
            await asyncio.to_thread(fh.write, chunk)
    finally:
        if not fh.closed:
            await asyncio.to_thread(fh.close)
    return total


def _safe_unlink(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass


@router.post("/upload/{session_id}")
async def upload_file(
    session_id: str,
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    _owner: DBSession = Depends(require_owner),
):
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"Unsupported file type: {ext}")

    # Pre-check: how much room is left for this session.
    async with session_lock(session_id):
        async with SessionLocal() as db:
            result = await db.execute(select(DBSession).where(DBSession.id == session_id))
            row = result.scalar_one_or_none()
            if not row:
                raise HTTPException(status_code=404, detail="Session not found")
            sources = ((row.state or {}).get("context") or {}).get("sources") or []
            used = sum(int(s.get("size") or 0) for s in sources)

    remaining = MAX_SESSION_BYTES - used
    if remaining <= 0:
        raise HTTPException(
            status_code=413,
            detail=f"Session upload quota exceeded ({MAX_SESSION_BYTES // (1024 * 1024)} MB total)",
        )

    per_file_cap = min(MAX_FILE_BYTES, remaining)
    session_dir = os.path.join(UPLOAD_DIR, session_id)
    os.makedirs(session_dir, exist_ok=True)
    final_name, dest = _unique_dest(session_dir, file.filename or "file")

    size = await _stream_to_disk(file, dest, per_file_cap)

    # Persist source record FIRST — before indexing — so a concurrent DELETE
    # can find this file and so the handler is no longer holding the response
    # open during the slow Chroma index step. Indexing then runs in a
    # BackgroundTask after the 200 has been sent.
    async with session_lock(session_id):
        async with SessionLocal() as db:
            result = await db.execute(select(DBSession).where(DBSession.id == session_id))
            row = result.scalar_one_or_none()
            if not row:
                # Session was deleted between checks — clean up file we wrote.
                await asyncio.to_thread(_safe_unlink, dest)
                raise HTTPException(status_code=404, detail="Session not found")

            state = dict(row.state or {})
            ctx_sources = state.setdefault("context", {}).setdefault("sources", [])
            current_used = sum(int(s.get("size") or 0) for s in ctx_sources)
            if current_used + size > MAX_SESSION_BYTES:
                # Concurrent upload squeezed in and used the remaining budget.
                await asyncio.to_thread(_safe_unlink, dest)
                raise HTTPException(
                    status_code=413,
                    detail=f"Session upload quota exceeded ({MAX_SESSION_BYTES // (1024 * 1024)} MB total)",
                )
            ctx_sources.append({
                "name": final_name,
                "original_name": file.filename,
                "path": dest,
                "size": size,
                "status": "indexing",
            })
            row.state = state
            # shallow-copy of state shares nested objects with row.state, so
            # SQLAlchemy's attribute history sees no change after the append.
            # flag_modified forces the JSON column to be written.
            flag_modified(row, "state")
            await db.commit()

    background_tasks.add_task(_index_and_mark_done, session_id, dest, final_name)

    return {"filename": final_name, "size": size, "status": "queued"}


async def _index_and_mark_done(session_id: str, dest: str, final_name: str) -> None:
    """Run RAG indexing for an already-recorded upload and flip its status.

    Runs as a FastAPI BackgroundTask after the upload response has been
    returned. Errors here do not affect the upload's HTTP result — they are
    logged and the source's status flips to "index_failed".
    """
    import logging
    log = logging.getLogger(__name__)
    new_status = "indexed"
    try:
        await index_file(session_id, dest)
    except Exception:
        log.exception("Indexing failed for session=%s file=%s", session_id, final_name)
        new_status = "index_failed"

    async with session_lock(session_id):
        async with SessionLocal() as db:
            result = await db.execute(select(DBSession).where(DBSession.id == session_id))
            row = result.scalar_one_or_none()
            if not row:
                return
            state = dict(row.state or {})
            sources = (state.get("context") or {}).get("sources") or []
            for s in sources:
                if s.get("name") == final_name:
                    s["status"] = new_status
                    break
            row.state = state
            flag_modified(row, "state")
            await db.commit()


def _delete_from_chroma(session_id: str, source_name: str) -> None:
    """Remove all chunks whose metadata.source matches source_name."""
    collection = get_collection(session_id)
    found = collection.get(where={"source": source_name})
    ids = found.get("ids") or []
    if ids:
        collection.delete(ids=ids)


@router.delete("/upload/{session_id}/{filename:path}")
async def delete_file(
    session_id: str,
    filename: str,
    _owner: DBSession = Depends(require_owner),
):
    async with session_lock(session_id):
        async with SessionLocal() as db:
            result = await db.execute(select(DBSession).where(DBSession.id == session_id))
            row = result.scalar_one_or_none()
            if not row:
                raise HTTPException(status_code=404, detail="Session not found")

            state = dict(row.state or {})
            # Only allow deletion while the user is on the ContextUploadScreen.
            # Once advanced past it, sources have been fed into the RAG analysis
            # and downstream stages already reference them.
            if state.get("stage") != "context":
                raise HTTPException(
                    status_code=409,
                    detail="Deletion allowed only on the context upload step",
                )

            ctx = state.setdefault("context", {})
            sources = ctx.setdefault("sources", [])
            match = next((s for s in sources if s.get("name") == filename), None)
            if not match:
                raise HTTPException(status_code=404, detail="File not found")

            # Resolve and guard the on-disk path against traversal: it must
            # resolve to a file inside this session's upload directory.
            session_dir = os.path.realpath(os.path.join(UPLOAD_DIR, session_id))
            target = os.path.realpath(match.get("path") or os.path.join(session_dir, filename))
            if not target.startswith(session_dir + os.sep):
                raise HTTPException(status_code=400, detail="Invalid file path")

            await asyncio.to_thread(_safe_unlink, target)
            await asyncio.to_thread(_delete_from_chroma, session_id, filename)

            ctx["sources"] = [s for s in sources if s.get("name") != filename]
            row.state = state
            flag_modified(row, "state")
            await db.commit()

    return {"status": "deleted", "filename": filename}
