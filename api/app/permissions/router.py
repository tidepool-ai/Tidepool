"""Sharing a page (T21): who has access, inviting people, and general (link) access."""

import uuid
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import CurrentUser
from app.db import get_session
from app.pages import service as pages
from app.pages.models import Page
from app.permissions import service
from app.permissions.schemas import (
    GeneralAccessIn,
    GeneralOut,
    LevelIn,
    PageRef,
    PermissionsOut,
    PersonOut,
    ShareIn,
)
from app.permissions.service import Level

router = APIRouter(tags=["sharing"])

Session = Annotated[AsyncSession, Depends(get_session)]


async def _load(session: AsyncSession, page_id: uuid.UUID, user_id: uuid.UUID, need: Level) -> Page:
    try:
        return await pages.get_page(session, page_id, user_id, need=need, for_update=need >= Level.FULL)
    except pages.PageNotFoundError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Page not found") from None
    except pages.PageForbiddenError:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Only people with full access can share this page"
        ) from None


async def _out(session: AsyncSession, page: Page, user_id: uuid.UUID) -> PermissionsOut:
    sharing = await service.describe(session, page)
    level = await service.level(session, page, user_id)

    def ref(page_id: uuid.UUID | None) -> PageRef | None:
        return PageRef(id=page_id, title=sharing.titles.get(page_id, "")) if page_id else None

    return PermissionsOut(
        page_id=page.id,
        access=level.label,  # type: ignore[arg-type]
        can_share=level >= Level.FULL,
        general=GeneralOut(
            access=sharing.general.access,  # type: ignore[arg-type]
            level=sharing.general.level,  # type: ignore[arg-type]
            inherited_from=ref(sharing.general.inherited_from),
        ),
        people=[
            PersonOut(
                user_id=person.user_id,
                email=person.email,
                level=person.level,  # type: ignore[arg-type]
                inherited_from=ref(person.inherited_from),
                role=person.role,
            )
            for person in sharing.people
        ],
    )


@router.get("/api/pages/{page_id}/permissions")
async def get_permissions(page_id: uuid.UUID, user: CurrentUser, session: Session) -> PermissionsOut:
    """Who has access to the page and why. Anyone who can open the page can see this."""
    page = await _load(session, page_id, user.id, Level.VIEW)
    return await _out(session, page, user.id)


@router.post("/api/pages/{page_id}/share")
async def share(
    page_id: uuid.UUID, body: ShareIn, user: CurrentUser, session: Session, background: BackgroundTasks
) -> PermissionsOut:
    """Give someone access by email. People outside the workspace join it as guests."""
    page = await _load(session, page_id, user.id, Level.FULL)
    invitee = await service.find_or_invite(session, body.email, page.workspace_id)
    await service.grant(session, page, invitee.id, body.level, user.id)
    await _keep(session, page, user.id, grant_if_lost=False)
    await session.commit()
    if invitee.id != user.id:
        background.add_task(service.deliver_invite, invitee.email, user.email, page.title, page.id)
    return await _out(session, page, user.id)


@router.put("/api/pages/{page_id}/permissions/{user_id}")
async def set_level(
    page_id: uuid.UUID, user_id: uuid.UUID, body: LevelIn, user: CurrentUser, session: Session
) -> PermissionsOut:
    """Set someone's level on this page (overriding what they inherit from pages above)."""
    page = await _load(session, page_id, user.id, Level.FULL)
    if await session.get(service.User, user_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No such person")
    if await session.get(service.Member, (page.workspace_id, user_id)) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invite them by email first")
    await service.grant(session, page, user_id, body.level, user.id)
    await _keep(session, page, user.id, grant_if_lost=False)
    await session.commit()
    return await _out(session, page, user.id)


@router.delete("/api/pages/{page_id}/permissions/{user_id}")
async def remove(
    page_id: uuid.UUID, user_id: uuid.UUID, user: CurrentUser, session: Session
) -> PermissionsOut:
    """Remove someone's access set on this page (they keep anything they get from pages above)."""
    page = await _load(session, page_id, user.id, Level.FULL)
    if not await service.revoke(session, page, user_id):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="They have no access set on this page"
        )
    await _keep(session, page, user.id, grant_if_lost=False)
    await session.commit()
    return await _out(session, page, user.id)


@router.put("/api/pages/{page_id}/general-access")
async def set_general_access(
    page_id: uuid.UUID, body: GeneralAccessIn, user: CurrentUser, session: Session
) -> PermissionsOut:
    """Who else can open the page: only invited people, the workspace, or anyone with the link."""
    page = await _load(session, page_id, user.id, Level.FULL)
    await service.set_general(session, page, body.access, body.level)
    await _keep(session, page, user.id, grant_if_lost=True)
    await session.commit()
    return await _out(session, page, user.id)


async def _keep(session: AsyncSession, page: Page, user_id: uuid.UUID, *, grant_if_lost: bool) -> None:
    try:
        await service.keep_full_access(session, page, user_id, grant_if_lost=grant_if_lost)
    except service.LockoutError as exc:
        await session.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from None
