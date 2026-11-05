"""T16: databases (schema, rows as pages, views) and POST /api/databases/{id}/query."""

import uuid
from typing import Any

import pytest
from httpx2 import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.workspaces.models import Member
from tests.test_page_content import User, user

pytestmark = pytest.mark.anyio

Logs = pytest.LogCaptureFixture

ALL_TYPES = [
    {"name": "Name", "type": "title"},
    {"id": "notes", "name": "Notes", "type": "text"},
    {"id": "points", "name": "Points", "type": "number"},
    {
        "id": "priority",
        "name": "Priority",
        "type": "select",
        "options": [{"id": "high", "name": "High", "color": "red"}, {"id": "low", "name": "Low"}],
    },
    {
        "id": "tags",
        "name": "Tags",
        "type": "multi_select",
        "options": [{"id": "api", "name": "API"}, {"id": "web", "name": "Web"}, {"id": "ops", "name": "Ops"}],
    },
    {"id": "state", "name": "Status", "type": "status"},
    {"id": "due", "name": "Due", "type": "date"},
    {"id": "owner", "name": "Owner", "type": "person"},
    {"id": "done", "name": "Done", "type": "checkbox"},
    {"id": "link", "name": "Link", "type": "url"},
]


class Db:
    """A database driven through the API by one user."""

    def __init__(self, who: User, data: dict[str, Any]) -> None:
        self.who, self.data, self.id = who, data, data["id"]

    def url(self, path: str = "") -> str:
        return f"/api/databases/{self.id}{path}"

    async def call(self, method: str, path: str = "", **kwargs: Any):
        return await self.who.client.request(method, self.url(path), headers=self.who.headers, **kwargs)

    async def row(self, title: str = "", **properties: Any) -> dict[str, Any]:
        response = await self.call("POST", "/rows", json={"title": title, "properties": properties})
        assert response.status_code == 201, response.text
        return response.json()

    async def query(self, **body: Any):
        return await self.call("POST", "/query", json=body)

    async def titles(self, **body: Any) -> list[str]:
        response = await self.query(page_size=100, **body)
        assert response.status_code == 200, response.text
        return [row["title"] for row in response.json()["results"]]


async def new_db(who: User, properties: list[dict[str, Any]] | None = None, **extra: Any) -> Db:
    body: dict[str, Any] = {"workspace_id": who.workspace_id, "title": "Tasks", **extra}
    if properties is not None:
        body["properties"] = properties
    response = await who.client.post("/api/databases", json=body, headers=who.headers)
    assert response.status_code == 201, response.text
    return Db(who, response.json())


@pytest.fixture
async def ada(client: AsyncClient, caplog: Logs) -> User:
    return await user(client, caplog, "ada@example.com")


@pytest.fixture
async def bob(client: AsyncClient, caplog: Logs, ada: User) -> User:
    return await user(client, caplog, "bob@example.com")


@pytest.fixture
async def tasks(ada: User) -> Db:
    return await new_db(ada, ALL_TYPES)


async def join(db_session: AsyncSession, who: User, workspace_id: str) -> None:
    db_session.add(
        Member(workspace_id=uuid.UUID(workspace_id), user_id=uuid.UUID(who.user_id), role="member")
    )
    await db_session.commit()


# Databases and schema ----------------------------------------------------------------------------


async def test_a_new_database_is_a_page_with_a_title_property_and_a_table_view(ada: User) -> None:
    db = await new_db(ada)
    assert db.data["title"] == "Tasks"
    assert db.data["properties"] == [{"id": "title", "name": "Name", "type": "title"}]
    assert [(v["name"], v["layout"]) for v in db.data["views"]] == [("Table", "table")]
    tree = (await ada.client.get(f"/api/workspaces/{ada.workspace_id}/pages", headers=ada.headers)).json()
    flags = {page["id"]: page["is_database"] for page in tree}
    assert flags[db.data["page_id"]] is True
    plain = await ada.new_page()
    assert (await ada.client.get(f"/api/pages/{plain}", headers=ada.headers)).json()["is_database"] is False
    by_page = await ada.client.get(f"/api/pages/{db.data['page_id']}/database", headers=ada.headers)
    assert by_page.json()["id"] == db.id
    assert (
        await ada.client.get(f"/api/pages/{await ada.new_page()}/database", headers=ada.headers)
    ).status_code == 404


