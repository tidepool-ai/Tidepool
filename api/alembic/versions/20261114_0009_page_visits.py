"""Recently opened pages, for the command bar (T22).

Revision ID: 0009
Revises: 0008
Create Date: 2026-11-14 10:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0009"
down_revision: str | Sequence[str] | None = "0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "page_visits",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("page_id", sa.Uuid(), nullable=False),
        sa.Column(
            "visited_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("clock_timestamp()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_page_visits_user_id_users"), ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["page_id"], ["pages.id"], name=op.f("fk_page_visits_page_id_pages"), ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("user_id", "page_id", name=op.f("pk_page_visits")),
    )
    op.create_index(op.f("ix_page_visits_visited_at"), "page_visits", ["visited_at"])
    # Title search (ILIKE '%…%') uses a trigram index.
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    op.execute("CREATE INDEX ix_pages_title_trgm ON pages USING gin (lower(title) gin_trgm_ops)")


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_pages_title_trgm")
    op.drop_index(op.f("ix_page_visits_visited_at"), table_name="page_visits")
    op.drop_table("page_visits")
