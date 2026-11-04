import uuid

import pytest
from httpx2 import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.pages.models import Page
from app.workspaces.models import Member, Role
from tests.helpers import sign_in

pytestmark = pytest.mark.anyio

Logs = pytest.LogCaptureFixture
Headers = dict[str, str]


class Api:
    """Thin client for one signed-in user."""

    def __init__(self, client: AsyncClient, headers: Headers, workspace_id: str, user_id: str) -> None:
        self.client, self.headers, self.workspace_id, self.user_id = client, headers, workspace_id, user_id

    async def create(
        self, title: str = "", parent: dict | None = None, expect: int = 201, **extra: object
    ) -> dict:
        body = {"workspace_id": self.workspace_id, "title": title, **extra}
        if parent is not None:
            body["parent_id"] = parent["id"]
        response = await self.client.post("/api/pages", json=body, headers=self.headers)
        assert response.status_code == expect, response.text
        return response.json()

    async def get(self, page: dict, expect: int = 200) -> dict:
        response = await self.client.get(f"/api/pages/{page['id']}", headers=self.headers)
        assert response.status_code == expect, response.text
        return response.json()

    async def patch(self, page: dict, expect: int = 200, **body: object) -> dict:
        response = await self.client.patch(f"/api/pages/{page['id']}", json=body, headers=self.headers)
        assert response.status_code == expect, response.text
        return response.json()

    async def trash(self, page: dict, expect: int = 200) -> dict:
        response = await self.client.delete(f"/api/pages/{page['id']}", headers=self.headers)
        assert response.status_code == expect, response.text
        return response.json()

    async def restore(self, page: dict, expect: int = 200) -> dict:
        response = await self.client.post(f"/api/pages/{page['id']}/restore", headers=self.headers)
        assert response.status_code == expect, response.text
        return response.json()

    async def children(self, page: dict, expect: int = 200) -> list[str]:
        response = await self.client.get(f"/api/pages/{page['id']}/children", headers=self.headers)
        assert response.status_code == expect, response.text
        return [child["title"] for child in response.json()] if expect == 200 else []

    async def top_level(self, workspace_id: str | None = None, expect: int = 200) -> list[str]:
        response = await self.client.get(
            f"/api/workspaces/{workspace_id or self.workspace_id}/pages", headers=self.headers
        )
        assert response.status_code == expect, response.text
        return [page["title"] for page in response.json()] if expect == 200 else []


async def api_for(client: AsyncClient, caplog: Logs, email: str) -> Api:
    headers = await sign_in(client, caplog, email)
    workspace_id = (await client.get("/api/workspaces", headers=headers)).json()[0]["id"]
    user_id = (await client.get("/api/auth/me", headers=headers)).json()["id"]
    return Api(client, headers, workspace_id, user_id)


@pytest.fixture
async def ada(client: AsyncClient, caplog: Logs) -> Api:
    return await api_for(client, caplog, "ada@example.com")


@pytest.fixture
async def bob(client: AsyncClient, caplog: Logs, ada: Api) -> Api:
    return await api_for(client, caplog, "bob@example.com")


async def path_of(session: AsyncSession, page: dict) -> str:
    return await session.scalar(select(Page.path).where(Page.id == uuid.UUID(page["id"])))


def label(page: dict) -> str:
    return uuid.UUID(page["id"]).hex


# Create and nesting


async def test_create_top_level_page(ada: Api) -> None:
    page = await ada.create("Roadmap", icon="🗺️", cover="https://example.com/cover.png")

    assert page["title"] == "Roadmap"
    assert page["icon"] == "🗺️"
    assert page["cover"] == "https://example.com/cover.png"
    assert page["parent_id"] is None
    assert page["workspace_id"] == ada.workspace_id
    assert page["archived_at"] is None
    assert await ada.top_level() == ["Roadmap"]


async def test_untitled_by_default(ada: Api) -> None:
    response = await ada.client.post(
        "/api/pages", json={"workspace_id": ada.workspace_id}, headers=ada.headers
    )
    assert response.status_code == 201
    assert response.json()["title"] == ""


async def test_nested_pages_and_one_level_of_children(ada: Api, db_session: AsyncSession) -> None:
    docs = await ada.create("Docs")
    guides = await ada.create("Guides", parent=docs)
    setup = await ada.create("Setup", parent=guides)
    await ada.create("FAQ", parent=docs)

    assert await ada.children(docs) == ["Guides", "FAQ"]  # creation order, one level only
    assert await ada.children(guides) == ["Setup"]
    assert await ada.children(setup) == []
    assert await ada.top_level() == ["Docs"]
    assert (await ada.get(setup))["parent_id"] == guides["id"]
    assert await path_of(db_session, setup) == f"{label(docs)}.{label(guides)}.{label(setup)}"


