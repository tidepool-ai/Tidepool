"""Page tree operations and the access check every page endpoint uses.

Access levels (view, comment, edit, full) and how they're inherited: app/permissions/service.py.
Top-level pages can be created by workspace owners, admins and members; subpages by anyone who can
edit the parent.
"""

import uuid
from datetime import UTC, datetime

from sqlalchemy import ColumnElement, Select, bindparam, case, exists, func, select, text, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.pages.models import Ltree, Page, PageContent, PageVisit, path_label
from app.permissions import service as permissions
from app.permissions.service import Level
from app.workspaces.models import Role
from app.workspaces.service import WorkspaceForbiddenError, WorkspaceNotFoundError, require_member

PAGE_ROLES = frozenset({Role.OWNER, Role.ADMIN, Role.MEMBER})


class PageNotFoundError(Exception):
    """No such page, or the caller can't see it (indistinguishable on purpose)."""


class InvalidParentError(Exception):
    """The requested parent isn't a valid place for this page."""


class PageConflictError(Exception):
    """The page (or its target) is in the wrong state, e.g. in the trash."""


class PageForbiddenError(Exception):
    """The caller can open the page, but their access level doesn't allow this."""


def _forbidden(level: Level, need: Level) -> PageForbiddenError:
    if need >= Level.FULL:
        return PageForbiddenError("This needs full access to the page")
    if level <= Level.COMMENT:
        return PageForbiddenError("You can view this page but not change it")
    return PageForbiddenError("You don't have access to do this")


async def can_access_workspace(session: AsyncSession, workspace_id: uuid.UUID, user_id: uuid.UUID) -> bool:
    try:
        await require_member(session, workspace_id, user_id, PAGE_ROLES)
    except (WorkspaceNotFoundError, WorkspaceForbiddenError):
        return False
    return True


async def get_page(
    session: AsyncSession,
    page_id: uuid.UUID,
    user_id: uuid.UUID,
    *,
    need: Level = Level.VIEW,
    for_update: bool = False,
) -> Page:
    """Load a page the caller can open, with `access` set.

    Raises PageNotFoundError if they can't open it, PageForbiddenError if their level is below `need`.
    """
    query = select(Page).where(Page.id == page_id)
    if for_update:
        query = query.with_for_update()
    page = await session.scalar(query)
    if page is None:
        raise PageNotFoundError
    level = await permissions.level(session, page, user_id)
    if level is Level.NONE:
        raise PageNotFoundError
    page.access = level.label
    if level < need:
        raise _forbidden(level, need)
    return page


async def hosts_database(session: AsyncSession, page_id: uuid.UUID) -> bool:
    from app.databases.models import Database  # databases build on pages

    return await session.scalar(select(exists().where(Database.page_id == page_id))) or False


async def _valid_parent(
    session: AsyncSession, workspace_id: uuid.UUID, parent_id: uuid.UUID, *, for_row: bool = False
) -> Page:
    parent = await session.scalar(select(Page).where(Page.id == parent_id).with_for_update())
    if parent is None or parent.workspace_id != workspace_id:
        raise InvalidParentError("parent_id is not a page in this workspace")
    if parent.archived_at is not None:
        raise PageConflictError("The parent page is in the trash")
    if not for_row and (parent.database_id is not None or await hosts_database(session, parent.id)):
        raise InvalidParentError("Pages can't go inside a database or its rows; add a row instead")
    return parent


async def create_page(
    session: AsyncSession,
    user_id: uuid.UUID,
    workspace_id: uuid.UUID,
    parent_id: uuid.UUID | None,
    fields: dict[str, object],
    *,
    database_id: uuid.UUID | None = None,
) -> Page:
    """Create a page; with `database_id`, a row of that database (under the database's page)."""
    if parent_id is not None:
        try:
            await get_page(session, parent_id, user_id, need=Level.EDIT)
        except PageNotFoundError:
            raise InvalidParentError("parent_id is not a page in this workspace") from None
    elif not await can_access_workspace(session, workspace_id, user_id):
        raise PageNotFoundError
    for_row = database_id is not None
    parent = await _valid_parent(session, workspace_id, parent_id, for_row=for_row) if parent_id else None
    page_id = uuid.uuid4()
    label = path_label(page_id)
    page = Page(
        id=page_id,
        workspace_id=workspace_id,
        parent_id=parent_id,
        path=f"{parent.path}.{label}" if parent else label,
        created_by=user_id,
        database_id=database_id,
        **fields,
    )
    session.add(page)
    await session.flush()
    await session.refresh(page)
    page.access = (await permissions.level(session, page, user_id)).label
    return page


