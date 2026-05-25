from __future__ import annotations

import os
import zipfile
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse

from api.deps import require_owner
from db.models import Session as DBSession
from documents.generator import generate_all

router = APIRouter()

OUTPUT_DIR = os.getenv("OUTPUT_DIR", "outputs")


@router.get("/download/{session_id}")
async def download_document(
    session_id: str,
    doc: Optional[str] = None,
    format: str = "docx",
    db_session: DBSession = Depends(require_owner),
):
    state = db_session.state
    output_dir = os.path.join(OUTPUT_DIR, session_id)
    os.makedirs(output_dir, exist_ok=True)

    if format == "zip":
        files = await generate_all(state, output_dir)
        zip_path = os.path.join(output_dir, "research_package.zip")
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            seen = set()
            for f in files:
                name = os.path.basename(f)
                if name not in seen and os.path.exists(f):
                    zf.write(f, name)
                    seen.add(name)
        return FileResponse(
            zip_path,
            filename="research_package.zip",
            media_type="application/zip",
        )

    if not doc:
        raise HTTPException(status_code=400, detail="doc parameter required")

    file_path = await generate_all(state, output_dir, doc_name=doc, fmt=format)
    if not file_path or not os.path.exists(file_path):
        if format == "pdf":
            raise HTTPException(
                status_code=503,
                detail="PDF generation unavailable — download .docx instead",
            )
        raise HTTPException(status_code=404, detail="Document not generated")

    return FileResponse(file_path, filename=os.path.basename(file_path))
