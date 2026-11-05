"""Loading and saving a page's Yjs state in `page_docs`."""

import logging
import uuid
from collections.abc import Callable
from contextlib import AbstractAsyncContextManager

from pycrdt import Doc
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.realtime.models import PageDoc

logger = logging.getLogger(__name__)

SessionFactory = Callable[[], AbstractAsyncContextManager[AsyncSession]]


def compact(*updates: bytes) -> bytes:
    """One update holding everything in `updates`, with deleted content garbage-collected."""
    doc = Doc()
    for update in updates:
        doc.apply_update(update)
    return doc.get_update()


class DocStore:
    def __init__(self, sessions: SessionFactory) -> None:
        self.sessions = sessions

    async def load(self, page_id: uuid.UUID) -> bytes | None:
        async with self.sessions() as session:
            return await session.scalar(select(PageDoc.state).where(PageDoc.page_id == page_id))

    async def save(self, page_id: uuid.UUID, state: bytes) -> None:
        """Merge `state` into what's stored, so a worker that missed an update never drops it."""
        async with self.sessions() as session:
            try:
                created = await session.execute(
                    insert(PageDoc).values(page_id=page_id, state=state).on_conflict_do_nothing()
                )
                if created.rowcount == 0:  # type: ignore[attr-defined]
                    row = await session.get(PageDoc, page_id, with_for_update=True, populate_existing=True)
                    if row is not None:
                        row.state = compact(row.state, state)
                await session.commit()
            except IntegrityError:
                # The page was deleted meanwhile; nothing to keep.
                await session.rollback()
                logger.info("Page %s is gone; its live document was not saved", page_id)
