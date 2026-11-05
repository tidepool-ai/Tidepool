"""T14: live page documents over WebSocket (Yjs sync with pycrdt)."""

import asyncio
import contextlib
import dataclasses
import uuid
from collections.abc import AsyncIterator, Callable
from datetime import UTC, datetime, timedelta

import fakeredis
import pytest
from fastapi import FastAPI
from httpx2 import AsyncClient
from pycrdt import Doc, Text, YMessageType, create_awareness_message, create_update_message
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.service import create_access_token
from app.main import app, create_app
from app.realtime.broker import LocalBroker, LocalHub, RedisBroker
from app.realtime.models import PageDoc
from app.realtime.rooms import RoomManager
from app.realtime.store import DocStore, compact
from app.realtime.tickets import create_ticket
from app.workspaces.models import Member
from tests.test_page_content import User, user
from tests.ws import WebSocketClient, YClient

pytestmark = pytest.mark.anyio

Logs = pytest.LogCaptureFixture
SAVE_DELAY = 0.05
SAVE_MAX_DELAY = 0.3


Sessions = Callable[[], contextlib.AbstractAsyncContextManager[AsyncSession]]


def sessions_for(db_session: AsyncSession) -> Sessions:
    """The test's session, one user at a time (rooms save in the background)."""
    lock = asyncio.Lock()

    @contextlib.asynccontextmanager
    async def scope() -> AsyncIterator[AsyncSession]:
        async with lock:
            yield db_session

    return scope


def new_rooms(db_session: AsyncSession, broker: object | None = None) -> RoomManager:
    return RoomManager(
        DocStore(sessions_for(db_session)),
        broker or LocalBroker(),  # type: ignore[arg-type]
        save_delay=SAVE_DELAY,
        save_max_delay=SAVE_MAX_DELAY,
    )


@pytest.fixture
async def rooms(db_session: AsyncSession) -> AsyncIterator[RoomManager]:
    manager = new_rooms(db_session)
    app.state.rooms = manager
    yield manager
    await manager.close()
    del app.state.rooms


@pytest.fixture
async def ada(client: AsyncClient, caplog: Logs) -> User:
    return await user(client, caplog, "ada@example.com")


@pytest.fixture
async def bob(client: AsyncClient, caplog: Logs, ada: User) -> User:
    return await user(client, caplog, "bob@example.com")


async def ticket(who: User, page_id: str) -> str:
    response = await who.client.post(f"/api/pages/{page_id}/realtime-ticket", headers=who.headers)
    assert response.status_code == 200, response.text
    return response.json()["ticket"]


@contextlib.asynccontextmanager
async def editor(who: User, page_id: str, target: FastAPI = app) -> AsyncIterator[YClient]:
    """A synced Yjs client on the page's socket."""
    async with WebSocketClient(target, f"/ws/pages/{page_id}?ticket={await ticket(who, page_id)}") as ws:
        client = YClient(ws)
        await client.handshake()
        yield client


async def share_workspace(db_session: AsyncSession, owner: User, guest: User) -> None:
    workspace_id, user_id = uuid.UUID(owner.workspace_id), uuid.UUID(guest.user_id)
    db_session.add(Member(workspace_id=workspace_id, user_id=user_id, role="member"))
    await db_session.commit()


async def stored_text(db_session: AsyncSession, page_id: str) -> str | None:
    query = select(PageDoc.state).where(PageDoc.page_id == uuid.UUID(page_id))
    state = await db_session.scalar(query.execution_options(populate_existing=True))
    if state is None:
        return None
    doc = Doc()
    doc.apply_update(state)
    return str(doc.get("content", type=Text))


