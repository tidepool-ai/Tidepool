"""Databases: schema, rows and views (T16). Access to a database is access to its page."""

import copy
import uuid
from typing import Any

from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.databases import query as q
from app.databases.models import Database, DatabaseView
from app.databases.properties import (
    PropertyDef,
    apply_values,
    default_schema,
    normalize_schema,
    option_ids,
)
from app.databases.schemas import ViewConfig
from app.pages import service as pages
from app.pages.models import Page
from app.workspaces.models import Member

MAX_VIEWS = 50


class DatabaseNotFoundError(Exception):
    """No such database (or row/view in it), or the caller can't see it."""


class DatabaseConflictError(Exception):
    """The database is in the wrong state, e.g. in the trash."""


async def load(session: AsyncSession, database_id: uuid.UUID, user_id: uuid.UUID) -> tuple[Database, Page]:
    database = await session.get(Database, database_id)
    if database is None:
        raise DatabaseNotFoundError
    try:
        page = await pages.get_page(session, database.page_id, user_id)
    except pages.PageNotFoundError:
        raise DatabaseNotFoundError from None
    return database, page


async def for_page(session: AsyncSession, page_id: uuid.UUID, user_id: uuid.UUID) -> tuple[Database, Page]:
    database = await session.scalar(select(Database).where(Database.page_id == page_id))
    if database is None:
        raise DatabaseNotFoundError
    return await load(session, database.id, user_id)


def writable(page: Page) -> None:
    if page.archived_at is not None:
        raise DatabaseConflictError("Restore the database before changing it")


async def views(session: AsyncSession, database: Database) -> list[DatabaseView]:
    rows = await session.scalars(
        select(DatabaseView).where(DatabaseView.database_id == database.id).order_by(DatabaseView.position)
    )
    return list(rows)


async def create(
    session: AsyncSession,
    user_id: uuid.UUID,
    workspace_id: uuid.UUID,
    parent_id: uuid.UUID | None,
    title: str,
    definitions: list[PropertyDef] | None,
) -> tuple[Database, Page]:
    schema = normalize_schema(definitions) if definitions else default_schema()
    page = await pages.create_page(session, user_id, workspace_id, parent_id, {"title": title})
    database = Database(page_id=page.id, schema={"properties": schema})
    session.add(database)
    await session.flush()
    session.add(DatabaseView(database_id=database.id, name="Table", layout="table", config={}, position=0))
    await session.flush()
    return database, page


# Schema ------------------------------------------------------------------------------------------


async def update_schema(
    session: AsyncSession, database: Database, page: Page, definitions: list[PropertyDef]
) -> None:
    """Replace the schema. Values of removed properties, of properties whose type changed, and of
    removed options are cleared; views stop using what no longer exists."""
    writable(page)
    before = {prop["id"]: prop for prop in database.properties}
    schema = normalize_schema(definitions, database.properties)
    rows = (Page.database_id == database.id,)

    for prop in schema:
        old = before.get(prop["id"])
        if old is None or prop["type"] == "title":
            continue
        if old["type"] != prop["type"]:
            await _clear(session, rows, prop["id"])
            continue
        removed = sorted(set(option_ids(old)) - set(option_ids(prop)))
        if removed and prop["type"] in ("select", "status"):
            await session.execute(
                update(Page)
                .where(*rows, Page.properties[prop["id"]].astext.in_(removed))
                .values(properties=Page.properties.op("-")(prop["id"]))
                .execution_options(synchronize_session=False)
            )
        elif removed and prop["type"] == "multi_select":
            await session.execute(
                text(
                    "UPDATE pages SET properties = CASE WHEN remaining IS NULL THEN properties - :pid"
                    " ELSE jsonb_set(properties, ARRAY[:pid], remaining) END"
                    " FROM (SELECT id AS row_id,"
                    "   (SELECT jsonb_agg(v) FROM jsonb_array_elements(properties -> :pid) v"
                    "    WHERE v #>> '{}' <> ALL(:removed)) AS remaining"
                    "   FROM pages WHERE database_id = :db AND properties ? :pid) changed"
                    " WHERE pages.id = changed.row_id"
                ),
                {"pid": prop["id"], "removed": removed, "db": database.id},
            )
    for prop_id in set(before) - {prop["id"] for prop in schema}:
        await _clear(session, rows, prop_id)

    database.schema = {"properties": schema}
    for view in await views(session, database):
        view.config = prune_config(view.config, view.layout, schema)
    await session.flush()


