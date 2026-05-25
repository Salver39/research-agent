FROM python:3.11-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    libpango-1.0-0 \
    libpangoft2-1.0-0 \
    libcairo2 \
    libgdk-pixbuf-2.0-0 \
    shared-mime-info \
    fonts-dejavu \
    fonts-noto \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN mkdir -p /data

ENV UPLOAD_DIR=/data/uploads \
    OUTPUT_DIR=/data/outputs \
    CHROMA_PERSIST_DIR=/data/chroma_db \
    DATABASE_URL=sqlite+aiosqlite:////data/research_agent.db \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

EXPOSE 8000

CMD ["sh", "-c", "alembic upgrade head && uvicorn main:app --host 0.0.0.0 --port 8000"]
