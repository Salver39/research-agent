from __future__ import annotations

import asyncio
import json
import logging
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException

logger = logging.getLogger(__name__)
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select

from agents.base import _clean_json_text
from api.deps import require_owner
from api.locks import session_lock
from db.database import SessionLocal
from db.models import Session as DBSession
from orchestrator import Orchestrator

# Top-level state keys the stream is allowed to overwrite when merging back.
# Anything else (e.g. context.sources mutated by /upload) is preserved as-is.
_STREAM_OWNED_KEYS = {"stage", "brief", "hypotheses", "method", "method_plan", "sample", "design", "diagnosis"}
# context sub-keys owned by the stream (the rest of `context` survives the merge)
_STREAM_OWNED_CONTEXT_KEYS = {"patterns", "summary", "available_sources", "rag_fragments"}

router = APIRouter()


class StreamRequest(BaseModel):
    user_input: str


class AdvanceRequest(BaseModel):
    brief: Optional[dict] = None
    method_patch: Optional[dict] = None
    hypotheses: Optional[list] = None


@router.post("/stream/{session_id}")
async def stream_agent(
    session_id: str,
    body: StreamRequest,
    db_session: DBSession = Depends(require_owner),
):
    # Snapshot under the lock — guarantees we see the latest committed state
    # produced by any preceding advance/retreat/upload on the same session.
    async with session_lock(session_id):
        state = dict(db_session.state)

    orchestrator = Orchestrator(state)
    full_response: list[str] = []

    # Heartbeat — a reasoning model (gpt-5.5) on a long prompt can take 100-300s
    # before the first chunk. Without keep-alive bytes the client side cannot
    # distinguish "model is thinking" from "backend is hung" and is forced into
    # generous static timeouts. With a 20s heartbeat the client can run a
    # tight idle timer (~60s) and report a real hang within ~a minute.
    HEARTBEAT_INTERVAL_S = 20.0
     # SSE comment, ignored by spec-compliant clients. Padded to ~2KB to defeat
    # Chrome fetch-reader's small-chunk buffering on reasoning-only phases.
    HEARTBEAT_LINE = ": keepalive " + (" " * 2048) + "\n\n"

    async def event_generator():
        queue: asyncio.Queue = asyncio.Queue()
        _DONE = object()

        async def produce_chunks():
            try:
                async for chunk in orchestrator.stream(body.user_input):
                    await queue.put(("data", chunk))
            except Exception as e:
                logger.exception("Agent stream error for session %s", session_id)
                await queue.put(("error", str(e)))
            finally:
                await queue.put(("end", _DONE))

        async def heartbeat():
            try:
                while True:
                    await asyncio.sleep(HEARTBEAT_INTERVAL_S)
                    await queue.put(("ping", None))
            except asyncio.CancelledError:
                pass

        producer = asyncio.create_task(produce_chunks())
        hb = asyncio.create_task(heartbeat())

        try:
            while True:
                kind, payload = await queue.get()
                if kind == "data":
                    full_response.append(payload)
                    yield f"data: {json.dumps(payload)}\n\n"
                elif kind == "ping":
                    yield HEARTBEAT_LINE
                elif kind == "error":
                    yield f"data: [ERROR] {json.dumps(payload)}\n\n"
                    return
                elif kind == "end":
                    break

            hb.cancel()

            logger.info("Agent stream finished, %d chunks, %d chars", len(full_response), sum(len(c) for c in full_response))
            _persist_agent_output(orchestrator.state, "".join(full_response), body.user_input)
            logger.info("State persisted")

            # Merge-write: re-read fresh DB state and overlay only the keys the
            # orchestrator owns, so a concurrent upload/advance doesn't get lost.
            async with session_lock(session_id):
                async with SessionLocal() as db:
                    result = await db.execute(select(DBSession).where(DBSession.id == session_id))
                    row = result.scalar_one_or_none()
                    if row:
                        merged = _merge_stream_state(dict(row.state or {}), orchestrator.state)
                        row.state = merged
                        await db.commit()
            logger.info("DB committed, sending [DONE]")

            yield "data: [DONE]\n\n"
        except Exception as e:
            logger.exception("Stream pipeline error for session %s", session_id)
            yield f"data: [ERROR] {json.dumps(str(e))}\n\n"
        finally:
            hb.cancel()
            producer.cancel()

    return StreamingResponse(event_generator(), media_type="text/event-stream")


