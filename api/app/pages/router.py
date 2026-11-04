"""Pages: create, read, rename, move, trash, restore, and one level of children."""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import CurrentUser
from app.db import get_session
from app.pages import service
from app.pages.models import Page
from app.pages.schemas import PageCreate, PageOut, PageUpdate

router = APIRouter(tags=["pages"])

Session = Annotated[AsyncSession, Depends(get_session)]

NOT_FOUND = HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Page not found")


def _out(page: Page) -> PageOut:
    return PageOut.model_validate(page)


def _fields(body: PageCreate | PageUpdate, exclude: set[str]) -> dict[str, object]:
    fields = body.model_dump(exclude_unset=True, exclude=exclude)
    if fields.get("cover") is not None:
        fields["cover"] = str(fields["cover"])
    return fields


async def _load(
    session: AsyncSession, page_id: uuid.UUID, user_id: uuid.UUID, *, for_update: bool = False
) -> Page:
    try:
        return await service.get_page(session, page_id, user_id, for_update=for_update)
    except service.PageNotFoundError:
        raise NOT_FOUND from None


def _bad_request(exc: Exception) -> HTTPException:
    if isinstance(exc, service.InvalidParentError):
        return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc))
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))


@router.post("/api/pages", status_code=status.HTTP_201_CREATED)
async def create_page(body: PageCreate, user: CurrentUser, session: Session) -> PageOut:
    try:
        page = await service.create_page(
            session, user.id, body.workspace_id, body.parent_id, _fields(body, {"workspace_id", "parent_id"})
        )
    except service.PageNotFoundError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workspace not found") from None
    except (service.InvalidParentError, service.PageConflictError) as exc:
        raise _bad_request(exc) from None
    await session.commit()
    return _out(page)


@router.get("/api/pages/{page_id}")
async def get_page(page_id: uuid.UUID, user: CurrentUser, session: Session) -> PageOut:
    return _out(await _load(session, page_id, user.id))


@router.patch("/api/pages/{page_id}")
async def update_page(page_id: uuid.UUID, body: PageUpdate, user: CurrentUser, session: Session) -> PageOut:
    page = await _load(session, page_id, user.id, for_update=True)
    try:
        page = await service.update_page(session, page, _fields(body, set()))
    except (service.InvalidParentError, service.PageConflictError) as exc:
        raise _bad_request(exc) from None
    await session.commit()
    return _out(page)


@router.delete("/api/pages/{page_id}")
async def trash_page(page_id: uuid.UUID, user: CurrentUser, session: Session) -> PageOut:
    """Move to trash (with subpages). Use POST /restore to undo."""
    page = await service.trash_page(session, await _load(session, page_id, user.id, for_update=True))
    await session.commit()
    return _out(page)


@router.post("/api/pages/{page_id}/restore")
async def restore_page(page_id: uuid.UUID, user: CurrentUser, session: Session) -> PageOut:
    page = await service.restore_page(session, await _load(session, page_id, user.id, for_update=True))
    await session.commit()
    return _out(page)


@router.get("/api/pages/{page_id}/children")
async def list_children(page_id: uuid.UUID, user: CurrentUser, session: Session) -> list[PageOut]:
    parent = await _load(session, page_id, user.id)
    return [_out(page) for page in await service.list_children(session, parent)]


@router.get("/api/workspaces/{workspace_id}/pages")
async def list_top_level(workspace_id: uuid.UUID, user: CurrentUser, session: Session) -> list[PageOut]:
    """Top-level pages of a workspace: the starting point for the sidebar tree (T07)."""
    if not await service.can_access_workspace(session, workspace_id, user.id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workspace not found")
    return [_out(page) for page in await service.list_top_level(session, workspace_id)]
