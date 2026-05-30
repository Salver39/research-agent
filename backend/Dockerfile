FROM python:3.11-slim-bookworm

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

CMD ["sh", "-c", "echo '=== DIAG: mount ==='; mount | grep -E 'data|vol_' || echo 'NO /data mount line'; echo '=== DIAG: /data BEFORE alembic ==='; ls -la /data 2>&1; df -h /data 2>&1; echo '=== running alembic ==='; alembic upgrade head; echo '=== DIAG: /data AFTER alembic ==='; ls -la /data; df -h /data; echo '=== starting uvicorn ==='; exec uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
