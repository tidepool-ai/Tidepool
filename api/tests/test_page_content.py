import dataclasses
import json
import uuid
from collections.abc import AsyncIterator

import pytest
from httpx2 import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.pages import router as pages_router
from app.workspaces.models import Member, Role
from tests.helpers import sign_in

pytestmark = pytest.mark.anyio

Logs = pytest.LogCaptureFixture

DOC = {
    "type": "doc",
    "content": [
        {"type": "heading", "attrs": {"level": 1}, "content": [{"type": "text", "text": "Plan"}]},
        {"type": "bulletList", "content": [{"type": "listItem", "content": [{"type": "paragraph"}]}]},
    ],
}


class User:
    def __init__(self, client: AsyncClient, headers: dict[str, str], workspace_id: str, user_id: str) -> None:
        self.client, self.headers, self.workspace_id, self.user_id = client, headers, workspace_id, user_id

    async def new_page(self, title: str = "Page") -> str:
        body = {"workspace_id": self.workspace_id, "title": title}
        response = await self.client.post("/api/pages", json=body, headers=self.headers)
        assert response.status_code == 201
        return response.json()["id"]

    async def get(self, page_id: str):
        return await self.client.get(f"/api/pages/{page_id}/content", headers=self.headers)

    async def put(
        self, page_id: str, doc: object = DOC, *, headers: dict[str, str] | None = None, **kwargs: object
    ):
        """PUT {"content": doc}, or a raw body via content=/json=."""
        if "content" not in kwargs and "json" not in kwargs:
            kwargs["json"] = {"content": doc}
        all_headers = {**self.headers, **(headers or {})}
        return await self.client.put(f"/api/pages/{page_id}/content", headers=all_headers, **kwargs)


async def user(client: AsyncClient, caplog: Logs, email: str) -> User:
    headers = await sign_in(client, caplog, email)
    workspace_id = (await client.get("/api/workspaces", headers=headers)).json()[0]["id"]
    user_id = (await client.get("/api/auth/me", headers=headers)).json()["id"]
    return User(client, headers, workspace_id, user_id)


@pytest.fixture
async def ada(client: AsyncClient, caplog: Logs) -> User:
    return await user(client, caplog, "ada@example.com")


@pytest.fixture
async def bob(client: AsyncClient, caplog: Logs, ada: User) -> User:
    return await user(client, caplog, "bob@example.com")


@pytest.fixture
def small_limit(monkeypatch: pytest.MonkeyPatch) -> int:
    limit = 300
    monkeypatch.setattr(pages_router, "settings", dataclasses.replace(settings, max_page_content_bytes=limit))
    return limit


def body_of_size(size: int) -> bytes:
    """A valid PUT body that is exactly `size` bytes of JSON."""
    base = {
        "content": {
            "type": "doc",
            "content": [{"type": "paragraph", "content": [{"type": "text", "text": ""}]}],
        }
    }
    padding = size - len(json.dumps(base, separators=(",", ":")).encode())
    assert padding >= 0
    base["content"]["content"][0]["content"][0]["text"] = "x" * padding
    body = json.dumps(base, separators=(",", ":")).encode()
    assert len(body) == size
    return body


# Save and load


async def test_new_page_has_no_content_yet(ada: User) -> None:
    page_id = await ada.new_page()
    response = await ada.get(page_id)
    assert response.status_code == 200
    assert response.json() == {"page_id": page_id, "content": None, "updated_at": None}


async def test_saved_content_comes_back(ada: User) -> None:
    page_id = await ada.new_page()

    saved = await ada.put(page_id)
    loaded = await ada.get(page_id)

    assert saved.status_code == 200
    assert saved.json()["page_id"] == page_id
    assert saved.json()["content"] == DOC
    assert loaded.json()["content"] == DOC
    assert loaded.json()["updated_at"] == saved.json()["updated_at"]


async def test_saving_again_replaces_the_document(ada: User) -> None:
    page_id = await ada.new_page()
    first = (await ada.put(page_id)).json()
    second_doc = {
        "type": "doc",
        "content": [{"type": "paragraph", "content": [{"type": "text", "text": "v2"}]}],
    }

    second = (await ada.put(page_id, second_doc)).json()

    assert (await ada.get(page_id)).json()["content"] == second_doc
    assert second["updated_at"] > first["updated_at"]


async def test_content_is_per_page(ada: User) -> None:
    one, two = await ada.new_page("One"), await ada.new_page("Two")
    await ada.put(one)
    assert (await ada.get(two)).json()["content"] is None