async def test_schema_with_all_ten_types(tasks: Db) -> None:
    props = {p["id"]: p for p in tasks.data["properties"]}
    assert [p["type"] for p in tasks.data["properties"]] == [t["type"] for t in ALL_TYPES]
    assert props["points"]["number_format"] == "number"
    assert [o["group"] for o in props["state"]["options"]] == ["todo", "in_progress", "done"]
    assert props["priority"]["options"][0] == {"id": "high", "name": "High", "color": "red"}


async def test_schema_ids_are_kept_and_new_ones_assigned(tasks: Db) -> None:
    properties = [
        *tasks.data["properties"],
        {"name": "Estimate", "type": "number", "number_format": "percent"},
    ]
    response = await tasks.call("PUT", "/schema", json={"properties": properties})
    assert response.status_code == 200, response.text
    new = response.json()["properties"][-1]
    assert new["name"] == "Estimate" and len(new["id"]) == 8 and new["number_format"] == "percent"
    assert [p["id"] for p in response.json()["properties"][:-1]] == [
        p["id"] for p in tasks.data["properties"]
    ]


@pytest.mark.parametrize(
    ("properties", "message"),
    [
        ([{"name": "Notes", "type": "text"}], "exactly one title"),
        ([{"name": "A", "type": "title"}, {"name": "B", "type": "title"}], "exactly one title"),
        ([{"name": "Name", "type": "title"}, {"name": "name", "type": "text"}], "Two properties are called"),
        (
            [{"name": "Name", "type": "title"}, {"name": "X", "type": "text", "options": [{"name": "a"}]}],
            "options",
        ),
        (
            [
                {"name": "Name", "type": "title"},
                {"name": "P", "type": "select", "options": [{"name": "a", "group": "done"}]},
            ],
            "only status options",
        ),
        (
            [
                {"name": "Name", "type": "title"},
                {"name": "P", "type": "select", "options": [{"name": "a"}, {"name": "A"}]},
            ],
            "listed twice",
        ),
        ([{"name": "Name", "type": "title"}, {"id": "title", "name": "X", "type": "text"}], "for the title"),
    ],
)
async def test_invalid_schemas_are_refused(ada: User, properties: list[dict[str, Any]], message: str) -> None:
    db = await new_db(ada)
    response = await db.call("PUT", "/schema", json={"properties": properties})
    assert response.status_code == 422
    assert message in response.json()["detail"]


async def test_changing_or_removing_a_property_clears_its_values_and_views(tasks: Db) -> None:
    row = await tasks.row("A", points=3, notes="keep", tags=["api", "web"], priority="high")
    await tasks.call(
        "POST",
        "/views",
        json={
            "name": "Sorted",
            "config": {
                "filter": {"and": [{"property": "points", "operator": "greater_than", "value": 1}]},
                "sorts": [{"property": "points", "direction": "descending"}],
                "visible_properties": ["notes", "points"],
            },
        },
    )
    properties = {p["id"]: p for p in tasks.data["properties"]}
    properties["points"] = {**properties["points"], "type": "text"}  # type change
    properties["tags"] = {
        **properties["tags"],
        "options": [o for o in properties["tags"]["options"] if o["id"] != "web"],
    }
    properties["priority"] = {**properties["priority"], "options": [{"id": "low", "name": "Low"}]}
    del properties["link"]
    response = await tasks.call("PUT", "/schema", json={"properties": list(properties.values())})
    assert response.status_code == 200, response.text

    stored = (await tasks.call("GET", f"/rows/{row['id']}")).json()["properties"]
    assert stored == {"notes": "keep", "tags": ["api"]}
    view = response.json()["views"][-1]
    assert "filter" not in view["config"] or view["config"]["filter"] is None
    assert view["config"]["sorts"] == [{"property": "points", "direction": "descending"}]  # still a property
    assert view["config"]["visible_properties"] == ["notes", "points"]