def _merge_stream_state(fresh: dict, after_stream: dict) -> dict:
    """Overlay stream-owned keys from `after_stream` onto fresh DB state."""
    merged = dict(fresh)
    for key in _STREAM_OWNED_KEYS:
        if key in after_stream:
            merged[key] = after_stream[key]

    # context: keep fresh.sources etc., overlay only stream-owned sub-keys
    fresh_ctx = dict(fresh.get("context") or {})
    stream_ctx = after_stream.get("context") or {}
    for key in _STREAM_OWNED_CONTEXT_KEYS:
        if key in stream_ctx:
            fresh_ctx[key] = stream_ctx[key]
    merged["context"] = fresh_ctx
    return merged


@router.post("/session/{session_id}/retreat")
async def retreat_stage(
    session_id: str,
    _owner: DBSession = Depends(require_owner),
):
    async with session_lock(session_id):
        async with SessionLocal() as db:
            result = await db.execute(select(DBSession).where(DBSession.id == session_id))
            row = result.scalar_one_or_none()
            if not row:
                raise HTTPException(status_code=404, detail="Session not found")
            state = dict(row.state or {})
            orch = Orchestrator(state)
            new_stage = orch.retreat()
            row.state = orch.state
            await db.commit()
    return {"stage": new_stage}


@router.post("/session/{session_id}/advance")
async def advance_stage(
    session_id: str,
    body: AdvanceRequest = AdvanceRequest(),
    _owner: DBSession = Depends(require_owner),
):
    async with session_lock(session_id):
        async with SessionLocal() as db:
            result = await db.execute(select(DBSession).where(DBSession.id == session_id))
            row = result.scalar_one_or_none()
            if not row:
                raise HTTPException(status_code=404, detail="Session not found")
            state = dict(row.state or {})
            if body.brief:
                state["brief"] = body.brief
            if body.method_patch:
                if not isinstance(state.get("method"), dict):
                    state["method"] = {}
                patch = body.method_patch
                prev_key = state["method"].get("method_key") if isinstance(state.get("method"), dict) else None
                # If the patch points at a method_key from the plan, replace the
                # active method entirely with that planned method (keeps full
                # description in sync). Otherwise merge as before.
                plan = state.get("method_plan") or {}
                planned = plan.get("methods") if isinstance(plan, dict) else None
                if isinstance(planned, list) and patch.get("method_key"):
                    match = next(
                        (m for m in planned if m.get("method_key") == patch["method_key"] and m.get("name") == patch.get("name", m.get("name"))),
                        None,
                    )
                    if match is None:
                        match = next(
                            (m for m in planned if m.get("method_key") == patch["method_key"]),
                            None,
                        )
                    if match is not None:
                        state["method"] = {**match}
                    else:
                        state["method"].update(patch)
                else:
                    state["method"].update(patch)
                # When the active method actually changes, downstream artefacts
                # (sample, design) belong to the previous method and must be
                # discarded — otherwise sampling / design screens render stale
                # data until the new stream completes.
                new_key = state["method"].get("method_key") if isinstance(state["method"], dict) else None
                if new_key and prev_key and new_key != prev_key:
                    state["sample"] = None
                    state["design"] = None
            if body.hypotheses is not None:
                state["hypotheses"] = body.hypotheses

            orch = Orchestrator(state)
            new_stage = orch.advance()
            row.state = orch.state
            await db.commit()
    return {"stage": new_stage}