async def test_create_rejects_bad_parents(ada: Api, bob: Api) -> None:
    bobs_page = await bob.create("Bob's")
    await ada.create("x", parent=bobs_page, expect=422)
    await ada.create("x", parent={"id": str(uuid.uuid4())}, expect=422)

    trashed = await ada.create("Old")
    await ada.trash(trashed)
    await ada.create("x", parent=trashed, expect=409)


async def test_create_validates_fields(ada: Api) -> None:
    await ada.create("x", cover="javascript:alert(1)", expect=422)
    await ada.create("x" * 201, expect=422)
    await ada.create("x", icon="i" * 33, expect=422)


# Rename


async def test_rename_changes_only_given_fields(ada: Api) -> None:
    page = await ada.create("Draft", icon="📝")

    renamed = await ada.patch(page, title="Final")

    assert renamed["title"] == "Final"
    assert renamed["icon"] == "📝"
    assert renamed["updated_at"] >= page["updated_at"]
    cleared = await ada.patch(page, icon=None, cover="https://example.com/c.jpg")
    assert (cleared["title"], cleared["icon"], cleared["cover"]) == (
        "Final",
        None,
        "https://example.com/c.jpg",
    )


async def test_update_rejects_unknown_fields(ada: Api) -> None:
    page = await ada.create("x")
    await ada.patch(page, workspace_id=str(uuid.uuid4()), expect=422)


# Move


async def test_moving_a_page_moves_its_whole_subtree(ada: Api, db_session: AsyncSession) -> None:
    a = await ada.create("A")
    a1 = await ada.create("A1", parent=a)
    a2 = await ada.create("A2", parent=a1)
    b = await ada.create("B")

    moved = await ada.patch(a, parent_id=b["id"])

    assert moved["parent_id"] == b["id"]
    assert await ada.top_level() == ["B"]
    assert await ada.children(b) == ["A"]
    assert await ada.children(a) == ["A1"]
    assert await ada.children(a1) == ["A2"]
    assert await path_of(db_session, a2) == ".".join(label(p) for p in (b, a, a1, a2))


async def test_move_to_top_level(ada: Api, db_session: AsyncSession) -> None:
    a = await ada.create("A")
    a1 = await ada.create("A1", parent=a)
    a2 = await ada.create("A2", parent=a1)

    await ada.patch(a1, parent_id=None)

    assert await ada.top_level() == ["A", "A1"]
    assert await ada.children(a) == []
    assert await path_of(db_session, a2) == f"{label(a1)}.{label(a2)}"


async def test_move_and_rename_together(ada: Api) -> None:
    a, b = await ada.create("A"), await ada.create("B")
    page = await ada.patch(a, parent_id=b["id"], title="A (moved)")
    assert (page["title"], page["parent_id"]) == ("A (moved)", b["id"])


async def test_cannot_move_into_itself_or_its_subpages(ada: Api) -> None:
    a = await ada.create("A")
    a1 = await ada.create("A1", parent=a)
    a2 = await ada.create("A2", parent=a1)

    await ada.patch(a, parent_id=a["id"], expect=422)
    await ada.patch(a, parent_id=a2["id"], expect=422)
    assert await ada.top_level() == ["A"]


async def test_similar_paths_are_not_mistaken_for_subpages(ada: Api) -> None:
    # A sibling whose path shares a prefix must not count as a descendant.
    a = await ada.create("A")
    b = await ada.create("B")
    await ada.patch(a, parent_id=b["id"])
    await ada.patch(a, parent_id=None)
    await ada.patch(b, parent_id=a["id"])
    assert await ada.children(a) == ["B"]


async def test_cannot_move_to_another_workspace_or_into_the_trash(ada: Api, bob: Api) -> None:
    page = await ada.create("A")
    await ada.patch(page, parent_id=(await bob.create("Bob's"))["id"], expect=422)

    trashed = await ada.create("Old")
    await ada.trash(trashed)
    await ada.patch(page, parent_id=trashed["id"], expect=409)


# Trash and restore


async def test_trash_hides_the_page_and_its_subpages(ada: Api) -> None:
    a = await ada.create("A")
    a1 = await ada.create("A1", parent=a)
    a2 = await ada.create("A2", parent=a1)
    await ada.create("Keep")

    trashed = await ada.trash(a)

    assert trashed["archived_at"] is not None
    assert await ada.top_level() == ["Keep"]
    for page in (a1, a2):
        assert (await ada.get(page))["archived_at"] == trashed["archived_at"]
    assert await ada.children(a) == []


