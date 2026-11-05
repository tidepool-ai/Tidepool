"""Databases (T16): schema, rows, views and queries. Rows are pages: trash one with DELETE /api/pages/{id}."""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import CurrentUser
from app.databases import query as q
from app.databases import service
from app.databases.models import Database, DatabaseView
from app.databases.properties import SchemaError
from app.databases.schemas import (
    DatabaseCreate,
    DatabaseOut,
    QueryIn,
    QueryOut,
    RowIn,
    RowOut,
    RowUpdate,
    SchemaIn,
    ViewConfig,
    ViewIn,
    ViewOut,
    ViewUpdate,
)
from app.db import get_session
from app.pages import service as pages
from app.pages.models import Page

router = APIRouter(tags=["databases"])

Session = Annotated[AsyncSession, Depends(get_session)]


def _not_found(what: str = "Database") -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"{what} not found")


def _invalid(exc: Exception) -> HTTPException:
    return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc))


def _conflict(exc: Exception) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))


async def _load(session: AsyncSession, database_id: uuid.UUID, user_id: uuid.UUID) -> tuple[Database, Page]:
    try:
        return await service.load(session, database_id, user_id)
    except service.DatabaseNotFoundError:
        raise _not_found() from None


def _view_out(view: DatabaseView) -> ViewOut:
    return ViewOut(
        id=view.id,
        name=view.name,
        layout=view.layout,  # type: ignore[arg-type]
        config=ViewConfig.model_validate(view.config),
        position=view.position,
    )


async def _out(session: AsyncSession, database: Database, page: Page) -> DatabaseOut:
    return DatabaseOut(
        id=database.id,
        page_id=page.id,
        title=page.title,
        archived_at=page.archived_at,
        properties=database.properties,
        views=[_view_out(view) for view in await service.views(session, database)],
    )


@router.post("/api/databases", status_code=status.HTTP_201_CREATED)
async def create_database(body: DatabaseCreate, user: CurrentUser, session: Session) -> DatabaseOut:
    """A new full-page database (a page in the tree) with one Table view."""
    try:
        database, page = await service.create(
            session, user.id, body.workspace_id, body.parent_id, body.title, body.properties
        )
    except pages.PageNotFoundError:
        raise _not_found("Workspace") from None
    except (SchemaError, pages.InvalidParentError) as exc:
        raise _invalid(exc) from None
    except pages.PageConflictError as exc:
        raise _conflict(exc) from None
    await session.commit()
    return await _out(session, database, page)


@router.get("/api/databases/{database_id}")
async def get_database(database_id: uuid.UUID, user: CurrentUser, session: Session) -> DatabaseOut:
    database, page = await _load(session, database_id, user.id)
    return await _out(session, database, page)


@router.get("/api/pages/{page_id}/database")
async def database_for_page(page_id: uuid.UUID, user: CurrentUser, session: Session) -> DatabaseOut:
    """The database a page holds (404 for ordinary pages)."""
    try:
        database, page = await service.for_page(session, page_id, user.id)
    except service.DatabaseNotFoundError:
        raise _not_found() from None
    return await _out(session, database, page)


@router.put("/api/databases/{database_id}/schema")
async def update_schema(
    database_id: uuid.UUID, body: SchemaIn, user: CurrentUser, session: Session
) -> DatabaseOut:
    database, page = await _load(session, database_id, user.id)
    try:
        await service.update_schema(session, database, page, body.properties)
    except SchemaError as exc:
        raise _invalid(exc) from None
    except service.DatabaseConflictError as exc:
        raise _conflict(exc) from None
    await session.commit()
    await session.refresh(database)
    return await _out(session, database, page)


# Rows --------------------------------------------------------------------------------------------


def _row_out(row: Page) -> RowOut:
    return RowOut.model_validate(row)


@router.post("/api/databases/{database_id}/rows", status_code=status.HTTP_201_CREATED)
async def create_row(database_id: uuid.UUID, body: RowIn, user: CurrentUser, session: Session) -> RowOut:
    database, page = await _load(session, database_id, user.id)
    try:
        row = await service.create_row(
            session, database, page, user.id, body.title, body.icon, body.properties
        )
    except SchemaError as exc:
        raise _invalid(exc) from None
    except (service.DatabaseConflictError, pages.PageConflictError) as exc:
        raise _conflict(exc) from None
    await session.commit()
    return _row_out(row)


