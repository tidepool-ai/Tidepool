"""Pages: create, read, rename, move, trash, restore, and one level of children."""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import CurrentUser
from app.config import settings
from app.db import get_session
from app.pages import service
from app.pages.models import Page, PageContent
from app.pages.schemas import PageContentIn, PageContentOut, PageCreate, PageOut, PageUpdate, SearchResult
from app.permissions import service as permissions
from app.permissions.service import Level
from app.workspaces.service import WorkspaceNotFoundError, require_member

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


def forbidden(exc: Exception) -> HTTPException:
    return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc))


async def _load(
    session: AsyncSession,
    page_id: uuid.UUID,
    user_id: uuid.UUID,
    *,
    need: Level = Level.VIEW,
    for_update: bool = False,
) -> Page:
    try:
        return await service.get_page(session, page_id, user_id, need=need, for_update=for_update)
    except service.PageNotFoundError:
        raise NOT_FOUND from None
    except service.PageForbiddenError as exc:
        raise forbidden(exc) from None


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
    except service.PageForbiddenError as exc:
        raise forbidden(exc) from None
    await session.commit()
    return _out(page)


@router.get("/api/pages/{page_id}")
async def get_page(page_id: uuid.UUID, user: CurrentUser, session: Session) -> PageOut:
    """The page, if the caller can open it. Counts as a visit for their recent pages (T22)."""
    page = await _load(session, page_id, user.id)
    await service.record_visit(session, page, user.id)
    await session.commit()
    return _out(page)


@router.get("/api/workspaces/{workspace_id}/search")
async def search(
    workspace_id: uuid.UUID,
    user: CurrentUser,
    session: Session,
    q: Annotated[str, Query(max_length=200)] = "",
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
) -> list[SearchResult]:
    """Title search for the command bar; with no text, the caller's recent pages.

    Only pages the caller can open are returned, and breadcrumbs only name pages they can open.
    """
    try:
        await require_member(session, workspace_id, user.id)
    except WorkspaceNotFoundError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workspace not found") from None
    text_query = q.strip()
    if text_query:
        pages = await service.search(session, workspace_id, user.id, text_query, limit)
    else:
        pages = await service.recent(session, workspace_id, user.id, limit)
    paths = await service.breadcrumbs(session, pages, user.id)
    return [SearchResult(**_out(page).model_dump(), path=paths[page.id]) for page in pages]


@router.patch("/api/pages/{page_id}")
async def update_page(page_id: uuid.UUID, body: PageUpdate, user: CurrentUser, session: Session) -> PageOut:
    moving = "parent_id" in body.model_fields_set
    page = await _load(session, page_id, user.id, need=Level.FULL if moving else Level.EDIT, for_update=True)
    if moving and body.parent_id is not None and body.parent_id != page.parent_id:
        # Moving into a page needs edit access there too.
        try:
            await service.get_page(session, body.parent_id, user.id, need=Level.EDIT)
        except service.PageNotFoundError:
            raise _bad_request(
                service.InvalidParentError("parent_id is not a page in this workspace")
            ) from None
        except service.PageForbiddenError as exc:
            raise forbidden(exc) from None
    try:
        page = await service.update_page(session, page, _fields(body, set()))
    except (service.InvalidParentError, service.PageConflictError) as exc:
        raise _bad_request(exc) from None
    await session.commit()
    return _out(page)


@router.delete("/api/pages/{page_id}")
async def trash_page(page_id: uuid.UUID, user: CurrentUser, session: Session) -> PageOut:
    """Move to trash (with subpages). Use POST /restore to undo."""
    page = await _load(session, page_id, user.id, need=Level.FULL, for_update=True)
    page = await service.trash_page(session, page)
    await session.commit()
    return _out(page)


@router.post("/api/pages/{page_id}/restore")
async def restore_page(page_id: uuid.UUID, user: CurrentUser, session: Session) -> PageOut:
    try:
        page = await service.restore_page(
            session, await _load(session, page_id, user.id, need=Level.FULL, for_update=True)
        )
    except service.PageConflictError as exc:
        raise _bad_request(exc) from None
    await session.commit()
    return _out(page)


@router.get("/api/pages/{page_id}/children")
async def list_children(page_id: uuid.UUID, user: CurrentUser, session: Session) -> list[PageOut]:
    parent = await _load(session, page_id, user.id)
    children = await permissions.visible(session, await service.list_children(session, parent), user.id)
    return [_out(page) for page in children]


@router.get("/api/workspaces/{workspace_id}/pages")
async def list_top_level(workspace_id: uuid.UUID, user: CurrentUser, session: Session) -> list[PageOut]:
    """Top-level pages of a workspace: the starting point for the sidebar tree (T07)."""
    if not await service.can_access_workspace(session, workspace_id, user.id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workspace not found")
    pages = await permissions.visible(session, await service.list_top_level(session, workspace_id), user.id)
    return [_out(page) for page in pages]


class _TooLarge(Exception):
    pass


async def _read_limited(request: Request, limit: int) -> bytes:
    """Read the body, stopping as soon as it passes `limit` (also when there's no Content-Length)."""
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > limit:
        raise _TooLarge
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > limit:
            raise _TooLarge
    return bytes(body)


def _content_out(page_id: uuid.UUID, content: PageContent | None) -> PageContentOut:
    if content is None:
        return PageContentOut(page_id=page_id, content=None, updated_at=None)
    return PageContentOut(page_id=page_id, content=content.doc, updated_at=content.updated_at)


@router.get("/api/pages/{page_id}/content")
async def get_content(page_id: uuid.UUID, user: CurrentUser, session: Session) -> PageContentOut:
    page = await _load(session, page_id, user.id)
    return _content_out(page.id, await service.get_content(session, page))


@router.put(
    "/api/pages/{page_id}/content",
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {"application/json": {"schema": PageContentIn.model_json_schema()}},
        }
    },
)
async def put_content(
    page_id: uuid.UUID, request: Request, user: CurrentUser, session: Session
) -> PageContentOut:
    """Replace the page's document. Bodies over MAX_PAGE_CONTENT_BYTES get 413."""
    page = await _load(session, page_id, user.id, need=Level.EDIT, for_update=True)
    limit = settings.max_page_content_bytes
    try:
        body = PageContentIn.model_validate_json(await _read_limited(request, limit))
    except _TooLarge:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE, detail=f"Page content is over {limit} bytes"
        ) from None
    except ValidationError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=exc.errors(include_url=False, include_context=False, include_input=False),
        ) from None
    try:
        content = await service.save_content(session, page, body.content, user.id)
    except service.PageConflictError as exc:
        raise _bad_request(exc) from None
    await session.commit()
    return _content_out(page.id, content)
