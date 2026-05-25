"""Index uploaded files into a Chroma vector store."""

import asyncio
from pathlib import Path

from rag.client import get_collection


def _extract_text(path: str) -> str:
    ext = Path(path).suffix.lower()
    if ext == ".txt":
        return Path(path).read_text(errors="ignore")
    if ext == ".pdf":
        try:
            import pdfplumber
            with pdfplumber.open(path) as pdf:
                return "\n".join(p.extract_text() or "" for p in pdf.pages)
        except ImportError:
            return ""
    if ext == ".docx":
        try:
            from docx import Document
            doc = Document(path)
            return "\n".join(p.text for p in doc.paragraphs)
        except ImportError:
            return ""
    if ext == ".csv":
        return Path(path).read_text(errors="ignore")
    return ""


def _chunk(text: str, size: int = 500, overlap: int = 50) -> list[str]:
    words = text.split()
    chunks, i = [], 0
    while i < len(words):
        chunks.append(" ".join(words[i : i + size]))
        i += size - overlap
    return chunks


def _index_sync(session_id: str, file_path: str) -> None:
    text = _extract_text(file_path)
    if not text.strip():
        return
    chunks = _chunk(text)
    collection = get_collection(session_id)
    fname = Path(file_path).name
    collection.add(
        documents=chunks,
        ids=[f"{fname}_{i}" for i in range(len(chunks))],
        metadatas=[{"source": fname} for _ in chunks],
    )


async def index_file(session_id: str, file_path: str) -> None:
    await asyncio.to_thread(_index_sync, session_id, file_path)
