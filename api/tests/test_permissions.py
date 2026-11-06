"""Page access levels inherited down the tree, overrides, general access and the share endpoints (T21)."""

import logging
import uuid

import pytest
from httpx2 import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.realtime.access import Access, page_access
from app.workspaces.models import Member, Role, Workspace
from tests.test_pages import Api, Logs, api_for

pytestmark = pytest.mark.anyio


@pytest.fixture
async def ada(client: AsyncClient, caplog: Logs) -> Api:
    """Owns the workspace the tests share pages from."""
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


@pytest.fixture
async def cy(client: AsyncClient, caplog: Logs, ada: Api) -> Api:
    """Someone outside Ada's workspace."""
    return await api_for(client, caplog, "cy@example.com")


class Sharing:
    def __init__(self, api: Api) -> None:
        self.api = api

    async def permissions(self, page: dict, expect: int = 200) -> dict:
        response = await self.api.client.get(f"/api/pages/{page['id']}/permissions", headers=self.api.headers)
        assert response.status_code == expect, response.text
        return response.json()

    async def share(self, page: dict, email: str, level: str = "edit", expect: int = 200) -> dict:
        response = await self.api.client.post(
            f"/api/pages/{page['id']}/share", json={"email": email, "level": level}, headers=self.api.headers
        )
        assert response.status_code == expect, response.text
        return response.json()

    async def set_level(self, page: dict, user_id: str, level: str, expect: int = 200) -> dict:
        response = await self.api.client.put(
            f"/api/pages/{page['id']}/permissions/{user_id}", json={"level": level}, headers=self.api.headers
        )
        assert response.status_code == expect, response.text
        return response.json()

    async def remove(self, page: dict, user_id: str, expect: int = 200) -> dict:
        response = await self.api.client.delete(
            f"/api/pages/{page['id']}/permissions/{user_id}", headers=self.api.headers
        )
        assert response.status_code == expect, response.text
        return response.json()

    async def general(self, page: dict, access: str | None, level: str = "full", expect: int = 200) -> dict:
        response = await self.api.client.put(
            f"/api/pages/{page['id']}/general-access",
            json={"access": access, "level": level},
            headers=self.api.headers,
        )
        assert response.status_code == expect, response.text
        return response.json()


async def content(api: Api, page: dict, expect: int) -> None:
    doc = {"content": {"type": "doc", "content": []}}
    response = await api.client.put(f"/api/pages/{page['id']}/content", json=doc, headers=api.headers)
    assert response.status_code == expect, response.text


# Defaults


async def test_workspace_members_have_full_access_by_default(ada: Api, bob: Api) -> None:
    page = await ada.create("Team")
    child = await ada.create("Notes", parent=page)
    assert (await bob.get(child))["access"] == "full"
    assert (await ada.get(page))["access"] == "full"
    shared = await Sharing(ada).permissions(page)
    assert shared["general"] == {"access": "workspace", "level": "full", "inherited_from": None}
    assert shared["people"] == []
    assert shared["can_share"] is True


# Inheritance and overrides


async def test_general_access_is_inherited_and_can_be_overridden_lower_down(ada: Api, bob: Api) -> None:
    sharing = Sharing(ada)
    team = await ada.create("Team")
    plans = await ada.create("Plans", parent=team)
    secret = await ada.create("Secret", parent=plans)

    await sharing.general(team, "workspace", "view")
    for page in (team, plans, secret):
        assert (await bob.get(page))["access"] == "view"
    shown = await sharing.permissions(secret)
    assert shown["general"]["access"] == "workspace"
    assert shown["general"]["inherited_from"] == {"id": team["id"], "title": "Team"}

    # Lower down: invited only, so members lose the subtree; above it they keep their view.
    await sharing.general(plans, "invited")
    await bob.get(plans, expect=404)
    await bob.get(secret, expect=404)
    assert (await bob.get(team))["access"] == "view"
    assert await bob.children(team) == []

    # Further down again: open to the workspace with edit access.
    await sharing.general(secret, "workspace", "edit")
    assert (await bob.get(secret))["access"] == "edit"

    # Back to inheriting.
    await sharing.general(plans, None)
    assert (await bob.get(plans))["access"] == "view"


