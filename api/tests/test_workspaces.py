import uuid

import pytest
from httpx2 import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.workspaces.models import Member, Role, Workspace
from tests.helpers import sign_in

pytestmark = pytest.mark.anyio

Logs = pytest.LogCaptureFixture


async def workspaces_of(client: AsyncClient, headers: dict[str, str]) -> list[dict]:
    response = await client.get("/api/workspaces", headers=headers)
    assert response.status_code == 200
    return response.json()


async def add_member(session: AsyncSession, workspace_id: str, user_id: str, role: Role) -> None:
    session.add(Member(workspace_id=uuid.UUID(workspace_id), user_id=uuid.UUID(user_id), role=role))
    await session.flush()


async def me(client: AsyncClient, headers: dict[str, str]) -> dict:
    return (await client.get("/api/auth/me", headers=headers)).json()


# Personal workspace on first sign-in


async def test_first_sign_in_creates_a_personal_workspace(client: AsyncClient, caplog: Logs) -> None:
    ada = await sign_in(client, caplog, "ada@example.com")
    ada_id = (await me(client, ada))["id"]

    workspaces = await workspaces_of(client, ada)

    assert len(workspaces) == 1
    assert workspaces[0]["name"] == "ada's workspace"
    assert workspaces[0]["owner_id"] == ada_id
    assert workspaces[0]["role"] == "owner"


async def test_later_sign_ins_do_not_create_more_workspaces(
    client: AsyncClient, db_session: AsyncSession, caplog: Logs
) -> None:
    await sign_in(client, caplog, "ada@example.com")
    ada = await sign_in(client, caplog, "ada@example.com")

    assert len(await workspaces_of(client, ada)) == 1
    assert await db_session.scalar(select(func.count()).select_from(Workspace)) == 1


async def test_owner_is_listed_as_a_member(client: AsyncClient, caplog: Logs) -> None:
    ada = await sign_in(client, caplog, "ada@example.com")
    workspace_id = (await workspaces_of(client, ada))[0]["id"]

    response = await client.get(f"/api/workspaces/{workspace_id}/members", headers=ada)

    assert response.status_code == 200
    assert response.json() == [
        {"user_id": (await me(client, ada))["id"], "email": "ada@example.com", "role": "owner"}
    ]


# Members only see their workspaces


async def test_users_only_see_workspaces_they_belong_to(client: AsyncClient, caplog: Logs) -> None:
    ada = await sign_in(client, caplog, "ada@example.com")
    bob = await sign_in(client, caplog, "bob@example.com")

    ada_names = [w["name"] for w in await workspaces_of(client, ada)]
    bob_names = [w["name"] for w in await workspaces_of(client, bob)]

    assert ada_names == ["ada's workspace"]
    assert bob_names == ["bob's workspace"]


async def test_joining_a_workspace_adds_it_with_the_members_role(
    client: AsyncClient, db_session: AsyncSession, caplog: Logs
) -> None:
    ada = await sign_in(client, caplog, "ada@example.com")
    bob = await sign_in(client, caplog, "bob@example.com")
    ada_workspace = (await workspaces_of(client, ada))[0]["id"]
    await add_member(db_session, ada_workspace, (await me(client, bob))["id"], Role.ADMIN)

    workspaces = await workspaces_of(client, bob)

    assert [(w["name"], w["role"]) for w in workspaces] == [
        ("ada's workspace", "admin"),
        ("bob's workspace", "owner"),
    ]


async def test_non_members_cannot_see_members_and_get_404(client: AsyncClient, caplog: Logs) -> None:
    ada = await sign_in(client, caplog, "ada@example.com")
    bob = await sign_in(client, caplog, "bob@example.com")
    ada_workspace = (await workspaces_of(client, ada))[0]["id"]

    response = await client.get(f"/api/workspaces/{ada_workspace}/members", headers=bob)

    # Same answer as a workspace that doesn't exist, so ids can't be probed.
    assert response.status_code == 404
    unknown = await client.get(f"/api/workspaces/{uuid.uuid4()}/members", headers=bob)
    assert unknown.status_code == 404
    assert unknown.json() == response.json()


@pytest.mark.parametrize("role", [Role.ADMIN, Role.MEMBER])
async def test_admins_and_members_see_all_members(
    client: AsyncClient, db_session: AsyncSession, caplog: Logs, role: Role
) -> None:
    ada = await sign_in(client, caplog, "ada@example.com")
    bob = await sign_in(client, caplog, "bob@example.com")
    ada_workspace = (await workspaces_of(client, ada))[0]["id"]
    await add_member(db_session, ada_workspace, (await me(client, bob))["id"], role)

    response = await client.get(f"/api/workspaces/{ada_workspace}/members", headers=bob)

    assert response.status_code == 200
    assert [(m["email"], m["role"]) for m in response.json()] == [
        ("ada@example.com", "owner"),
        ("bob@example.com", role.value),
    ]


async def test_guests_cannot_list_members(
    client: AsyncClient, db_session: AsyncSession, caplog: Logs
) -> None:
    ada = await sign_in(client, caplog, "ada@example.com")
    guest = await sign_in(client, caplog, "guest@example.com")
    ada_workspace = (await workspaces_of(client, ada))[0]["id"]
    await add_member(db_session, ada_workspace, (await me(client, guest))["id"], Role.GUEST)

    assert "ada's workspace" in [w["name"] for w in await workspaces_of(client, guest)]
    response = await client.get(f"/api/workspaces/{ada_workspace}/members", headers=guest)
    assert response.status_code == 403


async def test_workspace_routes_require_sign_in(client: AsyncClient) -> None:
    assert (await client.get("/api/workspaces")).status_code == 401
    assert (await client.get(f"/api/workspaces/{uuid.uuid4()}/members")).status_code == 401


async def test_invalid_workspace_id_is_rejected(client: AsyncClient, caplog: Logs) -> None:
    ada = await sign_in(client, caplog, "ada@example.com")
    response = await client.get("/api/workspaces/not-a-uuid/members", headers=ada)
    assert response.status_code == 422


async def test_unknown_roles_are_rejected_by_the_database(db_session: AsyncSession) -> None:
    user = User(email="x@example.com")
    db_session.add(user)
    await db_session.flush()
    workspace = Workspace(name="w", owner_id=user.id)
    db_session.add(workspace)
    await db_session.flush()
    db_session.add(Member(workspace_id=workspace.id, user_id=user.id, role="superuser"))
    with pytest.raises(IntegrityError):
        await db_session.flush()