@pytest.mark.usefixtures("rooms")
class TestTickets:
    async def test_ticket_needs_sign_in_and_access(self, ada: User, bob: User, client: AsyncClient) -> None:
        page_id = await ada.new_page()
        response = await ada.client.post(f"/api/pages/{page_id}/realtime-ticket", headers=ada.headers)
        assert response.status_code == 200
        assert response.json()["expires_in"] == 60
        assert response.json()["url"] == f"/ws/pages/{page_id}"
        assert (await client.post(f"/api/pages/{page_id}/realtime-ticket")).status_code == 401
        as_bob = await bob.client.post(f"/api/pages/{page_id}/realtime-ticket", headers=bob.headers)
        assert as_bob.status_code == 404

    @pytest.mark.parametrize(
        ("public", "expected"),
        [
            ("https://api.example.com", "wss://api.example.com"),
            ("http://localhost:8000/", "ws://localhost:8000"),
        ],
    )
    async def test_ticket_points_at_the_api_host_when_it_is_known(
        self, ada: User, monkeypatch: pytest.MonkeyPatch, public: str, expected: str
    ) -> None:
        from app.realtime import router as realtime_router

        configured = dataclasses.replace(realtime_router.settings, public_api_url=public.rstrip("/"))
        monkeypatch.setattr(realtime_router, "settings", configured)
        page_id = await ada.new_page()
        response = await ada.client.post(f"/api/pages/{page_id}/realtime-ticket", headers=ada.headers)
        assert response.json()["url"] == f"{expected}/ws/pages/{page_id}"

    @pytest.mark.parametrize("kind", ["missing", "other page", "expired", "access token", "garbage"])
    async def test_socket_refuses_bad_tickets(self, ada: User, kind: str) -> None:
        page_id = await ada.new_page()
        other_page = await ada.new_page("Other")
        tickets = {
            "missing": "",
            "other page": await ticket(ada, other_page),
            "expired": create_ticket(
                uuid.UUID(ada.user_id), uuid.UUID(page_id), issued_at=datetime.now(UTC) - timedelta(minutes=2)
            ),
            "access token": create_access_token(uuid.UUID(ada.user_id)),
            "garbage": "not-a-ticket",
        }
        async with WebSocketClient(app, f"/ws/pages/{page_id}?ticket={tickets[kind]}") as ws:
            closed = await ws.wait_closed()
        assert (closed.code, closed.reason) == (4401, "Sign in again")

    async def test_people_without_access_are_turned_away(self, ada: User, bob: User) -> None:
        page_id = await ada.new_page()
        # A ticket bob somehow got for ada's page still doesn't let him in.
        forged = create_ticket(uuid.UUID(bob.user_id), uuid.UUID(page_id))
        async with WebSocketClient(app, f"/ws/pages/{page_id}?ticket={forged}") as ws:
            closed = await ws.wait_closed()
        assert (closed.code, closed.reason) == (4403, "No access to this page")