async def _clear(session: AsyncSession, rows: tuple[Any, ...], prop_id: str) -> None:
    await session.execute(
        update(Page)
        .where(*rows, Page.properties.has_key(prop_id))
        .values(properties=Page.properties.op("-")(prop_id))
        .execution_options(synchronize_session=False)
    )


# Views -------------------------------------------------------------------------------------------


def check_config(config: ViewConfig, layout: str, schema: list[dict[str, Any]]) -> dict[str, Any]:
    """A view's config, checked against the schema (raises QueryError)."""
    q.compile_filter(config.filter, schema)
    q.sort_keys(config.sorts, schema)
    by_id = {prop["id"]: prop for prop in schema}
    if layout == "board":
        prop = by_id.get(config.group_by or "")
        if prop is None or prop["type"] not in ("select", "status"):
            raise q.QueryError("A board is grouped by a select or status property")
    elif config.group_by is not None:
        raise q.QueryError("Only boards are grouped")
    for prop_id in [*(config.visible_properties or []), *config.widths]:
        if prop_id not in by_id:
            raise q.QueryError(f"No property with id {prop_id!r}")
    if any(not 40 <= width <= 2000 for width in config.widths.values()):
        raise q.QueryError("Column widths are 40 to 2000 px")
    return config.model_dump(exclude_none=True)


def prune_config(config: dict[str, Any], layout: str, schema: list[dict[str, Any]]) -> dict[str, Any]:
    """Drop the parts of a view's config that no longer fit the schema."""
    by_id = {prop["id"]: prop for prop in schema}
    result = copy.deepcopy(config)

    def keep(node: Any) -> Any:
        if not isinstance(node, dict):
            return None
        for kind in ("and", "or"):
            if kind in node:
                items = [kept for item in node[kind] if (kept := keep(item)) is not None]
                return {kind: items} if items else None
        try:
            q.compile_filter(node, schema)
        except q.QueryError:
            return None
        return node

    if result.get("filter") is not None:
        result["filter"] = keep(result["filter"])
        if result["filter"] is None:
            result.pop("filter")
    result["sorts"] = [s for s in result.get("sorts", []) if s.get("property") in by_id]
    if "visible_properties" in result:
        result["visible_properties"] = [p for p in result["visible_properties"] if p in by_id]
    result["widths"] = {p: w for p, w in result.get("widths", {}).items() if p in by_id}
    group = by_id.get(result.get("group_by", ""))
    if layout == "board" and (group is None or group["type"] not in ("select", "status")):
        replacement = next((p for p in schema if p["type"] in ("status", "select")), None)
        if replacement is None:
            result.pop("group_by", None)
        else:
            result["group_by"] = replacement["id"]
    return result


async def create_view(
    session: AsyncSession, database: Database, page: Page, name: str, layout: str, config: ViewConfig
) -> DatabaseView:
    writable(page)
    existing = await views(session, database)
    if len(existing) >= MAX_VIEWS:
        raise DatabaseConflictError(f"A database can have up to {MAX_VIEWS} views")
    view = DatabaseView(
        database_id=database.id,
        name=name.strip() or "Untitled",
        layout=layout,
        config=check_config(config, layout, database.properties),
        position=len(existing),
    )
    session.add(view)
    await session.flush()
    return view


async def get_view(session: AsyncSession, database: Database, view_id: uuid.UUID) -> DatabaseView:
    view = await session.get(DatabaseView, view_id)
    if view is None or view.database_id != database.id:
        raise DatabaseNotFoundError
    return view


