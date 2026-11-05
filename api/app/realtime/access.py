"""Who may read or edit a page's live document."""

import uuid
from enum import Enum

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.pages.models import Page
from app.pages.service import can_access_workspace


class Access(Enum):
    NONE = "none"
    READ = "read"  # e.g. the page is in the trash
    WRITE = "write"


async def page_access(session: AsyncSession, page_id: uuid.UUID, user_id: uuid.UUID) -> Access:
    page = await session.scalar(select(Page).where(Page.id == page_id))
    if page is None or not await can_access_workspace(session, page.workspace_id, user_id):
        return Access.NONE
    return Access.READ if page.archived_at is not None else Access.WRITE