async def test_removing_the_last_option_of_a_multi_select_clears_the_value(tasks: Db) -> None:
    row = await tasks.row("A", tags=["ops"])
    properties = {p["id"]: p for p in tasks.data["properties"]}
    properties["tags"] = {**properties["tags"], "options": [{"id": "api", "name": "API"}]}
    await tasks.call("PUT", "/schema", json={"properties": list(properties.values())})
    assert (await tasks.call("GET", f"/rows/{row['id']}")).json()["properties"] == {}


# Row values ------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("prop", "given", "stored"),
    [
        ("notes", "Needs review", "Needs review"),
        ("notes", "", None),
        ("points", 42.5, 42.5),
        ("points", -3, -3),
        ("priority", "high", "high"),
        ("tags", ["web", "api", "web"], ["web", "api"]),
        ("tags", [], None),
        ("state", "in-progress", "in-progress"),
        ("due", "2026-11-05", {"start": "2026-11-05", "end": None}),
        ("due", {"start": "2026-11-05", "end": "2026-11-07"}, {"start": "2026-11-05", "end": "2026-11-07"}),
        ("done", True, True),
        ("done", False, None),
        ("link", "https://example.com/a?b=1", "https://example.com/a?b=1"),
    ],
)
async def test_each_type_stores_its_values(tasks: Db, prop: str, given: Any, stored: Any) -> None:
    row = await tasks.row("Row", **{prop: given})
    assert row["properties"].get(prop) == stored


@pytest.mark.parametrize(
    ("prop", "given", "message"),
    [
        ("notes", 5, "expected text"),
        ("notes", "x" * 2001, "up to 2000"),
        ("points", "5", "expected a number"),
        ("points", True, "expected a number"),
        ("priority", "medium", "isn't one of its options"),
        ("tags", "api", "expected a list"),
        ("tags", ["api", "nope"], "isn't one of its options"),
        ("state", "high", "isn't one of its options"),
        ("due", "5 Nov", "dates look like"),
        ("due", "2026-02-30", "isn't a real date"),
        ("due", {"start": "2026-11-05", "end": "2026-11-01"}, "before the start"),
        ("owner", ["not-a-member"], "must be in the workspace"),
        ("done", "yes", "true or false"),
        ("link", "javascript:alert(1)", "http:// or https://"),
        ("nope", 1, "No property with id"),
        ("title", "x", "row's title"),
    ],
)
async def test_values_that_dont_fit_are_refused(tasks: Db, prop: str, given: Any, message: str) -> None:
    response = await tasks.call("POST", "/rows", json={"title": "Row", "properties": {prop: given}})
    assert response.status_code == 422
    assert message in response.json()["detail"]


async def test_people_must_be_workspace_members(tasks: Db, bob: User, db_session: AsyncSession) -> None:
    ada = tasks.who
    assert (
        await ada.client.post(
            tasks.url("/rows"), json={"properties": {"owner": [bob.user_id]}}, headers=ada.headers
        )
    ).status_code == 422
    await join(db_session, bob, ada.workspace_id)
    row = await tasks.row("Assigned", owner=[ada.user_id, bob.user_id])
    assert row["properties"]["owner"] == [ada.user_id, bob.user_id]


async def test_updates_change_only_what_is_sent(tasks: Db) -> None:
    row = await tasks.row("Draft", notes="a", points=1)
    response = await tasks.call(
        "PATCH", f"/rows/{row['id']}", json={"title": "Final", "properties": {"notes": None, "done": True}}
    )
    assert response.status_code == 200
    assert response.json()["title"] == "Final"
    assert response.json()["properties"] == {"points": 1, "done": True}


# Rows are pages ----------------------------------------------------------------------------------