async def test_own_access_is_inherited_and_the_nearest_grant_wins(ada: Api, bob: Api, cy: Api) -> None:
    sharing = Sharing(ada)
    team = await ada.create("Team")
    plans = await ada.create("Plans", parent=team)
    q1 = await ada.create("Q1", parent=plans)

    await sharing.share(team, "cy@example.com", "view")
    assert (await cy.get(q1))["access"] == "view"
    await cy.patch(q1, title="Mine", expect=403)
    await content(cy, q1, 403)

    # An override on Plans raises it there and below.
    await sharing.set_level(plans, cy.user_id, "edit")
    assert (await cy.get(team))["access"] == "view"
    assert (await cy.get(q1))["access"] == "edit"
    await cy.patch(q1, title="Q1 plan")
    await content(cy, q1, 200)

    # A further override can lower it again.
    await sharing.set_level(q1, cy.user_id, "comment")
    assert (await cy.get(q1))["access"] == "comment"
    await content(cy, q1, 403)

    shown = await sharing.permissions(q1)
    assert [(p["email"], p["level"], p["inherited_from"]) for p in shown["people"]] == [
        ("cy@example.com", "comment", None)
    ]
    shown = await sharing.permissions(plans)
    assert [(p["email"], p["level"], p["inherited_from"]) for p in shown["people"]] == [
        ("cy@example.com", "edit", None)
    ]

    # Removing an override goes back to what's inherited.
    await sharing.remove(q1, cy.user_id)
    assert (await cy.get(q1))["access"] == "edit"
    shown = await sharing.permissions(q1)
    assert shown["people"][0]["inherited_from"] == {"id": plans["id"], "title": "Plans"}
    await sharing.remove(q1, cy.user_id, expect=404)


async def test_the_higher_of_own_and_general_access_applies(ada: Api, bob: Api) -> None:
    sharing = Sharing(ada)
    page = await ada.create("Wiki")
    await sharing.general(page, "workspace", "view")
    await sharing.share(page, "bob@example.com", "edit")
    assert (await bob.get(page))["access"] == "edit"
    await sharing.set_level(page, bob.user_id, "view")
    await sharing.general(page, "workspace", "comment")
    assert (await bob.get(page))["access"] == "comment"


async def test_moving_a_page_changes_what_it_inherits(ada: Api, bob: Api) -> None:
    sharing = Sharing(ada)
    private = await ada.create("Private")
    await sharing.general(private, "invited")
    open_page = await ada.create("Open")
    assert (await bob.get(open_page))["access"] == "full"
    await ada.patch(open_page, parent_id=private["id"])
    await bob.get(open_page, expect=404)
    assert await bob.top_level(ada.workspace_id) == []


async def test_owners_and_admins_always_have_full_access(
    ada: Api, bob: Api, db_session: AsyncSession
) -> None:
    page = await Sharing(bob).api.create("Bob's", workspace_id=ada.workspace_id)
    await Sharing(bob).general(page, "invited")
    # Bob narrowed it, so he was given his own full access.
    assert (await bob.get(page))["access"] == "full"
    assert (await ada.get(page))["access"] == "full"
    member = await db_session.get(Member, (uuid.UUID(ada.workspace_id), uuid.UUID(bob.user_id)))
    member.role = Role.ADMIN
    await db_session.flush()
    await Sharing(ada).remove(page, bob.user_id)
    assert (await bob.get(page))["access"] == "full"


# Levels


async def test_what_each_level_allows(ada: Api, cy: Api) -> None:
    sharing = Sharing(ada)
    page = await ada.create("Doc")
    for level, can_edit, can_share in [
        ("view", False, False),
        ("comment", False, False),
        ("edit", True, False),
        ("full", True, True),
    ]:
        await sharing.share(page, "cy@example.com", level)
        assert (await cy.get(page))["access"] == level
        await content(cy, page, 200 if can_edit else 403)
        await cy.create("Sub", parent=page, workspace_id=ada.workspace_id, expect=201 if can_edit else 403)
        assert (await Sharing(cy).permissions(page))["can_share"] is can_share
        await Sharing(cy).share(page, "dan@example.com", "view", expect=200 if can_share else 403)
    # Moving and trashing need full access.
    await sharing.set_level(page, cy.user_id, "edit")
    await cy.trash(page, expect=403)
    await sharing.set_level(page, cy.user_id, "full")
    await cy.trash(page)


async def test_viewers_can_read_a_database_but_not_change_it(ada: Api, cy: Api) -> None:
    created = await ada.client.post(
        "/api/databases", json={"workspace_id": ada.workspace_id, "title": "Tasks"}, headers=ada.headers
    )
    database = created.json()
    await Sharing(ada).share({"id": database["page_id"]}, "cy@example.com", "view")
    query = await cy.client.post(f"/api/databases/{database['id']}/query", json={}, headers=cy.headers)
    assert query.status_code == 200
    row = await cy.client.post(
        f"/api/databases/{database['id']}/rows", json={"title": "x"}, headers=cy.headers
    )
    assert row.status_code == 403
    assert row.json()["detail"] == "You can view this page but not change it"


