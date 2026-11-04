"""Workspaces and members; backfill a personal workspace for existing users.

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-04 18:17:54.347059
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003"
down_revision: str | Sequence[str] | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "workspaces",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("owner_id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["owner_id"], ["users.id"], name=op.f("fk_workspaces_owner_id_users"), ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_workspaces")),
    )
    op.create_index(op.f("ix_workspaces_owner_id"), "workspaces", ["owner_id"], unique=False)
    op.create_table(
        "members",
        sa.Column("workspace_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("role", sa.String(length=16), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("role IN ('owner', 'admin', 'member', 'guest')", name=op.f("ck_members_role")),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_members_user_id_users"), ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["workspace_id"],
            ["workspaces.id"],
            name=op.f("fk_members_workspace_id_workspaces"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("workspace_id", "user_id", name=op.f("pk_members")),
    )
    op.create_index(op.f("ix_members_user_id"), "members", ["user_id"], unique=False)

    # Users who signed in before workspaces existed get the personal workspace new users get.
    op.execute(
        """
        WITH created AS (
            INSERT INTO workspaces (id, name, owner_id)
            SELECT gen_random_uuid(), left(split_part(email, '@', 1), 80) || '''s workspace', id
            FROM users
            RETURNING id, owner_id
        )
        INSERT INTO members (workspace_id, user_id, role)
        SELECT id, owner_id, 'owner' FROM created
        """
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_members_user_id"), table_name="members")
    op.drop_table("members")
    op.drop_index(op.f("ix_workspaces_owner_id"), table_name="workspaces")
    op.drop_table("workspaces")