def _persist_agent_output(state: dict, raw: str, user_input: str = ""):
    try:
        data = json.loads(_clean_json_text(raw))
    except Exception:
        logger.warning("persist: JSON parse failed at stage=%s; raw[:300]=%r", state.get("stage"), raw[:300])
        return
    stage = state.get("stage", "")
    if stage == "clarify" and "summary" in data:
        state["diagnosis"] = data
        state.setdefault("context", {})["available_sources"] = state.get("diagnosis", {}).get("available_sources", [])
    elif stage in ("intake", "brief") and data.get("research_question"):
        state["brief"] = data
    elif stage == "context" and "patterns" in data:
        state.setdefault("context", {})["patterns"] = data["patterns"]
        state["context"]["summary"] = data.get("summary", "")
    elif stage == "hypothesis" and "hypotheses" in data:
        # Newly generated hypotheses arrive unselected (priority=0). The user
        # picks which ones to verify on the wizard screen; the choice is sent
        # back on /advance and overwrites this default.
        # source_type is shown as a coloured badge in the UI — only meaningful
        # when the hypothesis is grounded in an uploaded document. Drop
        # 'expert' and anything outside the file-backed vocabulary even if
        # the model still emits it.
        _FILE_BACKED_SOURCES = {"analytics", "feedback", "past_research", "benchmark"}
        fresh = []
        for h in data["hypotheses"]:
            if not isinstance(h, dict):
                continue
            h = {**h, "priority": 0}
            if h.get("source_type") not in _FILE_BACKED_SOURCES:
                h.pop("source_type", None)
            fresh.append(h)
        if user_input == "append":
            existing = state.get("hypotheses") or []
            state["hypotheses"] = existing + fresh
        else:
            state["hypotheses"] = fresh
    elif stage == "method":
        # Tolerant parsing — LLMs sometimes wrap the plan in an extra key, return
        # a bare array, or omit `name` on a single method.
        methods_list: list | None = None
        plan_obj: dict | None = None
        if isinstance(data, list):
            methods_list = data
            plan_obj = {"methods": data}
        elif isinstance(data, dict):
            if isinstance(data.get("methods"), list) and data["methods"]:
                methods_list = data["methods"]
                plan_obj = data
            else:
                # Unwrap one level if model nested under an extra key
                for k in ("plan", "method_plan", "research_plan", "research_methods"):
                    v = data.get(k)
                    if isinstance(v, dict) and isinstance(v.get("methods"), list) and v["methods"]:
                        methods_list = v["methods"]
                        plan_obj = v
                        break
                    if isinstance(v, list) and v and isinstance(v[0], dict):
                        methods_list = v
                        plan_obj = {"methods": v}
                        break

        if methods_list and plan_obj is not None:
            state["method_plan"] = plan_obj
            primary_key = plan_obj.get("primary_method_key")
            # Prefer a method we can actually drive end-to-end (sampling +
            # design agent exist for it). Falls back to whatever the model
            # said is primary, or the first listed method, so we never end
            # up without an active method.
            supported_keys = {"deep_interviews", "usability_testing", "survey"}
            supported = [m for m in methods_list if isinstance(m, dict) and m.get("method_key") in supported_keys]
            primary = next((m for m in supported if m.get("method_key") == primary_key), None)
            if primary is None and supported:
                primary = supported[0]
            if primary is None:
                primary = next((m for m in methods_list if isinstance(m, dict) and m.get("method_key") == primary_key), None)
            if primary is None:
                primary = next((m for m in methods_list if isinstance(m, dict)), None)
            if primary:
                state["method"] = primary
        elif isinstance(data, dict) and ("name" in data or "method_key" in data):
            state["method"] = data
            state["method_plan"] = {
                "methods": [{**data, "order": 1, "phase": data.get("phase", "qualitative")}],
                "primary_method_key": data.get("method_key"),
                "sequence_rationale": "Достаточно одного метода для проверки выбранных гипотез.",
            }
        else:
            logger.warning(
                "persist: method stage — unmatched output. type=%s keys=%s raw[:400]=%r",
                type(data).__name__,
                list(data.keys()) if isinstance(data, dict) else None,
                raw[:400],
            )
    elif stage == "sampling" and "segments" in data:
        # Survey method owns its own screener block inside the questionnaire
        # (DesignSurveyAgent emits it). Drop any screener returned here so the
        # UI doesn't show duplicate screener questions on the sampling screen.
        active_method = state.get("method") or {}
        if active_method.get("method_key") == "survey":
            data["screener"] = []
        state["sample"] = data
    elif stage == "design" and ("guide_blocks" in data or "tasks" in data or "pre_interview" in data or "main_blocks" in data):
        state["design"] = data
