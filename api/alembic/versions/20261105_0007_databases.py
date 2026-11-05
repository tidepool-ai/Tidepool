"""Databases, their views, and rows as pages with properties (T16).

Revision ID: 0007
Revises: 0006
Create Date: 2026-11-05 13:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0007"
down_revision: str | Sequence[str] | None = "0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "databases",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("page_id", sa.Uuid(), nullable=False),
        sa.Column("schema", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("clock_timestamp()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["page_id"], ["pages.id"], name=op.f("fk_databases_page_id_pages"), ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_databases")),
        sa.UniqueConstraint("page_id", name=op.f("uq_databases_page_id")),
    )
    op.create_table(
        "db_views",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("database_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("layout", sa.String(length=16), nullable=False),
        sa.Column("config", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("clock_timestamp()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["database_id"],
            ["databases.id"],
            name=op.f("fk_db_views_database_id_databases"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_db_views")),
    )
    op.create_index(op.f("ix_db_views_database_id"), "db_views", ["database_id"])
    op.add_column("pages", sa.Column("database_id", sa.Uuid(), nullable=True))
    op.add_column(
        "pages",
        sa.Column(
            "properties",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
    )
    op.create_foreign_key(
        op.f("fk_pages_database_id_databases"),
        "pages",
        "databases",
        ["database_id"],
        ["id"],
        ondelete="CASCADE",
    )
    # Rows of a database in creation order (the default sort, and the tie-breaker of every sort).
    op.create_index(
        "ix_pages_database_rows",
        "pages",
        ["database_id", "created_at", "id"],
        postgresql_where=sa.text("database_id IS NOT NULL"),
    )
    # "contains" filters on multi-select and person values.
    op.create_index(
        "ix_pages_properties",
        "pages",
        ["properties"],
        postgresql_using="gin",
        postgresql_ops={"properties": "jsonb_path_ops"},
    )


def downgrade() -> None:
    op.drop_index("ix_pages_properties", table_name="pages")
    op.drop_index("ix_pages_database_rows", table_name="pages")
    op.drop_constraint(op.f("fk_pages_database_id_databases"), "pages", type_="foreignkey")
    op.drop_column("pages", "properties")
    op.drop_column("pages", "database_id")
    op.drop_index(op.f("ix_db_views_database_id"), table_name="db_views")
    op.drop_table("db_views")
    op.drop_table("databases")
