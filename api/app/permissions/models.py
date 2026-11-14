"""Page sharing (T21): access levels given to people, inherited down the page tree."""

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.workspaces.models import CREATED_AT_DEFAULT

LEVELS = ("view", "comment", "edit", "full")


class PagePermission(Base):
    """A person's access to a page and (unless overridden further down) everything under it."""

    __tablename__ = "page_permissions"
    __table_args__ = (CheckConstraint(f"level IN {LEVELS}", name="level"),)

    page_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("pages.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, index=True
    )
    level: Mapped[str] = mapped_column(String(16))
    invited_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=CREATED_AT_DEFAULT)