async def test_live_editing_follows_the_level(ada: Api, cy: Api, db_session: AsyncSession) -> None:
    page = await ada.create("Live")
    page_id, cy_id = uuid.UUID(page["id"]), uuid.UUID(cy.user_id)
    assert await page_access(db_session, page_id, cy_id) is Access.NONE
    await Sharing(ada).share(page, "cy@example.com", "comment")
    assert await page_access(db_session, page_id, cy_id) is Access.READ
    await Sharing(ada).set_level(page, cy.user_id, "edit")
    assert await page_access(db_session, page_id, cy_id) is Access.WRITE


# General access


async def test_public_pages_can_be_viewed_by_anyone_signed_in(ada: Api, cy: Api) -> None:
    page = await ada.create("Launch")
    child = await ada.create("FAQ", parent=page)
    await cy.get(page, expect=404)
    await Sharing(ada).general(page, "public", "edit")
    assert (await cy.get(child))["access"] == "view"
    await content(cy, child, 403)
    # Not added to the workspace: they only have the link.
    await cy.top_level(ada.workspace_id, expect=404)


async def test_invited_only_keeps_out_members_but_not_invited_people(ada: Api, bob: Api, cy: Api) -> None:
    page = await ada.create("HR")
    await Sharing(ada).general(page, "invited")
    await bob.get(page, expect=404)
    assert await bob.top_level(ada.workspace_id) == []
    await Sharing(ada).share(page, "bob@example.com", "view")
    assert (await bob.get(page))["access"] == "view"
    assert await bob.top_level(ada.workspace_id) == ["HR"]


async def test_nobody_locks_themselves_out(ada: Api, bob: Api) -> None:
    sharing = Sharing(bob)
    page = await ada.create("Shared")
    # Bob (full through the workspace) narrows it: he keeps full access.
    shown = await sharing.general(page, "workspace", "view")
    assert [(p["email"], p["level"]) for p in shown["people"]] == [("bob@example.com", "full")]
    # He can't lower or remove his own access.
    response = await sharing.set_level(page, bob.user_id, "edit", expect=409)
    assert response["detail"] == "You can't take away your own full access"
    await sharing.remove(page, bob.user_id, expect=409)
    assert (await bob.get(page))["access"] == "full"


# Inviting


async def test_inviting_someone_new_makes_them_a_guest_and_emails_them(
    ada: Api, client: AsyncClient, caplog: Logs, db_session: AsyncSession
) -> None:
    page = await ada.create("Spec")
    caplog.clear()
    with caplog.at_level(logging.INFO, logger="app.permissions"):
        shown = await Sharing(ada).share(page, "  New@Example.com ", "comment")
    assert [(p["email"], p["level"], p["role"]) for p in shown["people"]] == [
        ("new@example.com", "comment", "guest")
    ]
    assert f"Shared page for new@example.com: http://localhost:4200/p/{page['id']}" in caplog.text

    # When they first sign in they get their own workspace too, and can open the page.
    new = await api_for(client, caplog, "new@example.com")
    user = await db_session.scalar(select(User).where(User.email == "new@example.com"))
    owned = await db_session.scalar(select(Workspace).where(Workspace.owner_id == user.id))
    assert owned is not None
    assert (await new.get(page))["access"] == "comment"


async def test_people_outside_a_page_see_nothing_about_its_sharing(ada: Api, cy: Api) -> None:
    page = await ada.create("Board")
    await Sharing(cy).permissions(page, expect=404)
    await Sharing(cy).share(page, "cy@example.com", "full", expect=404)
    await Sharing(cy).general(page, "public", expect=404)


async def test_levels_and_access_are_checked(ada: Api, cy: Api) -> None:
    page = await ada.create("Doc")
    response = await ada.client.post(
        f"/api/pages/{page['id']}/share",
        json={"email": "cy@example.com", "level": "owner"},
        headers=ada.headers,
    )
    assert response.status_code == 422
    response = await ada.client.put(
        f"/api/pages/{page['id']}/general-access", json={"access": "everyone"}, headers=ada.headers
    )
    assert response.status_code == 422
    # Setting a level needs them to be invited first.
    await Sharing(ada).set_level(page, cy.user_id, "view", expect=404)