@router.get("/api/databases/{database_id}/rows/{row_id}")
async def get_row(database_id: uuid.UUID, row_id: uuid.UUID, user: CurrentUser, session: Session) -> RowOut:
    database, _page = await _load(session, database_id, user.id)
    try:
        return _row_out(await service.get_row(session, database, row_id))
    except service.DatabaseNotFoundError:
        raise _not_found("Row") from None


@router.patch("/api/databases/{database_id}/rows/{row_id}")
async def update_row(
    database_id: uuid.UUID, row_id: uuid.UUID, body: RowUpdate, user: CurrentUser, session: Session
) -> RowOut:
    database, page = await _load(session, database_id, user.id)
    try:
        row = await service.get_row(session, database, row_id)
        row = await service.update_row(session, database, page, row, body.model_dump(exclude_unset=True))
    except service.DatabaseNotFoundError:
        raise _not_found("Row") from None
    except SchemaError as exc:
        raise _invalid(exc) from None
    except service.DatabaseConflictError as exc:
        raise _conflict(exc) from None
    await session.commit()
    return _row_out(row)


@router.post("/api/databases/{database_id}/query")
async def query_rows(database_id: uuid.UUID, body: QueryIn, user: CurrentUser, session: Session) -> QueryOut:
    """Rows matching a filter, sorted, a page at a time (pass `next_cursor` back as `cursor`)."""
    database, _page = await _load(session, database_id, user.id)
    filter_, sorts = body.filter, body.sorts
    if body.view_id is not None:
        try:
            view = await service.get_view(session, database, body.view_id)
        except service.DatabaseNotFoundError:
            raise _not_found("View") from None
        filter_ = filter_ if "filter" in body.model_fields_set else view.config.get("filter")
        sorts = sorts if "sorts" in body.model_fields_set else view.config.get("sorts")
    try:
        rows, next_cursor = await service.query_rows(
            session, database, filter_, sorts, body.page_size, body.cursor
        )
    except q.QueryError as exc:
        raise _invalid(exc) from None
    return QueryOut(
        results=[_row_out(row) for row in rows], next_cursor=next_cursor, has_more=next_cursor is not None
    )


# Views -------------------------------------------------------------------------------------------


@router.post("/api/databases/{database_id}/views", status_code=status.HTTP_201_CREATED)
async def create_view(database_id: uuid.UUID, body: ViewIn, user: CurrentUser, session: Session) -> ViewOut:
    database, page = await _load(session, database_id, user.id)
    try:
        view = await service.create_view(session, database, page, body.name, body.layout, body.config)
    except q.QueryError as exc:
        raise _invalid(exc) from None
    except service.DatabaseConflictError as exc:
        raise _conflict(exc) from None
    await session.commit()
    return _view_out(view)


@router.patch("/api/databases/{database_id}/views/{view_id}")
async def update_view(
    database_id: uuid.UUID, view_id: uuid.UUID, body: ViewUpdate, user: CurrentUser, session: Session
) -> ViewOut:
    database, page = await _load(session, database_id, user.id)
    try:
        view = await service.get_view(session, database, view_id)
        fields = {name: getattr(body, name) for name in body.model_fields_set}
        view = await service.update_view(session, database, page, view, fields)
    except service.DatabaseNotFoundError:
        raise _not_found("View") from None
    except q.QueryError as exc:
        raise _invalid(exc) from None
    except service.DatabaseConflictError as exc:
        raise _conflict(exc) from None
    await session.commit()
    return _view_out(view)


@router.delete("/api/databases/{database_id}/views/{view_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_view(
    database_id: uuid.UUID, view_id: uuid.UUID, user: CurrentUser, session: Session
) -> Response:
    database, page = await _load(session, database_id, user.id)
    try:
        view = await service.get_view(session, database, view_id)
        await service.delete_view(session, database, page, view)
    except service.DatabaseNotFoundError:
        raise _not_found("View") from None
    except service.DatabaseConflictError as exc:
        raise _conflict(exc) from None
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
