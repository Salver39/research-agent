"""Base class shared by all agents. Streams responses via OpenAI."""

from __future__ import annotations

import logging
import os
import re
from abc import ABC, abstractmethod
from typing import Any, AsyncIterator

from openai import AsyncOpenAI

logger = logging.getLogger(__name__)


def selected_hypotheses(state: dict[str, Any]) -> list[dict]:
    """Hypotheses the user marked for verification on the wizard screen.

    Downstream agents (method, sampling, design) and doc generation must work
    only with selected ones — unselected hypotheses live in state but are out
    of scope for this research.
    """
    hyps = state.get("hypotheses") or []
    return [h for h in hyps if isinstance(h, dict) and h.get("priority") == 1]


def hypotheses_for_method(state: dict[str, Any]) -> tuple[list[dict], list[dict]]:
    """Split selected hypotheses by whether the active method can verify them.

    Each hypothesis carries `verification_methods` (list of method keys from
    the Hypothesis agent vocabulary). The design agent for the active method
    must only build blocks for hypotheses that explicitly list the active
    method_key — otherwise the scenario covers questions the method cannot
    answer.

    Returns (in_scope, out_of_scope). If a hypothesis has no
    `verification_methods` set, it is included in in_scope by default
    (legacy compatibility — don't drop hypotheses silently when the tag is
    missing).
    """
    selected = selected_hypotheses(state)
    active = state.get("method") or {}
    method_key = active.get("method_key") if isinstance(active, dict) else None
    if not method_key:
        return selected, []
    in_scope: list[dict] = []
    out_of_scope: list[dict] = []
    for h in selected:
        methods = h.get("verification_methods") or []
        if not isinstance(methods, list) or not methods:
            in_scope.append(h)
            continue
        if method_key in methods:
            in_scope.append(h)
        else:
            out_of_scope.append(h)
    return in_scope, out_of_scope


def _get_client() -> AsyncOpenAI:
    # Fresh client per call: a module-level singleton was tried in iter 8 to share
    # the httpx pool across the (then-parallel) design fan-out. After the fan-out
    # was removed, the singleton stayed and started hanging the design step
    # indefinitely on gpt-5.5 — `await chat.completions.create()` would never
    # return even though the same call from a fresh client returns in ~25-65s.
    # Empirically reproduced 2026-05-13: singleton = 8-min timeout, fresh = 133s OK.
    # Root mechanism (httpx pool / asyncio loop binding) not fully diagnosed.
    # If reintroducing a singleton, verify on full design wizard end-to-end first.
    api_key = os.environ.get("OPENAI_API_KEY", "")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not set")
    # 600s — reasoning models (gpt-5.5) on long prompts (design step on 10+
    # hypotheses) take 100–300s before the first token. 240s was occasionally
    # cutting off legitimate generations. Frontend has a matching first-byte
    # window of 480s in useSSE.ts.
    return AsyncOpenAI(api_key=api_key, timeout=600.0, max_retries=0)


def _clean_json_text(raw: str) -> str:
    return re.sub(r"^```(?:json)?\s*", "", raw.strip(), flags=re.IGNORECASE).rstrip("`").strip()


class BaseAgent(ABC):
    @property
    @abstractmethod
    def system_prompt(self) -> str: ...

    @abstractmethod
    def build_messages(self, state: dict[str, Any], user_input: str) -> list[dict]: ...

    def _model(self) -> str:
        return os.environ["OPENAI_MODEL"]

    def _max_tokens(self) -> int:
        # Ceiling, not target — OpenAI bills only generated tokens. 2048 was too
        # tight for ContextAgent / MethodAgent on long prompts: JSON got cut
        # mid-structure (finish_reason="length") and persist crashed on parse.
        return 8192

    async def stream(self, state: dict[str, Any], user_input: str) -> AsyncIterator[str]:
        client = _get_client()
        messages = [
            {"role": "system", "content": self.system_prompt},
            *self.build_messages(state, user_input),
        ]
        model = self._model()
        response = await client.chat.completions.create(
            model=model,
            messages=messages,
            max_completion_tokens=self._max_tokens(),
            stream=True,
            stream_options={"include_usage": True},
        )
        finish_reason: str | None = None
        async for chunk in response:
            if chunk.choices:
                choice = chunk.choices[0]
                if choice.finish_reason:
                    finish_reason = choice.finish_reason
                if choice.delta and choice.delta.content:
                    yield choice.delta.content
            if chunk.usage:
                logger.info(
                    "openai_call agent=%s model=%s prompt=%d completion=%d finish=%s",
                    type(self).__name__, model,
                    chunk.usage.prompt_tokens, chunk.usage.completion_tokens,
                    finish_reason or "?",
                )
                from db.usage import log_usage
                await log_usage(model, chunk.usage.prompt_tokens, chunk.usage.completion_tokens)
