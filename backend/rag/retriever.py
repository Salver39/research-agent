"""Query the Chroma vector store for relevant passages."""

from __future__ import annotations

import asyncio
from typing import List

from rag.client import get_collection


def _query_collection(session_id: str, query: str, n_results: int) -> List[dict]:
    collection = get_collection(session_id)
    count = collection.count()
    actual_n = min(n_results, count)
    if actual_n == 0:
        return []
    results = collection.query(query_texts=[query], n_results=actual_n)
    docs = results.get("documents", [[]])[0]
    metas = results.get("metadatas", [[]])[0]
    return [{"text": d, "source": m.get("source", "")} for d, m in zip(docs, metas)]


async def retrieve(session_id: str, query: str, n_results: int = 5) -> List[dict]:
    return await asyncio.to_thread(_query_collection, session_id, query, n_results)
