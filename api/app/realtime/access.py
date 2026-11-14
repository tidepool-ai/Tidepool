"""Who may read or edit a page's live document."""

import uuid
from enum import Enum

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.pages.models import Page
from app.permissions import service as permissions
from app.permissions.service import Level


class Access(Enum):
    NONE = "none"
    READ = "read"  # view or comment access, or the page is in the trash
    WRITE = "write"


async def page_access(session: AsyncSession, page_id: uuid.UUID, user_id: uuid.UUID) -> Access:
    page = await session.scalar(select(Page).where(Page.id == page_id))
    if page is None:
        return Access.NONE
    level = await permissions.level(session, page, user_id)
    if level is Level.NONE:
        return Access.NONE
    return Access.WRITE if level >= Level.EDIT and page.archived_at is None else Access.READ