async def test_unicode_survives(ada: User) -> None:
    page_id = await ada.new_page()
    doc = {
        "type": "doc",
        "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Grüße 👋 你好"}]}],
    }
    await ada.put(page_id, doc)
    assert (await ada.get(page_id)).json()["content"] == doc


# Validation


@pytest.mark.parametrize(
    "body",
    [
        {"content": {"type": "paragraph"}},
        {"content": {"type": "doc", "content": "not a list"}},
        {"content": "<p>html</p>"},
        {"doc": {"type": "doc"}},
        {"content": {"type": "doc"}, "extra": 1},
    ],
)
async def test_rejects_things_that_are_not_documents(ada: User, body: object) -> None:
    response = await ada.put(await ada.new_page(), json=body)
    assert response.status_code == 422


async def test_rejects_invalid_json(ada: User) -> None:
    response = await ada.put(
        await ada.new_page(), content=b"{not json", headers={"content-type": "application/json"}
    )
    assert response.status_code == 422


# Size limit


async def test_default_limit_is_one_megabyte() -> None:
    assert settings.max_page_content_bytes == 1_000_000


async def test_body_at_the_limit_is_accepted(ada: User, small_limit: int) -> None:
    page_id = await ada.new_page()
    response = await ada.put(page_id, content=body_of_size(small_limit))
    assert response.status_code == 200


async def test_body_over_the_limit_is_rejected_and_nothing_is_saved(ada: User, small_limit: int) -> None:
    page_id = await ada.new_page()
    await ada.put(page_id)

    response = await ada.put(page_id, content=body_of_size(small_limit + 1))

    assert response.status_code == 413
    assert str(small_limit) in response.json()["detail"]
    assert (await ada.get(page_id)).json()["content"] == DOC


async def test_streamed_body_without_content_length_is_still_limited(ada: User, small_limit: int) -> None:
    page_id = await ada.new_page()
    body = body_of_size(small_limit + 50)

    async def chunks() -> AsyncIterator[bytes]:
        for start in range(0, len(body), 64):
            yield body[start : start + 64]

    response = await ada.put(page_id, content=chunks())
    assert response.status_code == 413


# Permissions


async def test_other_users_cannot_read_or_write_content(ada: User, bob: User) -> None:
    page_id = await ada.new_page()
    await ada.put(page_id)

    assert (await bob.get(page_id)).status_code == 404
    assert (await bob.put(page_id, {"type": "doc", "content": []})).status_code == 404
    assert (await ada.get(page_id)).json()["content"] == DOC


async def test_unknown_pages_look_the_same_as_hidden_ones(ada: User, bob: User) -> None:
    hidden = await bob.get(await ada.new_page())
    unknown = await bob.get(str(uuid.uuid4()))
    assert (hidden.status_code, hidden.json()) == (unknown.status_code, unknown.json())


async def test_permission_is_checked_before_the_body_is_read(ada: User, bob: User, small_limit: int) -> None:
    # A stranger gets 404, not a hint (413/422) about the page from the body checks.
    page_id = await ada.new_page()
    response = await bob.put(page_id, content=body_of_size(small_limit + 1))
    assert response.status_code == 404


async def test_workspace_members_can_edit_and_guests_cannot_see(
    ada: User, bob: User, db_session: AsyncSession
) -> None:
    page_id = await ada.new_page()
    member = Member(
        workspace_id=uuid.UUID(ada.workspace_id), user_id=uuid.UUID(bob.user_id), role=Role.MEMBER
    )
    db_session.add(member)
    await db_session.flush()

    assert (await bob.put(page_id)).status_code == 200
    assert (await ada.get(page_id)).json()["content"] == DOC

    member.role = Role.GUEST
    await db_session.flush()
    assert (await bob.get(page_id)).status_code == 404
    assert (await bob.put(page_id)).status_code == 404


async def test_trashed_pages_can_be_read_but_not_changed(ada: User) -> None:
    page_id = await ada.new_page()
    await ada.put(page_id)
    await ada.client.delete(f"/api/pages/{page_id}", headers=ada.headers)

    assert (await ada.get(page_id)).json()["content"] == DOC
    assert (await ada.put(page_id, {"type": "doc", "content": []})).status_code == 409


async def test_content_routes_require_sign_in(client: AsyncClient) -> None:
    page_id = uuid.uuid4()
    assert (await client.get(f"/api/pages/{page_id}/content")).status_code == 401
    assert (await client.put(f"/api/pages/{page_id}/content", json={"content": DOC})).status_code == 401
