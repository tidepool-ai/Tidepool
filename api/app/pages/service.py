"""Page tree operations and the access check every page endpoint uses.

Until page-level sharing (T21), a page is visible to and editable by the owners, admins and members
of its workspace. Guests see no pages yet, because nothing can be shared with them.
"""

import uuid
from datetime import UTC, datetime

from sqlalchemy import ColumnElement, bindparam, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.pages.models import Ltree, Page, path_label
from app.workspaces.models import Role
from app.workspaces.service import WorkspaceForbiddenError, WorkspaceNotFoundError, require_member

PAGE_ROLES = frozenset({Role.OWNER, Role.ADMIN, Role.MEMBER})


class PageNotFoundError(Exception):
    """No such page, or the caller can't see it (indistinguishable on purpose)."""


class InvalidParentError(Exception):
    """The requested parent isn't a valid place for this page."""


class PageConflictError(Exception):
    """The page (or its target) is in the wrong state, e.g. in the trash."""


async def can_access_workspace(session: AsyncSession, workspace_id: uuid.UUID, user_id: uuid.UUID) -> bool:
    try:
        await require_member(session, workspace_id, user_id, PAGE_ROLES)
    except (WorkspaceNotFoundError, WorkspaceForbiddenError):
        return False
    return True


async def get_page(
    session: AsyncSession, page_id: uuid.UUID, user_id: uuid.UUID, *, for_update: bool = False
) -> Page:
    """Load a page the caller may access, or raise PageNotFoundError."""
    query = select(Page).where(Page.id == page_id)
    if for_update:
        query = query.with_for_update()
    page = await session.scalar(query)
    if page is None or not await can_access_workspace(session, page.workspace_id, user_id):
        raise PageNotFoundError
    return page


async def _valid_parent(session: AsyncSession, workspace_id: uuid.UUID, parent_id: uuid.UUID) -> Page:
    parent = await session.scalar(select(Page).where(Page.id == parent_id).with_for_update())
    if parent is None or parent.workspace_id != workspace_id:
        raise InvalidParentError("parent_id is not a page in this workspace")
    if parent.archived_at is not None:
        raise PageConflictError("The parent page is in the trash")
    return parent


async def create_page(
    session: AsyncSession,
    user_id: uuid.UUID,
    workspace_id: uuid.UUID,
    parent_id: uuid.UUID | None,
    fields: dict[str, object],
) -> Page:
    if not await can_access_workspace(session, workspace_id, user_id):
        raise PageNotFoundError
    parent = await _valid_parent(session, workspace_id, parent_id) if parent_id else None
    page_id = uuid.uuid4()
    label = path_label(page_id)
    page = Page(
        id=page_id,
        workspace_id=workspace_id,
        parent_id=parent_id,
        path=f"{parent.path}.{label}" if parent else label,
        created_by=user_id,
        **fields,
    )
    session.add(page)
    await session.flush()
    await session.refresh(page)
    return page


async def update_page(session: AsyncSession, page: Page, fields: dict[str, object]) -> Page:
    if page.archived_at is not None:
        raise PageConflictError("Restore the page before changing it")
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
        .where(Page.parent_id == parent.id, Page.archived_at.is_(None))
        .order_by(Page.created_at, Page.id)
    )
    return list(rows)


async def list_top_level(session: AsyncSession, workspace_id: uuid.UUID) -> list[Page]:
    rows = await session.scalars(
        select(Page)
        .where(Page.workspace_id == workspace_id, Page.parent_id.is_(None), Page.archived_at.is_(None))
        .order_by(Page.created_at, Page.id)
    )
    return list(rows)
