"""baseline: existing sessions table

Revision ID: 0001_baseline
Revises:
Create Date: 2026-05-25

Snapshot of the pre-Alembic schema. Run `alembic stamp 0001_baseline` on an
existing DB to mark this as already applied; fresh DBs get the table created
by `alembic upgrade head`.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0001_baseline"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "sessions",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("owner_token", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.Column("state", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("sessions")
