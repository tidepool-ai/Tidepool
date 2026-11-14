"""Pages form a tree per workspace. `path` is an ltree of page ids (hex) from the root down."""

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String, Uuid, func, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import UserDefinedType

from app.db import Base


class Ltree(UserDefinedType[str]):
    """Postgres ltree (extension). asyncpg reads and writes it as text."""

    cache_ok = True

    def get_col_spec(self, **_: object) -> str:
        return "LTREE"


def path_label(page_id: uuid.UUID) -> str:
    """ltree labels can't contain '-', so use the uuid's hex form."""
    return page_id.hex


class Page(Base):
    __tablename__ = "pages"
    __table_args__ = (
        Index("ix_pages_path", "path", postgresql_using="gist"),
        Index("ix_pages_workspace_id_parent_id", "workspace_id", "parent_id"),
        CheckConstraint(
            "general_access IS NULL OR general_access IN ('invited', 'workspace', 'public')",
            name="general_access",
        ),
        CheckConstraint(
            "general_level IS NULL OR general_level IN ('view', 'comment', 'edit', 'full')",
            name="general_level",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    workspace_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"))
    parent_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("pages.id", ondelete="CASCADE"))
    path: Mapped[str] = mapped_column(Ltree())
    title: Mapped[str] = mapped_column(String(200), default="")
    icon: Mapped[str | None] = mapped_column(String(32))
    cover: Mapped[str | None] = mapped_column(String(2048))
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    # Set when the page is a row of a database (T16); its parent is then the database's page.
    database_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("databases.id", ondelete="CASCADE"))
    # A row's property values, keyed by property id (see app/databases/properties.py).
    properties: Mapped[dict] = mapped_column(JSONB, server_default=text("'{}'::jsonb"), default=dict)
    # Who else can open it (T21): "invited", "workspace" or "public"; null inherits from the parent
    # (the top level defaults to "workspace"). `general_level` is what workspace members get.
    general_access: Mapped[str | None] = mapped_column(String(16))
    general_level: Mapped[str | None] = mapped_column(String(16))
    # clock_timestamp(): real write time, so sibling order is stable within one transaction.
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.clock_timestamp()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.clock_timestamp(), onupdate=func.clock_timestamp()
    )
    # `is_database` (does this page hold a database?) is added in app.databases.models.

    # The caller's access level, set by the access check (app.permissions.service); not stored.
    access = "full"


class PageContent(Base):
    """A page's document as Tiptap JSON (T09). Kept apart from `pages` so tree queries stay light.

    Last write wins for now; live collaborative editing (T14/T15) moves content to Yjs.
    """

    __tablename__ = "page_content"

    page_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("pages.id", ondelete="CASCADE"), primary_key=True)
    doc: Mapped[dict] = mapped_column(JSONB)
    updated_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.clock_timestamp(), onupdate=func.clock_timestamp()
    )