async def update_page(session: AsyncSession, page: Page, fields: dict[str, object]) -> Page:
    if page.archived_at is not None:
        raise PageConflictError("Restore the page before changing it")
    if "parent_id" in fields and page.database_id is not None and fields["parent_id"] != page.parent_id:
        raise InvalidParentError("Rows stay in their database")
    if "parent_id" in fields:
        parent_id = fields.pop("parent_id")
        assert parent_id is None or isinstance(parent_id, uuid.UUID)
        await _move(session, page, parent_id)
    for name, value in fields.items():
        setattr(page, name, value)
    await session.flush()
    await session.refresh(page)
    return page


async def _move(session: AsyncSession, page: Page, parent_id: uuid.UUID | None) -> None:
    """Re-parent `page` and rewrite the paths of its whole subtree in one statement."""
    if parent_id == page.parent_id:
        return
    new_prefix = ""
    if parent_id is not None:
        parent = await _valid_parent(session, page.workspace_id, parent_id)
        if parent.id == page.id or (parent.path + ".").startswith(page.path + "."):
            raise InvalidParentError("A page can't be moved into itself or one of its subpages")
        new_prefix = parent.path
    old_path = page.path
    await session.execute(
        text(
            "UPDATE pages"
            " SET path = CAST(:prefix AS ltree) || subpath(path, nlevel(CAST(:old AS ltree)) - 1),"
            " updated_at = clock_timestamp()"
            " WHERE path <@ CAST(:old AS ltree)"
        ),
        {"prefix": new_prefix, "old": old_path},
    )
    page.parent_id = parent_id
    await session.flush()


def _subtree(page: Page) -> ColumnElement[bool]:
    """WHERE clause: the page and all its descendants."""
    return Page.path.op("<@")(bindparam("subtree_root", page.path, type_=Ltree()))


async def trash_page(session: AsyncSession, page: Page) -> Page:
    """Move the page and its subpages to the trash. Subpages already in the trash keep their own date."""
    if page.archived_at is None:
        await session.execute(
            update(Page)
            .where(_subtree(page), Page.archived_at.is_(None))
            .values(archived_at=datetime.now(UTC))
            .execution_options(synchronize_session=False)
        )
        await session.refresh(page)
    return page


async def restore_page(session: AsyncSession, page: Page) -> Page:
    """Restore the page and the subpages that were trashed with it.

    If its parent is still in the trash, the page comes back at the top level instead.
    """
    if page.archived_at is None:
        return page
    if page.database_id is not None:
        database_page = await session.get(Page, page.parent_id)
        if database_page is None or database_page.archived_at is not None:
            raise PageConflictError("Restore the database first")
    await session.execute(
        update(Page)
        .where(_subtree(page), Page.archived_at == page.archived_at)
        .values(archived_at=None)
        .execution_options(synchronize_session=False)
    )
    await session.refresh(page)
    if page.parent_id is not None:
        parent = await session.get(Page, page.parent_id)
        if parent is None or parent.archived_at is not None:
            await _move(session, page, None)
            await session.refresh(page)
    return page


async def list_children(session: AsyncSession, parent: Page) -> list[Page]:
    rows = await session.scalars(
        select(Page)
        .where(Page.parent_id == parent.id, Page.archived_at.is_(None), Page.database_id.is_(None))
        .order_by(Page.created_at, Page.id)
    )
    return list(rows)


async def list_top_level(session: AsyncSession, workspace_id: uuid.UUID) -> list[Page]:
    rows = await session.scalars(
        select(Page)
        .where(
            Page.workspace_id == workspace_id,
            Page.parent_id.is_(None),
            Page.archived_at.is_(None),
            Page.database_id.is_(None),
        )
        .order_by(Page.created_at, Page.id)
    )
    return list(rows)


async def get_content(session: AsyncSession, page: Page) -> PageContent | None:
    return await session.get(PageContent, page.id)