async def test_rows_are_pages_kept_out_of_the_sidebar(tasks: Db) -> None:
    ada = tasks.who
    row = await tasks.row("Row")
    page = (await ada.client.get(f"/api/pages/{row['id']}", headers=ada.headers)).json()
    assert page["database_id"] == tasks.id and page["parent_id"] == tasks.data["page_id"]
    children = await ada.client.get(f"/api/pages/{tasks.data['page_id']}/children", headers=ada.headers)
    assert children.json() == []
    # Ordinary pages can't go inside a database or a row; rows can't leave.
    inside = await ada.client.post(
        "/api/pages",
        json={"workspace_id": ada.workspace_id, "parent_id": tasks.data["page_id"]},
        headers=ada.headers,
    )
    assert inside.status_code == 422
    under_row = await ada.client.post(
        "/api/pages", json={"workspace_id": ada.workspace_id, "parent_id": row["id"]}, headers=ada.headers
    )
    assert under_row.status_code == 422
    moved = await ada.client.patch(f"/api/pages/{row['id']}", json={"parent_id": None}, headers=ada.headers)
    assert moved.status_code == 422


async def test_trashed_rows_and_databases(tasks: Db) -> None:
    ada = tasks.who
    keep, gone = await tasks.row("Keep"), await tasks.row("Gone")
    await ada.client.delete(f"/api/pages/{gone['id']}", headers=ada.headers)
    assert await tasks.titles() == ["Keep"]
    assert (await ada.client.post(f"/api/pages/{gone['id']}/restore", headers=ada.headers)).status_code == 200
    assert await tasks.titles() == ["Keep", "Gone"]

    await ada.client.delete(f"/api/pages/{tasks.data['page_id']}", headers=ada.headers)
    assert (await tasks.call("GET")).json()["archived_at"] is not None
    assert (await tasks.call("POST", "/rows", json={"title": "x"})).status_code == 409
    assert (await tasks.call("PATCH", f"/rows/{keep['id']}", json={"title": "x"})).status_code == 409
    assert (await tasks.call("PUT", "/schema", json={"properties": ALL_TYPES})).status_code == 409
    restore_row = await ada.client.post(f"/api/pages/{keep['id']}/restore", headers=ada.headers)
    assert restore_row.status_code == 409  # restore the database first


async def test_other_people_and_signed_out_callers_get_nothing(
    tasks: Db, bob: User, client: AsyncClient
) -> None:
    row = await tasks.row("Private")
    view_id = tasks.data["views"][0]["id"]
    calls = [
        ("GET", ""),
        ("PUT", "/schema"),
        ("POST", "/rows"),
        ("GET", f"/rows/{row['id']}"),
        ("PATCH", f"/rows/{row['id']}"),
        ("POST", "/query"),
        ("POST", "/views"),
        ("PATCH", f"/views/{view_id}"),
        ("DELETE", f"/views/{view_id}"),
    ]
    bodies = {"PUT": {"properties": ALL_TYPES}, "POST": {"name": "x"}, "PATCH": {}}
    for method, path in calls:
        body = {"title": "x"} if path == "/rows" else ({} if path == "/query" else bodies.get(method))
        as_bob = await client.request(method, tasks.url(path), json=body, headers=bob.headers)
        assert as_bob.status_code == 404, (method, path, as_bob.text)
        anonymous = await client.request(method, tasks.url(path), json=body)
        assert anonymous.status_code == 401, (method, path)


# Filters ---------------------------------------------------------------------------------------


@pytest.fixture
async def filled(tasks: Db, db_session: AsyncSession, bob: User) -> Db:
    ada = tasks.who
    await join(db_session, bob, ada.workspace_id)
    await tasks.row(
        "Alpha task",
        notes="Fix the API",
        points=5,
        priority="high",
        tags=["api", "web"],
        state="done",
        due="2026-11-01",
        owner=[ada.user_id],
        done=True,
        link="https://alpha.example.com",
    )
    await tasks.row(
        "Beta",
        notes="docs 100%",
        points=1.5,
        priority="low",
        tags=["web"],
        state="in-progress",
        due={"start": "2026-11-05", "end": "2026-11-09"},
        owner=[bob.user_id],
        link="http://beta.dev",
    )
    await tasks.row(
        "gamma",
        points=-2,
        tags=["ops"],
        state="not-started",
        due="2026-12-24",
        owner=[ada.user_id, bob.user_id],
    )
    await tasks.row("Delta task", notes="", points=5, priority="high")
    await tasks.row("Epsilon")
    return tasks


