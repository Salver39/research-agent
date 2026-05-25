"""users, magic_link_tokens, sessions.user_id FK

Revision ID: 0002_users_magic_link
Revises: 0001_baseline
Create Date: 2026-05-25
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0002_users_magic_link"
down_revision: Union[str, None] = "0001_baseline"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("email", sa.String(), nullable=False),
        sa.Column("auth_token", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.UniqueConstraint("email", name="uq_users_email"),
        sa.UniqueConstraint("auth_token", name="uq_users_auth_token"),
    )
    op.create_index("ix_users_email", "users", ["email"], unique=True)
    op.create_index("ix_users_auth_token", "users", ["auth_token"], unique=True)

    op.create_table(
        "magic_link_tokens",
        sa.Column("token", sa.String(), primary_key=True),
        sa.Column("email", sa.String(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("consumed_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_magic_link_tokens_email", "magic_link_tokens", ["email"])

    with op.batch_alter_table("sessions") as batch_op:
        batch_op.add_column(sa.Column("user_id", sa.String(), nullable=True))
        batch_op.create_foreign_key(
            "fk_sessions_user_id_users",
            "users",
            ["user_id"],
            ["id"],
        )
        batch_op.create_index("ix_sessions_user_id", ["user_id"])


def downgrade() -> None:
    with op.batch_alter_table("sessions") as batch_op:
        batch_op.drop_index("ix_sessions_user_id")
        batch_op.drop_constraint("fk_sessions_user_id_users", type_="foreignkey")
        batch_op.drop_column("user_id")

    op.drop_index("ix_magic_link_tokens_email", table_name="magic_link_tokens")
    op.drop_table("magic_link_tokens")

    op.drop_index("ix_users_auth_token", table_name="users")
    op.drop_index("ix_users_email", table_name="users")
    op.drop_table("users")
