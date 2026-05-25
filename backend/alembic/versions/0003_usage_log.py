"""usage_log table for kill-switch budget tracking

Revision ID: 0003_usage_log
Revises: 0002_users_magic_link
Create Date: 2026-05-25
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0003_usage_log"
down_revision: Union[str, None] = "0002_users_magic_link"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "usage_log",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("model", sa.String(), nullable=False),
        sa.Column("prompt_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("completion_tokens", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_index("ix_usage_log_created_at", "usage_log", ["created_at"])


def downgrade() -> None:
    op.drop_index("ix_usage_log_created_at", table_name="usage_log")
    op.drop_table("usage_log")