def cond(prop: str, operator: str, value: Any = None) -> dict[str, Any]:
    body: dict[str, Any] = {"property": prop, "operator": operator}
    if value is not None:
        body["value"] = value
    return body


FILTER_CASES = [
    # title
    (cond("title", "is", "Beta"), ["Beta"]),
    (cond("title", "is_not", "Beta"), ["Alpha task", "gamma", "Delta task", "Epsilon"]),
    (cond("title", "contains", "TASK"), ["Alpha task", "Delta task"]),
    (cond("title", "does_not_contain", "task"), ["Beta", "gamma", "Epsilon"]),
    (cond("title", "starts_with", "g"), ["gamma"]),
    (cond("title", "ends_with", "ta"), ["Beta"]),
    (cond("title", "is_not_empty"), ["Alpha task", "Beta", "gamma", "Delta task", "Epsilon"]),
    # text
    (cond("notes", "contains", "api"), ["Alpha task"]),
    (cond("notes", "contains", "100%"), ["Beta"]),  # % is literal, not a wildcard
    (cond("notes", "contains", "_"), []),
    (cond("notes", "does_not_contain", "api"), ["Beta", "gamma", "Delta task", "Epsilon"]),
    (cond("notes", "is", "docs 100%"), ["Beta"]),
    # "is not" includes rows with no value
    (cond("notes", "is_not", "docs 100%"), ["Alpha task", "gamma", "Delta task", "Epsilon"]),
    (cond("notes", "is_empty"), ["gamma", "Delta task", "Epsilon"]),
    (cond("notes", "is_not_empty"), ["Alpha task", "Beta"]),
    # number
    (cond("points", "equals", 5), ["Alpha task", "Delta task"]),
    (cond("points", "not_equals", 5), ["Beta", "gamma", "Epsilon"]),
    (cond("points", "greater_than", 1.5), ["Alpha task", "Delta task"]),
    (cond("points", "greater_than_or_equal", 1.5), ["Alpha task", "Beta", "Delta task"]),
    (cond("points", "less_than", 0), ["gamma"]),
    (cond("points", "less_than_or_equal", 1.5), ["Beta", "gamma"]),
    (cond("points", "is_empty"), ["Epsilon"]),
    # select
    (cond("priority", "is", "high"), ["Alpha task", "Delta task"]),
    (cond("priority", "is_not", "high"), ["Beta", "gamma", "Epsilon"]),
    (cond("priority", "is_empty"), ["gamma", "Epsilon"]),
    (cond("priority", "is_not_empty"), ["Alpha task", "Beta", "Delta task"]),
    # multi-select
    (cond("tags", "contains", "web"), ["Alpha task", "Beta"]),
    (cond("tags", "does_not_contain", "web"), ["gamma", "Delta task", "Epsilon"]),
    (cond("tags", "is_empty"), ["Delta task", "Epsilon"]),
    (cond("tags", "is_not_empty"), ["Alpha task", "Beta", "gamma"]),
    # status
    (cond("state", "is", "done"), ["Alpha task"]),
    (cond("state", "is_not", "done"), ["Beta", "gamma", "Delta task", "Epsilon"]),
    (cond("state", "is_empty"), ["Delta task", "Epsilon"]),
    # date (by start date)
    (cond("due", "is", "2026-11-05"), ["Beta"]),
    (cond("due", "before", "2026-11-05"), ["Alpha task"]),
    (cond("due", "after", "2026-11-05"), ["gamma"]),
    (cond("due", "on_or_before", "2026-11-05"), ["Alpha task", "Beta"]),
    (cond("due", "on_or_after", "2026-11-05"), ["Beta", "gamma"]),
    (cond("due", "is_empty"), ["Delta task", "Epsilon"]),
    (cond("due", "is_not_empty"), ["Alpha task", "Beta", "gamma"]),
    # checkbox
    (cond("done", "is", True), ["Alpha task"]),
    (cond("done", "is", False), ["Beta", "gamma", "Delta task", "Epsilon"]),
    # url
    (cond("link", "starts_with", "https://"), ["Alpha task"]),
    (cond("link", "contains", "beta"), ["Beta"]),
    (cond("link", "is_empty"), ["gamma", "Delta task", "Epsilon"]),
    # groups
    ({"and": [cond("priority", "is", "high"), cond("done", "is", True)]}, ["Alpha task"]),
    ({"or": [cond("state", "is", "done"), cond("points", "less_than", 0)]}, ["Alpha task", "gamma"]),
    (
        {
            "and": [
                cond("title", "does_not_contain", "Epsilon"),
                {"or": [cond("tags", "contains", "ops"), cond("priority", "is", "high")]},
            ]
        },
        ["Alpha task", "gamma", "Delta task"],
    ),
    ({"and": []}, ["Alpha task", "Beta", "gamma", "Delta task", "Epsilon"]),
]


