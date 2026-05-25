"""Shared Chroma client for indexer and retriever."""

from __future__ import annotations

import os

CHROMA_PERSIST_DIR = os.getenv("CHROMA_PERSIST_DIR", "./chroma_db")


def get_collection(session_id: str):
    import chromadb
    from chromadb.config import Settings
    # ANONYMIZED_TELEMETRY env var ignored by chromadb 0.5.23 — disable explicitly.
    # PostHog SDK incompatibility raises TypeError inside telemetry; in a FastAPI
    # BackgroundTask this can take down the whole worker silently.
    client = chromadb.PersistentClient(
        path=CHROMA_PERSIST_DIR,
        settings=Settings(anonymized_telemetry=False),
    )
    return client.get_or_create_collection(name=f"session_{session_id}")
