"""Pages tree (ltree paths).

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-04 18:28:15.808292
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0004"
down_revision: str | Sequence[str] | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


class Ltree(sa.types.UserDefinedType):
    """Defined here rather than imported, so this migration doesn't change when app code does."""

    cache_ok = True

    def get_col_spec(self, **_: object) -> str:
        return "LTREE"


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS ltree")
    op.create_table(
        "pages",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("workspace_id", sa.Uuid(), nullable=False),
        sa.Column("parent_id", sa.Uuid(), nullable=True),
        sa.Column("path", Ltree(), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("icon", sa.String(length=32), nullable=True),
        sa.Column("cover", sa.String(length=2048), nullable=True),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("clock_timestamp()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("clock_timestamp()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["created_by"], ["users.id"], name=op.f("fk_pages_created_by_users"), ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(
            ["parent_id"], ["pages.id"], name=op.f("fk_pages_parent_id_pages"), ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["workspace_id"],
            ["workspaces.id"],
            name=op.f("fk_pages_workspace_id_workspaces"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_pages")),
    )
    op.create_index("ix_pages_path", "pages", ["path"], unique=False, postgresql_using="gist")
    op.create_index("ix_pages_workspace_id_parent_id", "pages", ["workspace_id", "parent_id"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_pages_workspace_id_parent_id", table_name="pages")
    op.drop_index("ix_pages_path", table_name="pages", postgresql_using="gist")
    op.drop_table("pages")
    op.execute("DROP EXTENSION IF EXISTS ltree")