async def update_view(
    session: AsyncSession, database: Database, page: Page, view: DatabaseView, fields: dict[str, Any]
) -> DatabaseView:
    writable(page)
    layout = fields.get("layout") or view.layout
    if fields.get("name") is not None:
        view.name = fields["name"].strip() or view.name
    if "config" in fields or layout != view.layout:
        config = fields.get("config") or ViewConfig.model_validate(view.config)
        view.config = check_config(config, layout, database.properties)
        view.layout = layout
    if fields.get("position") is not None:
        ordered = [v for v in await views(session, database) if v.id != view.id]
        ordered.insert(min(fields["position"], len(ordered)), view)
        for position, item in enumerate(ordered):
            item.position = position
    await session.flush()
    return view


async def delete_view(session: AsyncSession, database: Database, page: Page, view: DatabaseView) -> None:
    writable(page)
    remaining = [v for v in await views(session, database) if v.id != view.id]
    if not remaining:
        raise DatabaseConflictError("A database keeps at least one view")
    await session.delete(view)
    for position, item in enumerate(remaining):
        item.position = position
    await session.flush()


# Rows --------------------------------------------------------------------------------------------


async def _members(session: AsyncSession, workspace_id: uuid.UUID) -> set[str]:
    ids = await session.scalars(select(Member.user_id).where(Member.workspace_id == workspace_id))
    return {str(user_id) for user_id in ids}


def _needs_members(database: Database, changes: dict[str, Any]) -> bool:
    people = {p["id"] for p in database.properties if p["type"] == "person"}
    return any(prop_id in people and value for prop_id, value in changes.items())


async def create_row(
    session: AsyncSession,
    database: Database,
    page: Page,
    user_id: uuid.UUID,
    title: str,
    icon: str | None,
    values: dict[str, Any],
) -> Page:
    writable(page)
    members = await _members(session, page.workspace_id) if _needs_members(database, values) else set()
    properties = apply_values(database.properties, {}, values, members)
    row = await pages.create_page(
        session, user_id, page.workspace_id, page.id, {"title": title, "icon": icon}, database_id=database.id
    )
    row.properties = properties
    await session.flush()
    await session.refresh(row)
    return row


async def get_row(session: AsyncSession, database: Database, row_id: uuid.UUID) -> Page:
    row = await session.get(Page, row_id)
    if row is None or row.database_id != database.id:
        raise DatabaseNotFoundError
    return row


async def update_row(
    session: AsyncSession, database: Database, page: Page, row: Page, fields: dict[str, Any]
) -> Page:
    writable(page)
    if row.archived_at is not None:
        raise DatabaseConflictError("Restore the row before changing it")
    changes = fields.get("properties") or {}
    members = await _members(session, page.workspace_id) if _needs_members(database, changes) else set()
    row.properties = apply_values(database.properties, row.properties or {}, changes, members)
    if fields.get("title") is not None:
        row.title = fields["title"]
    if "icon" in fields:
        row.icon = fields["icon"]
    await session.flush()
    await session.refresh(row)
    return row


async def query_rows(
    session: AsyncSession,
    database: Database,
    filter_: dict[str, Any] | None,
    sorts: list[dict[str, Any]] | None,
    page_size: int,
    cursor: str | None,
) -> tuple[list[Page], str | None]:
    """One page of rows matching `filter_`, in `sorts` order, and the cursor for the next page."""
    schema = database.properties
    condition = q.compile_filter(filter_, schema)
    keys = q.sort_keys(sorts, schema)
    query_id = q.fingerprint(database.id, filter_, sorts)
    statement = (
        select(Page, *(key.expression.label(f"k{i}") for i, key in enumerate(keys)))
        .where(Page.database_id == database.id, Page.archived_at.is_(None), condition)
        .order_by(*q.order_by(keys))
        .limit(page_size + 1)
    )
    if cursor:
        statement = statement.where(q.after(keys, q.decode_cursor(cursor, query_id, keys)))
    rows = (await session.execute(statement)).all()
    next_cursor = None
    if len(rows) > page_size:
        last = rows[page_size - 1]
        next_cursor = q.encode_cursor([last[i + 1] for i in range(len(keys))], query_id)
        rows = rows[:page_size]
    return [row[0] for row in rows], next_cursor