@pytest.mark.parametrize(
    ("filter_", "expected"),
    FILTER_CASES,
    ids=[f"{c[0].get('property', 'group')}-{c[0].get('operator', i)}" for i, c in enumerate(FILTER_CASES)],
)
async def test_filter_operators(filled: Db, filter_: dict[str, Any], expected: list[str]) -> None:
    assert await filled.titles(filter=filter_) == expected


async def test_person_filters(filled: Db, bob: User) -> None:
    ada = filled.who
    assert await filled.titles(filter=cond("owner", "contains", ada.user_id)) == ["Alpha task", "gamma"]
    assert await filled.titles(filter=cond("owner", "contains", bob.user_id)) == ["Beta", "gamma"]
    assert await filled.titles(filter=cond("owner", "does_not_contain", bob.user_id)) == [
        "Alpha task",
        "Delta task",
        "Epsilon",
    ]
    assert await filled.titles(filter=cond("owner", "is_empty")) == ["Delta task", "Epsilon"]


@pytest.mark.parametrize(
    ("filter_", "message"),
    [
        (cond("nope", "is", "x"), "No property with id"),
        (cond("points", "contains", "5"), "can be filtered with"),
        (cond("done", "is_empty"), "can be filtered with"),
        (cond("points", "equals", "five"), "filter by a number"),
        (cond("priority", "is", "medium"), "isn't one of its options"),
        (cond("due", "before", "tomorrow"), "dates look like"),
        (cond("owner", "contains", "someone"), "person's id"),
        (cond("notes", "is_empty", "x"), "takes no value"),
        ({"and": [cond("notes", "is_empty")], "or": []}, '"and" or "or"'),
        ({"and": [{"and": [{"and": [{"and": [cond("notes", "is_empty")]}]}]}]}, "nested 3 levels"),
        ({"and": [cond("notes", "is_empty")] * 51}, "up to 50 conditions"),
        ({"property": "notes"}, "A condition is"),
    ],
)
async def test_filters_that_dont_fit_are_refused(tasks: Db, filter_: dict[str, Any], message: str) -> None:
    response = await tasks.query(filter=filter_)
    assert response.status_code == 422
    assert message in response.json()["detail"]


# Sorts -----------------------------------------------------------------------------------------


def sort(prop: str, direction: str = "ascending") -> dict[str, str]:
    return {"property": prop, "direction": direction}


SORT_CASES = [
    ([], ["Alpha task", "Beta", "gamma", "Delta task", "Epsilon"]),  # creation order
    ([sort("title")], ["Alpha task", "Beta", "Delta task", "Epsilon", "gamma"]),
    ([sort("title", "descending")], ["gamma", "Epsilon", "Delta task", "Beta", "Alpha task"]),
    (
        [sort("points")],
        ["gamma", "Beta", "Alpha task", "Delta task", "Epsilon"],
    ),  # empty last, ties by creation
    ([sort("points", "descending")], ["Alpha task", "Delta task", "Beta", "gamma", "Epsilon"]),
    ([sort("priority")], ["Alpha task", "Delta task", "Beta", "gamma", "Epsilon"]),  # option order: High, Low
    ([sort("priority", "descending")], ["Beta", "Alpha task", "Delta task", "gamma", "Epsilon"]),
    (
        [sort("state")],
        ["gamma", "Beta", "Alpha task", "Delta task", "Epsilon"],
    ),  # Not started, In progress, Done
    ([sort("tags")], ["Alpha task", "Beta", "gamma", "Delta task", "Epsilon"]),  # first tag, in option order
    ([sort("due", "descending")], ["gamma", "Beta", "Alpha task", "Delta task", "Epsilon"]),
    ([sort("done", "descending")], ["Alpha task", "Beta", "gamma", "Delta task", "Epsilon"]),
    ([sort("notes")], ["Beta", "Alpha task", "gamma", "Delta task", "Epsilon"]),  # docs…, Fix…
    (
        [sort("priority"), sort("title", "descending")],
        ["Delta task", "Alpha task", "Beta", "gamma", "Epsilon"],
    ),
]


