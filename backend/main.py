import logging
import os
from pathlib import Path
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent / ".env", override=True)

for _key in ("OPENAI_API_KEY", "OPENAI_MODEL", "OPENAI_MODEL_MINI"):
    if not os.environ.get(_key):
        raise RuntimeError(f"{_key} is not set — check backend/.env")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api import auth, session, stream, upload, download, validate

app = FastAPI(title="Research Agent API", version="0.1.0")

_origins = [o.strip() for o in os.getenv("CORS_ORIGINS", "http://localhost:3000").split(",")]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router,    prefix="/api")
app.include_router(session.router, prefix="/api")
app.include_router(stream.router,  prefix="/api")
app.include_router(upload.router,  prefix="/api")
app.include_router(download.router, prefix="/api")
app.include_router(validate.router, prefix="/api")


@app.get("/")
async def root():
    return {"message": "Research Agent API is running", "version": "0.1.0"}


@app.get("/health")
async def health():
    return {"status": "ok"}
