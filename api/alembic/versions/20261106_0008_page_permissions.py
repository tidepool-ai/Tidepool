"""Page sharing: people's access levels and each page's general access (T21).

Revision ID: 0008
Revises: 0007
Create Date: 2026-11-06 02:30:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0008"
down_revision: str | Sequence[str] | None = "0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "page_permissions",
        sa.Column("page_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("level", sa.String(length=16), nullable=False),
        sa.Column("invited_by", sa.Uuid(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("clock_timestamp()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "level IN ('view', 'comment', 'edit', 'full')", name=op.f("ck_page_permissions_level")
        ),
        sa.ForeignKeyConstraint(
            ["page_id"], ["pages.id"], name=op.f("fk_page_permissions_page_id_pages"), ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_page_permissions_user_id_users"), ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["invited_by"],
            ["users.id"],
            name=op.f("fk_page_permissions_invited_by_users"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("page_id", "user_id", name=op.f("pk_page_permissions")),
    )
    op.create_index(op.f("ix_page_permissions_user_id"), "page_permissions", ["user_id"])
    op.add_column("pages", sa.Column("general_access", sa.String(length=16), nullable=True))
    op.add_column("pages", sa.Column("general_level", sa.String(length=16), nullable=True))
    op.create_check_constraint(
        op.f("ck_pages_general_access"),
        "pages",
        "general_access IS NULL OR general_access IN ('invited', 'workspace', 'public')",
    )
    op.create_check_constraint(
        op.f("ck_pages_general_level"),
        "pages",
        "general_level IS NULL OR general_level IN ('view', 'comment', 'edit', 'full')",
    )


def downgrade() -> None:
    op.drop_constraint(op.f("ck_pages_general_level"), "pages", type_="check")
    op.drop_constraint(op.f("ck_pages_general_access"), "pages", type_="check")
    op.drop_column("pages", "general_level")
    op.drop_column("pages", "general_access")
    op.drop_index(op.f("ix_page_permissions_user_id"), table_name="page_permissions")
    op.drop_table("page_permissions")