@pytest.mark.parametrize(("sorts", "expected"), SORT_CASES)
async def test_sorts(filled: Db, sorts: list[dict[str, str]], expected: list[str]) -> None:
    assert await filled.titles(sorts=sorts) == expected


@pytest.mark.parametrize(
    ("sorts", "message"),
    [
        ([sort("nope")], "No property with id"),
        ([{"property": "points", "direction": "up"}], "ascending"),
        ([sort("points")] * 6, "up to 5"),
    ],
)
async def test_sorts_that_dont_fit_are_refused(tasks: Db, sorts: list[dict[str, str]], message: str) -> None:
    response = await tasks.query(sorts=sorts)
    assert response.status_code == 422
    assert message in response.json()["detail"]


# Pagination ------------------------------------------------------------------------------------


async def read_all(db: Db, page_size: int, **body: Any) -> list[str]:
    titles: list[str] = []
    cursor = None
    for _ in range(500):
        response = await db.query(page_size=page_size, **({"cursor": cursor} if cursor else {}), **body)
        assert response.status_code == 200, response.text
        data = response.json()
        assert len(data["results"]) <= page_size
        titles += [row["title"] for row in data["results"]]
        assert data["has_more"] == (data["next_cursor"] is not None)
        cursor = data["next_cursor"]
        if cursor is None:
            return titles
    raise AssertionError("never finished")


@pytest.fixture
async def many(tasks: Db) -> Db:
    # 120 rows: lots of ties, empty values, mixed signs.
    for i in range(120):
        props: dict[str, Any] = {}
        if i % 7:
            props["points"] = (i * 37) % 11 - 5
        if i % 3 == 0:
            props["priority"] = "high" if i % 2 else "low"
        props["done"] = i % 4 == 0
        await tasks.row(f"Row {i:03}", **props)
    return tasks


@pytest.mark.parametrize(
    "sorts",
    [
        [],
        [sort("points")],
        [sort("points", "descending")],
        [sort("priority"), sort("points", "descending")],
        [sort("done", "descending"), sort("title", "descending")],
    ],
)
async def test_cursor_pages_cover_every_row_once_in_order(many: Db, sorts: list[dict[str, str]]) -> None:
    # The order the query itself defines, read in big pages...
    one_go = await read_all(many, 100, sorts=sorts)
    assert len(one_go) == 120 and len(set(one_go)) == 120
    # ...is exactly what small pages add up to.
    for size in (1, 7, 25):
        assert await read_all(many, size, sorts=sorts) == one_go, size


async def test_paging_with_a_filter(many: Db) -> None:
    filter_ = cond("points", "greater_than_or_equal", 0)
    expected = await many.titles(filter=filter_, sorts=[sort("points")])
    assert await read_all(many, 9, filter=filter_, sorts=[sort("points")]) == expected
    assert 0 < len(expected) < 120


async def test_default_page_size_and_limits(many: Db) -> None:
    first = (await many.query()).json()
    assert len(first["results"]) == 50 and first["has_more"]
    assert (await many.query(page_size=101)).status_code == 422
    assert (await many.query(page_size=0)).status_code == 422