async def test_trashed_pages_cannot_be_changed(ada: Api) -> None:
    page = await ada.create("A")
    await ada.trash(page)
    await ada.patch(page, title="nope", expect=409)
    assert (await ada.trash(page))["archived_at"] is not None  # trashing again is harmless


async def test_restore_brings_back_the_subtree(ada: Api) -> None:
    a = await ada.create("A")
    a1 = await ada.create("A1", parent=a)
    await ada.create("A2", parent=a1)
    await ada.trash(a)

    restored = await ada.restore(a)

    assert restored["archived_at"] is None
    assert await ada.top_level() == ["A"]
    assert await ada.children(a) == ["A1"]
    assert await ada.children(a1) == ["A2"]
    assert (await ada.restore(a))["archived_at"] is None  # restoring again is harmless


async def test_restore_keeps_separately_trashed_subpages_in_the_trash(ada: Api) -> None:
    a = await ada.create("A")
    old = await ada.create("Old", parent=a)
    await ada.create("Current", parent=a)
    await ada.trash(old)
    await ada.trash(a)

    await ada.restore(a)

    assert await ada.children(a) == ["Current"]
    assert (await ada.get(old))["archived_at"] is not None


async def test_restoring_a_subpage_of_a_trashed_page_puts_it_at_the_top(
    ada: Api, db_session: AsyncSession
) -> None:
    a = await ada.create("A")
    a1 = await ada.create("A1", parent=a)
    a2 = await ada.create("A2", parent=a1)
    await ada.trash(a)

    restored = await ada.restore(a1)

    assert restored["parent_id"] is None
    assert await ada.top_level() == ["A1"]
    assert await ada.children(a1) == ["A2"]
    assert await path_of(db_session, a2) == f"{label(a1)}.{label(a2)}"


# Access checks


async def test_other_users_cannot_reach_a_page(ada: Api, bob: Api) -> None:
    page = await ada.create("Private")

    await bob.get(page, expect=404)
    await bob.patch(page, title="hacked", expect=404)
    await bob.trash(page, expect=404)
    await bob.restore(page, expect=404)
    await bob.children(page, expect=404)
    await bob.top_level(ada.workspace_id, expect=404)
    await bob.create("x", parent=page, expect=422)
    response = await bob.client.post(
        "/api/pages", json={"workspace_id": ada.workspace_id}, headers=bob.headers
    )
    assert response.status_code == 404

    assert (await ada.get(page))["title"] == "Private"
    assert (await ada.get(page))["archived_at"] is None


async def test_unknown_pages_look_the_same_as_hidden_ones(ada: Api, bob: Api) -> None:
    hidden = (await bob.client.get(f"/api/pages/{(await ada.create('x'))['id']}", headers=bob.headers)).json()
    unknown = (await bob.client.get(f"/api/pages/{uuid.uuid4()}", headers=bob.headers)).json()
    assert hidden == unknown


async def test_workspace_members_can_edit_but_guests_cannot_see(
    ada: Api, bob: Api, db_session: AsyncSession
) -> None:
    page = await ada.create("Team")
    db_session.add(
        Member(workspace_id=uuid.UUID(ada.workspace_id), user_id=uuid.UUID(bob.user_id), role=Role.MEMBER)
    )
    await db_session.flush()

    assert (await bob.patch(page, title="Team notes"))["title"] == "Team notes"
    assert await bob.top_level(ada.workspace_id) == ["Team notes"]

    member = await db_session.get(Member, (uuid.UUID(ada.workspace_id), uuid.UUID(bob.user_id)))
    member.role = Role.GUEST
    await db_session.flush()
    await bob.get(page, expect=404)
    await bob.top_level(ada.workspace_id, expect=404)


async def test_page_routes_require_sign_in(client: AsyncClient) -> None:
    page_id = uuid.uuid4()
    for method, url in [
        ("POST", "/api/pages"),
        ("GET", f"/api/pages/{page_id}"),
        ("PATCH", f"/api/pages/{page_id}"),
        ("DELETE", f"/api/pages/{page_id}"),
        ("POST", f"/api/pages/{page_id}/restore"),
        ("GET", f"/api/pages/{page_id}/children"),
        ("GET", f"/api/workspaces/{page_id}/pages"),
    ]:
        response = await client.request(method, url, json={})
        assert response.status_code == 401, (method, url)