@pytest.mark.usefixtures("rooms")
class TestSync:
    async def test_two_clients_converge(self, ada: User, bob: User, db_session: AsyncSession) -> None:
        await share_workspace(db_session, ada, bob)
        page_id = await ada.new_page()
        async with editor(ada, page_id) as a, editor(bob, page_id) as b:
            await a.edit(lambda t: t.insert(0, "Hello"))
            await b.wait_for_text("Hello")
            await b.edit(lambda t: t.insert(5, " world"))
            await a.wait_for_text("Hello world")

            # Concurrent edits on both sides merge the same way everywhere.
            await a.edit(lambda t: t.insert(0, "A: "))
            await b.edit(lambda t: t.insert(len(str(t)), "!"))
            await a.wait_for_text("A: Hello world!")
            await b.wait_for_text("A: Hello world!")

    async def test_a_late_joiner_gets_the_current_document(self, ada: User) -> None:
        page_id = await ada.new_page()
        async with editor(ada, page_id) as first:
            await first.edit(lambda t: t.insert(0, "Already here"))
            await asyncio.sleep(0.01)
            async with editor(ada, page_id) as second:
                assert str(second.text) == "Already here"

    async def test_edits_made_offline_are_merged_on_connect(self, ada: User) -> None:
        page_id = await ada.new_page()
        async with editor(ada, page_id) as a:
            await a.edit(lambda t: t.insert(0, "server"))
            offline = YClient(WebSocketClient(app, ""))
            offline.text.insert(0, "offline ")  # made before connecting
            async with WebSocketClient(app, f"/ws/pages/{page_id}?ticket={await ticket(ada, page_id)}") as ws:
                offline.ws = ws
                offline._outbox.clear()
                await offline.handshake()
                await a.wait_for_text(str(offline.text))
            assert "offline" in str(a.text) and "server" in str(a.text)

    async def test_presence_is_shared_and_cleared_on_leave(self, ada: User) -> None:
        page_id = await ada.new_page()
        async with editor(ada, page_id) as watcher:
            async with editor(ada, page_id) as tab:
                from pycrdt import Awareness

                awareness = Awareness(tab.doc)
                awareness.set_local_state({"user": {"name": "Ada", "color": "teal"}})
                update = awareness.encode_awareness_update([tab.doc.client_id])
                await tab.ws.send(create_awareness_message(update))
                await watcher.read_until(lambda m: m[0] == YMessageType.AWARENESS)
                seen = Awareness(Doc())
                seen.apply_awareness_update(watcher.awareness[-1], "test")
                assert seen.states[tab.doc.client_id] == {"user": {"name": "Ada", "color": "teal"}}
            # The tab closed: the others hear that its presence is gone.
            await watcher.read_until(lambda m: m[0] == YMessageType.AWARENESS)
            seen.apply_awareness_update(watcher.awareness[-1], "test")
            assert tab.doc.client_id not in seen.states

    async def test_oversized_messages_close_the_socket(
        self, ada: User, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from app.realtime import router as realtime_router

        small = dataclasses.replace(realtime_router.settings, max_realtime_message_bytes=100)
        monkeypatch.setattr(realtime_router, "settings", small)
        page_id = await ada.new_page()
        async with editor(ada, page_id) as a:
            await a.edit(lambda t: t.insert(0, "x" * 500))
            closed = await a.ws.wait_closed()
        assert closed.code == 1009


@pytest.mark.usefixtures("rooms")
class TestPermissions:
    async def test_checked_on_every_edit(self, ada: User, bob: User, db_session: AsyncSession) -> None:
        await share_workspace(db_session, ada, bob)
        page_id = await ada.new_page()
        async with editor(ada, page_id) as a, editor(bob, page_id) as b:
            await b.edit(lambda t: t.insert(0, "allowed"))
            await a.wait_for_text("allowed")

            # Bob is removed from the workspace while the page is open.
            await db_session.execute(delete(Member).where(Member.user_id == uuid.UUID(bob.user_id)))
            await db_session.commit()
            await b.edit(lambda t: t.insert(0, "sneaky "))
            closed = await b.ws.wait_closed()
            assert (closed.code, closed.reason) == (4403, "No access to this page")
            await a.quiet()
            assert str(a.text) == "allowed"  # the edit never reached anyone

    async def test_trashed_pages_are_read_only(self, ada: User) -> None:
        page_id = await ada.new_page()
        async with editor(ada, page_id) as a:
            await a.edit(lambda t: t.insert(0, "Kept"))
        assert (await ada.client.delete(f"/api/pages/{page_id}", headers=ada.headers)).status_code == 200

        async with editor(ada, page_id) as reader:  # can still connect and read
            assert str(reader.text) == "Kept"
            await reader.edit(lambda t: t.insert(0, "Edited "))
            closed = await reader.ws.wait_closed()
        assert (closed.code, closed.reason) == (4403, "This page is read-only")

    async def test_reading_never_counts_as_editing(self, ada: User, monkeypatch: pytest.MonkeyPatch) -> None:
        page_id = await ada.new_page()
        checks: list[str] = []
        from app.realtime import router as realtime_router

        original = realtime_router.check_access

        async def counting(*args: object):
            checks.append("check")
            return await original(*args)  # type: ignore[arg-type]

        monkeypatch.setattr(realtime_router, "check_access", counting)
        async with editor(ada, page_id) as a:
            assert checks == ["check"]  # on connect only: the handshake changes nothing
            await a.edit(lambda t: t.insert(0, "one"))
            await a.edit(lambda t: t.insert(3, " two"))
            await asyncio.sleep(0.05)
        assert checks == ["check", "check", "check"]  # and once per edit


@pytest.mark.usefixtures("rooms")
class TestSaving:
    async def test_saved_after_a_pause_and_restored_after_everyone_left(
        self, ada: User, db_session: AsyncSession, rooms: RoomManager
    ) -> None:
        page_id = await ada.new_page()
        async with editor(ada, page_id) as a:
            await a.edit(lambda t: t.insert(0, "Draft"))
            assert await stored_text(db_session, page_id) is None  # not yet: debounced
            await asyncio.sleep(SAVE_DELAY * 4)
            assert await stored_text(db_session, page_id) == "Draft"
            await a.edit(lambda t: t.insert(5, " 2"))
        # The last one out saves right away and the room closes.
        assert rooms.rooms == {}
        assert await stored_text(db_session, page_id) == "Draft 2"
        async with editor(ada, page_id) as again:
            assert str(again.text) == "Draft 2"

    async def test_debounced_into_few_writes_but_never_put_off_for_long(
        self, ada: User, rooms: RoomManager, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        page_id = await ada.new_page()
        saves: list[float] = []
        original = rooms.store.save

        async def counting(*args: object) -> None:
            saves.append(asyncio.get_running_loop().time())
            await original(*args)  # type: ignore[arg-type]

        monkeypatch.setattr(rooms.store, "save", counting)
        async with editor(ada, page_id) as a:
            start = asyncio.get_running_loop().time()
            # Keep typing faster than the save delay for longer than the max delay.
            for i in range(20):
                await a.edit(lambda t, i=i: t.insert(len(str(t)), str(i % 10)))
                await asyncio.sleep(SAVE_DELAY / 2)
            assert 1 <= len(saves) <= 3  # 20 edits, a couple of writes
            assert saves[0] - start <= SAVE_MAX_DELAY + 0.1

    async def test_store_merges_instead_of_overwriting(self, ada: User, db_session: AsyncSession) -> None:
        page_id = uuid.UUID(await ada.new_page())
        store = DocStore(sessions_for(db_session))
        one, two = Doc(), Doc()
        one.get("content", type=Text).insert(0, "one ")
        two.get("content", type=Text).insert(0, "two ")
        await store.save(page_id, one.get_update())
        await store.save(page_id, two.get_update())  # e.g. a worker that never saw "one"
        text = await stored_text(db_session, str(page_id))
        assert text is not None and "one" in text and "two" in text

    async def test_compact_drops_deleted_content(self) -> None:
        doc = Doc()
        text = doc.get("content", type=Text)
        updates = []
        doc.observe(lambda event: updates.append(event.update))
        text.insert(0, "x" * 10_000)
        del text[0:10_000]
        merged = compact(*updates)
        assert len(merged) < 200


@pytest.mark.parametrize("kind", ["local", "redis"])
class TestWorkers:
    """Two API workers, each with its own rooms, joined by a broker."""

    @pytest.fixture
    async def workers(self, db_session: AsyncSession, kind: str) -> AsyncIterator[tuple[FastAPI, FastAPI]]:
        if kind == "local":
            hub = LocalHub()
            brokers = [LocalBroker(hub), LocalBroker(hub)]
        else:
            server = fakeredis.FakeServer()
            brokers = [RedisBroker(fakeredis.FakeAsyncRedis(server=server)) for _ in range(2)]
        apps = (create_app(), create_app())
        managers = [new_rooms(db_session, broker) for broker in brokers]
        for worker, manager in zip(apps, managers, strict=True):
            worker.state.rooms = manager
        yield apps
        for manager in managers:
            await manager.close()

    async def test_clients_on_different_workers_converge(
        self, ada: User, workers: tuple[FastAPI, FastAPI]
    ) -> None:
        one, two = workers
        page_id = await ada.new_page()
        async with editor(ada, page_id, one) as a, editor(ada, page_id, two) as b:
            await a.edit(lambda t: t.insert(0, "from one"))
            await b.wait_for_text("from one")
            await b.edit(lambda t: t.insert(0, "two + "))
            await a.wait_for_text("two + from one")

    async def test_a_worker_opening_the_page_gets_unsaved_edits_from_the_others(
        self, ada: User, workers: tuple[FastAPI, FastAPI], db_session: AsyncSession
    ) -> None:
        one, two = workers
        one.state.rooms.save_delay = two.state.rooms.save_delay = 60  # nothing saved meanwhile
        one.state.rooms.save_max_delay = two.state.rooms.save_max_delay = 60
        page_id = await ada.new_page()
        async with editor(ada, page_id, one) as a:
            await a.edit(lambda t: t.insert(0, "only in worker one"))
            assert await stored_text(db_session, page_id) is None
            async with WebSocketClient(two, f"/ws/pages/{page_id}?ticket={await ticket(ada, page_id)}") as ws:
                late = YClient(ws)
                await late.handshake()
                await late.wait_for_text("only in worker one")


async def test_lifespan_saves_open_pages_on_shutdown(ada: User, db_session: AsyncSession) -> None:
    manager = new_rooms(db_session)
    manager.save_delay = manager.save_max_delay = 60
    app.state.rooms = manager
    try:
        page_id = await ada.new_page()
        async with editor(ada, page_id) as a:
            await a.edit(lambda t: t.insert(0, "unsaved"))
            await asyncio.sleep(0.01)
            await manager.close()  # what the app's lifespan does on shutdown
            closed = await a.ws.wait_closed()
            assert closed.code == 1012
        assert await stored_text(db_session, page_id) == "unsaved"
    finally:
        del app.state.rooms


def test_update_messages_are_what_yjs_sends() -> None:
    # Sanity check of the framing the tests rely on: [0 sync][2 update][len][update].
    message = create_update_message(b"\x00\x00")
    assert list(message) == [0, 2, 2, 0, 0]