async def test_a_cursor_only_works_for_its_own_query(many: Db) -> None:
    cursor = (await many.query(page_size=10, sorts=[sort("points")])).json()["next_cursor"]
    other = await many.query(page_size=10, sorts=[sort("title")], cursor=cursor)
    assert other.status_code == 422
    assert "different query" in other.json()["detail"]
    garbage = await many.query(page_size=10, cursor="not-a-cursor")
    assert garbage.status_code == 422


# Views -----------------------------------------------------------------------------------------


async def test_views_store_their_own_filters_and_sorts(filled: Db) -> None:
    config = {
        "filter": cond("priority", "is", "high"),
        "sorts": [sort("title", "descending")],
        "visible_properties": ["points"],
    }
    response = await filled.call("POST", "/views", json={"name": "Urgent", "config": config})
    assert response.status_code == 201, response.text
    view = response.json()
    assert view["position"] == 1 and view["config"]["visible_properties"] == ["points"]

    assert await filled.titles(view_id=view["id"]) == ["Delta task", "Alpha task"]
    # An explicit filter or sort wins over the view's.
    assert await filled.titles(view_id=view["id"], sorts=[]) == ["Alpha task", "Delta task"]
    assert await filled.titles(view_id=view["id"], filter=None) == [
        "gamma",
        "Epsilon",
        "Delta task",
        "Beta",
        "Alpha task",
    ]
    assert [v["name"] for v in (await filled.call("GET")).json()["views"]] == ["Table", "Urgent"]


async def test_boards_group_by_select_or_status(tasks: Db) -> None:
    bad = await tasks.call(
        "POST", "/views", json={"name": "Board", "layout": "board", "config": {"group_by": "points"}}
    )
    assert bad.status_code == 422 and "select or status" in bad.json()["detail"]
    board = await tasks.call(
        "POST", "/views", json={"name": "Board", "layout": "board", "config": {"group_by": "state"}}
    )
    assert board.status_code == 201
    not_board = await tasks.call("POST", "/views", json={"name": "T", "config": {"group_by": "state"}})
    assert not_board.status_code == 422


async def test_views_reject_unknown_properties_and_bad_widths(tasks: Db) -> None:
    for config in [
        {"sorts": [sort("nope")]},
        {"visible_properties": ["nope"]},
        {"widths": {"points": 10}},
        {"filter": cond("nope", "is", "x")},
    ]:
        response = await tasks.call("POST", "/views", json={"name": "V", "config": config})
        assert response.status_code == 422, config


async def test_views_rename_reorder_change_layout_and_delete(tasks: Db) -> None:
    first = tasks.data["views"][0]["id"]
    second = (await tasks.call("POST", "/views", json={"name": "Two"})).json()["id"]
    renamed = await tasks.call("PATCH", f"/views/{second}", json={"name": "Second", "position": 0})
    assert renamed.status_code == 200
    assert [(v["name"], v["position"]) for v in (await tasks.call("GET")).json()["views"]] == [
        ("Second", 0),
        ("Table", 1),
    ]
    to_board = await tasks.call(
        "PATCH", f"/views/{second}", json={"layout": "board", "config": {"group_by": "priority"}}
    )
    assert to_board.json()["layout"] == "board"
    assert (
        await tasks.call("PATCH", f"/views/{second}", json={"layout": "board", "config": {}})
    ).status_code == 422

    assert (await tasks.call("DELETE", f"/views/{second}")).status_code == 204
    last = await tasks.call("DELETE", f"/views/{first}")
    assert last.status_code == 409 and "at least one view" in last.json()["detail"]
    assert (await tasks.call("GET", f"/views/{uuid.uuid4()}")).status_code in (404, 405)


async def test_a_board_follows_its_group_property_being_removed(tasks: Db) -> None:
    board = (
        await tasks.call(
            "POST", "/views", json={"name": "B", "layout": "board", "config": {"group_by": "priority"}}
        )
    ).json()
    properties = [p for p in tasks.data["properties"] if p["id"] != "priority"]
    response = await tasks.call("PUT", "/schema", json={"properties": properties})
    regrouped = next(v for v in response.json()["views"] if v["id"] == board["id"])
    assert regrouped["config"]["group_by"] == "state"  # the next select/status property
