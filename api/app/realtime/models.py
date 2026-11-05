"""Yjs document state per page (T14)."""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, LargeBinary, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class PageDoc(Base):
    """The page's merged Yjs state (an encoded update), as the realtime service last saved it."""

    __tablename__ = "page_docs"

    page_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("pages.id", ondelete="CASCADE"), primary_key=True)
    state: Mapped[bytes] = mapped_column(LargeBinary)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.clock_timestamp(), onupdate=func.clock_timestamp()
    )
