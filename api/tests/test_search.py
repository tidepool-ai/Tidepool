"""Command bar search and recent pages (T22): only pages the caller can open, ever."""

import uuid

import pytest
from httpx2 import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.workspaces.models import Member, Role
from tests.test_pages import Api, Logs, api_for
from tests.test_permissions import Sharing

pytestmark = pytest.mark.anyio


@pytest.fixture
async def ada(client: AsyncClient, caplog: Logs) -> Api:
    return await api_for(client, caplog, "ada@example.com")


@pytest.fixture
async def bob(client: AsyncClient, caplog: Logs, ada: Api, db_session: AsyncSession) -> Api:
    """A member of Ada's workspace."""
    bob = await api_for(client, caplog, "bob@example.com")
    db_session.add(
        Member(workspace_id=uuid.UUID(ada.workspace_id), user_id=uuid.UUID(bob.user_id), role=Role.MEMBER)
    )
    await db_session.flush()
    return bob


async def search(
    api: Api, q: str = "", workspace_id: str | None = None, expect: int = 200, **params: object
) -> list:
    response = await api.client.get(
        f"/api/workspaces/{workspace_id or api.workspace_id}/search",
        params={"q": q, **params},
        headers=api.headers,
    )
    assert response.status_code == expect, response.text
    return response.json()


def titles(results: list) -> list[str]:
    return [r["title"] for r in results]


async def test_finds_pages_by_title_best_matches_first(ada: Api) -> None:
    await ada.create("Weekly notes")
    roadmap = await ada.create("Roadmap")
    await ada.create("Road trip", parent=roadmap)
    await ada.create("Old roadmap ideas")
    await ada.create("Unrelated")

    results = await search(ada, "ROAD")
    # Titles starting with the text first (shorter first), then the rest.
    assert titles(results) == ["Roadmap", "Road trip", "Old roadmap ideas"]
    assert results[1]["path"] == ["Roadmap"]
    assert results[1]["access"] == "full"


async def test_text_is_matched_literally(ada: Api) -> None:
    await ada.create("100% done")
    await ada.create("1000 things")
    await ada.create("snake_case")
    await ada.create("snakeXcase")
    assert titles(await search(ada, "100%")) == ["100% done"]
    assert titles(await search(ada, "e_c")) == ["snake_case"]


async def test_trashed_pages_are_left_out(ada: Api) -> None:
    page = await ada.create("Draft plan")
    await ada.trash(page)
    assert await search(ada, "plan") == []


async def test_results_never_include_pages_the_caller_cannot_open(ada: Api, bob: Api) -> None:
    sharing = Sharing(ada)
    team = await ada.create("Team plan")
    secret = await ada.create("Secret plan", parent=team)
    shared = await ada.create("Shared plan", parent=secret)
    await sharing.general(secret, "invited")
    await sharing.share(shared, "bob@example.com", "view")

    assert titles(await search(bob, "plan", workspace_id=ada.workspace_id)) == ["Team plan", "Shared plan"]
    # The breadcrumb skips the page Bob can't open.
    assert (await search(bob, "shared", workspace_id=ada.workspace_id))[0]["path"] == ["Team plan"]
    assert titles(await search(ada, "plan")) == ["Team plan", "Secret plan", "Shared plan"]


async def test_finds_matches_beyond_many_pages_the_caller_cannot_open(
    ada: Api, bob: Api, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.pages import service

    monkeypatch.setattr(service, "SEARCH_BATCH", 2)
    private = await ada.create("Private")
    await Sharing(ada).general(private, "invited")
    for i in range(5):
        await ada.create(f"Report {i}", parent=private)
    await ada.create("Report (open)")
    assert titles(await search(bob, "report", workspace_id=ada.workspace_id)) == ["Report (open)"]


async def test_recent_pages_when_empty(ada: Api, bob: Api) -> None:
    first = await ada.create("First")
    second = await ada.create("Second")
    third = await ada.create("Third")
    await ada.get(second)
    await ada.get(first)
    # Opened pages first (latest first), then the rest by last edit.
    assert titles(await search(ada)) == ["First", "Second", "Third"]
    assert titles(await search(ada, limit=1)) == ["First"]

    # Each person's own visits; pages they can't open never show.
    await Sharing(ada).general(third, "invited")
    await bob.get(second)
    assert titles(await search(bob, workspace_id=ada.workspace_id)) == ["Second", "First"]


async def test_only_members_can_search_a_workspace(ada: Api, client: AsyncClient, caplog: Logs) -> None:
    outsider = await api_for(client, caplog, "cy@example.com")
    await search(outsider, "x", workspace_id=ada.workspace_id, expect=404)
    await search(ada, "x", limit=0, expect=422)
    await search(ada, "x" * 201, expect=422)
