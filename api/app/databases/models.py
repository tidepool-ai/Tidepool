"""Databases (T16, FR-11 to FR-13): a page with a property schema, whose rows are pages."""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, ForeignKey, Integer, String, Uuid, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class Database(Base):
    __tablename__ = "databases"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    # The database's own page (its title, place in the tree, trash state). Rows are its children.
    page_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("pages.id", ondelete="CASCADE"), unique=True)
    # {"properties": [property definitions]} (app/databases/properties.py)
    schema: Mapped[dict[str, Any]] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.clock_timestamp()
    )

    @property
    def properties(self) -> list[dict[str, Any]]:
        return self.schema.get("properties", [])


class DatabaseView(Base):
    """A named way of looking at a database: layout plus filters, sorts, grouping, visible properties."""

    __tablename__ = "db_views"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    database_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("databases.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(100))
    layout: Mapped[str] = mapped_column(String(16))
    config: Mapped[dict[str, Any]] = mapped_column(JSONB)
    position: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.clock_timestamp()
    )
