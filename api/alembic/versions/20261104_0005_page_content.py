"""Page content as Tiptap JSON (T09).

Revision ID: 0005
Revises: 0004
Create Date: 2026-11-04 23:44:26.398156
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0005"
down_revision: str | Sequence[str] | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "page_content",
        sa.Column("page_id", sa.Uuid(), nullable=False),
        sa.Column("doc", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("updated_by", sa.Uuid(), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("clock_timestamp()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["page_id"], ["pages.id"], name=op.f("fk_page_content_page_id_pages"), ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["updated_by"], ["users.id"], name=op.f("fk_page_content_updated_by_users"), ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("page_id", name=op.f("pk_page_content")),
    )


def downgrade() -> None:
    op.drop_table("page_content")
