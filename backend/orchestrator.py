"""
State machine that routes between agents based on current session stage.
All state is passed explicitly — the LLM has no memory between calls.
"""

from __future__ import annotations

import logging
from typing import Any, AsyncIterator

logger = logging.getLogger(__name__)

from agents.brief import BriefAgent
from agents.context import ContextAgent
from agents.hypothesis import HypothesisAgent
from agents.method import MethodAgent
from agents.sampling import SamplingAgent
from agents.design import DesignAgent
from agents.design_interviews import DesignInterviewsAgent
from agents.design_usability import DesignUsabilityAgent
from agents.design_survey import DesignSurveyAgent

STAGE_ORDER = [
    "intake",
    "clarify",
    "brief",
    "context",
    "hypothesis",
    "method",
    "sampling",
    "design",
    "done",
]

# Stages never shown in the UI — skipped when retreating
_SKIP_ON_RETREAT = {"brief"}


def next_stage(current: str) -> str:
    try:
        idx = STAGE_ORDER.index(current)
        return STAGE_ORDER[idx + 1]
    except (ValueError, IndexError):
        return "done"


def prev_stage(current: str) -> str:
    try:
        idx = STAGE_ORDER.index(current)
        new_idx = idx - 1
        while new_idx > 0 and STAGE_ORDER[new_idx] in _SKIP_ON_RETREAT:
            new_idx -= 1
        return STAGE_ORDER[max(0, new_idx)]
    except ValueError:
        return STAGE_ORDER[0]


class Orchestrator:
    def __init__(self, state: dict[str, Any]):
        self.state = state

    async def stream(self, user_input: str) -> AsyncIterator[str]:
        stage = self.state.get("stage", "intake")

        # For context stage: run RAG first, inject results into state
        if stage == "context":
            await self._run_rag()

        agent = self._get_agent(stage)
        logger.debug("Stage=%s, agent=%s", stage, type(agent).__name__ if agent else None)
        if stage == "design":
            method_key = (self.state.get("method") or {}).get("method_key", "")
            hyp_count = len(self.state.get("hypotheses") or [])
            logger.debug("Design routing: method_key=%r, hypotheses=%d", method_key, hyp_count)
        if agent is None:
            yield f"[error] no agent for stage: {stage}"
            return

        async for chunk in agent.stream(self.state, user_input):
            yield chunk

    def advance(self) -> str:
        current = self.state.get("stage", "intake")
        self.state["stage"] = next_stage(current)
        return self.state["stage"]

    def retreat(self) -> str:
        current = self.state.get("stage", "intake")
        self.state["stage"] = prev_stage(current)
        return self.state["stage"]

    async def _run_rag(self):
        """Retrieve relevant fragments from vector store and attach to state."""
        from rag.retriever import retrieve

        session_id = self.state.get("session_id", "")
        brief = self.state.get("brief") or {}
        query = brief.get("research_question", "") or self.state.get("task", "")

        if not query:
            return

        try:
            fragments = await retrieve(session_id, query, n_results=6)
            ctx = self.state.setdefault("context", {})
            ctx["rag_fragments"] = fragments
        except (FileNotFoundError, ValueError, RuntimeError, OSError):
            pass

    def _get_design_agent(self):
        # Three design agents — intentional: each method emits a different JSON shape
        # that the frontend renders differently. Unifying them is risky without tests.
        method_key = (self.state.get("method") or {}).get("method_key", "")
        if method_key == "usability_testing":
            return DesignUsabilityAgent()
        if method_key == "deep_interviews":
            return DesignInterviewsAgent()
        if method_key == "survey":
            return DesignSurveyAgent()
        return DesignAgent()

    def _get_agent(self, stage: str):
        return {
            "intake":     BriefAgent(stage="intake"),
            "clarify":    BriefAgent(stage="diagnosis"),
            "brief":      BriefAgent(stage="brief"),
            "context":    ContextAgent(),
            "hypothesis": HypothesisAgent(),
            "method":     MethodAgent(),
            "sampling":   SamplingAgent(),
            "design":     self._get_design_agent(),
        }.get(stage)
