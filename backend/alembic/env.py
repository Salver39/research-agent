"""Alembic env for async SQLAlchemy + SQLite.

`render_as_batch=True` is required so ALTER TABLE ops (add column, etc.) work
on SQLite, which only supports a subset of ALTER. Alembic batch mode rewrites
the table behind the scenes.
"""
from __future__ import annotations

import asyncio
import os
from logging.config import fileConfig

from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import async_engine_from_config

from alembic import context

from db.database import Base
from db import models  # noqa: F401 — registers tables on Base.metadata

config = context.config

db_url = os.getenv("DATABASE_URL", "sqlite+aiosqlite:///./research_agent.db")
config.set_main_option("sqlalchemy.url", db_url)

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def do_run_migrations(connection: Connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        render_as_batch=True,
    )
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await connectable.dispose()


if context.is_offline_mode():
    raise RuntimeError("Offline mode is not supported — use online mode with DATABASE_URL")
else:
    asyncio.run(run_async_migrations())