async def save_content(session: AsyncSession, page: Page, doc: dict, user_id: uuid.UUID) -> PageContent:
    """Replace the page's document (last write wins)."""
    if page.archived_at is not None:
        raise PageConflictError("Restore the page before changing it")
    await session.execute(
        insert(PageContent)
        .values(page_id=page.id, doc=doc, updated_by=user_id)
        .on_conflict_do_update(
            index_elements=[PageContent.page_id],
            set_={"doc": doc, "updated_by": user_id, "updated_at": text("clock_timestamp()")},
        )
    )
    content = await session.get(PageContent, page.id, populate_existing=True)
    assert content is not None
    return content


# Search and recent pages (T22) ------------------------------------------------------------------

SEARCH_BATCH = 200
SEARCH_BATCHES = 5


def _like_pattern(query: str) -> str:
    escaped = query.lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


async def _open_pages(
    session: AsyncSession, query: Select[tuple[Page]], user_id: uuid.UUID, limit: int
) -> list[Page]:
    """Run `query` a batch at a time, keeping only pages the caller can open, until `limit` are found."""
    found: list[Page] = []
    for batch in range(SEARCH_BATCHES):
        pages = list(await session.scalars(query.limit(SEARCH_BATCH).offset(batch * SEARCH_BATCH)))
        found += await permissions.visible(session, pages, user_id)
        if len(found) >= limit or len(pages) < SEARCH_BATCH:
            break
    return found[:limit]


async def search(
    session: AsyncSession, workspace_id: uuid.UUID, user_id: uuid.UUID, text_query: str, limit: int
) -> list[Page]:
    """Pages in the workspace whose title contains the text, that the caller can open.

    Titles that start with it come first, then shorter titles, then the most recently edited.
    """
    pattern = _like_pattern(text_query)
    title = func.lower(Page.title)
    query = (
        select(Page)
        .where(
            Page.workspace_id == workspace_id, Page.archived_at.is_(None), title.like(pattern, escape="\\")
        )
        .order_by(
            case((title.like(pattern[1:], escape="\\"), 0), else_=1),
            func.length(Page.title),
            Page.updated_at.desc(),
            Page.id,
        )
    )
    return await _open_pages(session, query, user_id, limit)


async def recent(
    session: AsyncSession, workspace_id: uuid.UUID, user_id: uuid.UUID, limit: int
) -> list[Page]:
    """Pages the caller opened most recently, topped up with the workspace's recently edited pages."""
    visited = (
        select(Page)
        .join(PageVisit, (PageVisit.page_id == Page.id) & (PageVisit.user_id == user_id))
        .where(Page.workspace_id == workspace_id, Page.archived_at.is_(None))
        .order_by(PageVisit.visited_at.desc(), Page.id)
    )
    pages = await _open_pages(session, visited, user_id, limit)
    if len(pages) < limit:
        seen = {page.id for page in pages}
        edited = (
            select(Page)
            .where(
                Page.workspace_id == workspace_id,
                Page.archived_at.is_(None),
                Page.id.not_in(seen or {uuid.uuid4()}),
            )
            .order_by(Page.updated_at.desc(), Page.id)
        )
        pages += await _open_pages(session, edited, user_id, limit - len(pages))
    return pages


async def record_visit(session: AsyncSession, page: Page, user_id: uuid.UUID) -> None:
    await session.execute(
        insert(PageVisit)
        .values(user_id=user_id, page_id=page.id)
        .on_conflict_do_update(
            index_elements=[PageVisit.user_id, PageVisit.page_id],
            set_={"visited_at": text("clock_timestamp()")},
        )
    )


async def breadcrumbs(
    session: AsyncSession, pages: list[Page], user_id: uuid.UUID
) -> dict[uuid.UUID, list[str]]:
    """Each page's ancestors' titles, top first, leaving out ancestors the caller can't open."""
    ancestor_ids = {i for page in pages for i in permissions.chain(page)[1:]}
    if not ancestor_ids:
        return {page.id: [] for page in pages}
    ancestors = list(await session.scalars(select(Page).where(Page.id.in_(ancestor_ids))))
    titles = {
        page.id: page.title or "Untitled" for page in await permissions.visible(session, ancestors, user_id)
    }
    return {
        page.id: [titles[i] for i in reversed(permissions.chain(page)[1:]) if i in titles] for page in pages
    }
