"""Rooms: one live Yjs document per open page, shared by everyone connected to it.

Messages follow the y-websocket protocol (what Yjs' WebsocketProvider speaks):
`[0 sync][0 step 1 | 1 step 2 | 2 update][payload]` and `[1 awareness][payload]`.
"""

import asyncio
import contextlib
import logging
import uuid
from collections.abc import Awaitable, Callable

from pycrdt import (
    Awareness,
    Decoder,
    Doc,
    YMessageType,
    YSyncMessageType,
    create_awareness_message,
    create_sync_message,
    create_update_message,
    handle_sync_message,
)

from app.realtime.broker import Broker
from app.realtime.store import DocStore

logger = logging.getLogger(__name__)

QUERY_AWARENESS = 3
# What an update with no changes encodes to (a client's step 2 when it has nothing new).
EMPTY_UPDATE = b"\x00\x00"


class Connection:
    """One client socket. Sends go through a queue, so a slow client never holds up the others."""

    QUEUE_SIZE = 1000

    def __init__(
        self, send: Callable[[bytes], Awaitable[None]], close: Callable[[int, str], Awaitable[None]]
    ) -> None:
        self._send = send
        self._close = close
        self.queue: asyncio.Queue[bytes | None] = asyncio.Queue(self.QUEUE_SIZE)
        self.writer = asyncio.create_task(self._write())
        self.closed = False

    def send(self, data: bytes) -> None:
        if self.closed:
            return
        try:
            self.queue.put_nowait(data)
        except asyncio.QueueFull:
            logger.warning("Realtime: a client fell too far behind; disconnecting it")
            asyncio.get_running_loop().create_task(self.close(1013, "Too slow, reconnect"))

    async def _write(self) -> None:
        while (data := await self.queue.get()) is not None:
            try:
                await self._send(data)
            except Exception:
                self.closed = True
                return

    async def close(self, code: int, reason: str) -> None:
        if self.closed:
            return
        self.closed = True
        with contextlib.suppress(Exception):
            await self._close(code, reason)
        await self.stop()

    async def stop(self) -> None:
        """Send what's queued, then stop the writer."""
        self.closed = True
        with contextlib.suppress(asyncio.QueueFull):
            self.queue.put_nowait(None)
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await asyncio.wait_for(self.writer, timeout=5)


class Room:
    def __init__(self, page_id: uuid.UUID) -> None:
        self.page_id = page_id
        self.doc = Doc()
        self.awareness = Awareness(self.doc)
        # Awareness (presence) client ids each connection announced, so they can be cleared when it leaves.
        self.connections: dict[Connection, set[int]] = {}
        self.awareness.observe(self._track_awareness)
        self.first_change: float | None = None
        self.last_change = 0.0
        self.save_task: asyncio.Task[None] | None = None

    def _track_awareness(self, topic: str, event: tuple[dict[str, list[int]], object]) -> None:
        if topic != "update":
            return
        changes, origin = event
        if isinstance(origin, Connection) and origin in self.connections:
            ids = self.connections[origin]
            ids.update(changes["added"], changes["updated"])
            ids.difference_update(changes["removed"])

    def others(self, connection: Connection | None) -> list[Connection]:
        return [c for c in self.connections if c is not connection]

    def awareness_message(self) -> bytes | None:
        ids = [client_id for ids in self.connections.values() for client_id in ids]
        ids += [cid for cid in self.awareness.states if cid != self.doc.client_id and cid not in ids]
        return create_awareness_message(self.awareness.encode_awareness_update(ids)) if ids else None


def is_change(message: bytes) -> bool:
    """Whether a client message would change the document (and so needs write access)."""
    if len(message) < 2 or message[0] != YMessageType.SYNC:
        return False
    if message[1] not in (YSyncMessageType.SYNC_STEP2, YSyncMessageType.SYNC_UPDATE):
        return False
    return _payload(message) != EMPTY_UPDATE


def _payload(message: bytes) -> bytes:
    """The update in a sync step 2 / update message."""
    return Decoder(message[2:]).read_message() or b""


class RoomManager:
    def __init__(
        self,
        store: DocStore,
        broker: Broker,
        *,
        save_delay: float = 2.0,
        save_max_delay: float = 10.0,
    ) -> None:
        self.store = store
        self.broker = broker
        self.save_delay = save_delay
        self.save_max_delay = save_max_delay
        self.rooms: dict[uuid.UUID, Room] = {}
        self._locks: dict[uuid.UUID, asyncio.Lock] = {}

    def _lock(self, page_id: uuid.UUID) -> asyncio.Lock:
        return self._locks.setdefault(page_id, asyncio.Lock())

    async def join(self, page_id: uuid.UUID, connection: Connection) -> Room:
        """Add a client to the page's room (opening it from storage if needed) and greet it."""
        async with self._lock(page_id):
            room = self.rooms.get(page_id)
            if room is None:
                room = Room(page_id)
                state = await self.store.load(page_id)
                if state:
                    room.doc.apply_update(state)
                self.rooms[page_id] = room
                await self.broker.subscribe(page_id, lambda data, room=room: self._from_peer(room, data))
                # Other workers with this page open send what isn't saved yet.
                await self.broker.publish(page_id, create_sync_message(room.doc))
            room.connections[connection] = set()
        # The client answers with what the server is missing and asks for the rest (step 1 → step 2).
        connection.send(create_sync_message(room.doc))
        if (presence := room.awareness_message()) is not None:
            connection.send(presence)
        return room

    async def handle(self, room: Room, connection: Connection, message: bytes) -> None:
        """A message from a client. Write access must already be checked (see `is_change`)."""
        if not message:
            return
        kind = message[0]
        if kind == YMessageType.SYNC and len(message) > 1:
            if message[1] == YSyncMessageType.SYNC_STEP1:
                reply = handle_sync_message(message[1:], room.doc)
                if reply is not None:
                    connection.send(reply)
            elif message[1] in (YSyncMessageType.SYNC_STEP2, YSyncMessageType.SYNC_UPDATE):
                update = _payload(message)
                if update == EMPTY_UPDATE:
                    return
                room.doc.apply_update(update)
                out = create_update_message(update)
                for other in room.others(connection):
                    other.send(out)
                await self.broker.publish(room.page_id, out)
                self._changed(room)
        elif kind == YMessageType.AWARENESS:
            room.awareness.apply_awareness_update(Decoder(message[1:]).read_message(), connection)
            for other in room.others(connection):
                other.send(message)
            await self.broker.publish(room.page_id, message)
        elif kind == QUERY_AWARENESS:
            if (presence := room.awareness_message()) is not None:
                connection.send(presence)

    async def _from_peer(self, room: Room, message: bytes) -> None:
        """A message another worker published for this page."""
        if not message:
            return
        if message[0] == YMessageType.SYNC and len(message) > 1:
            if message[1] == YSyncMessageType.SYNC_STEP1:
                reply = handle_sync_message(message[1:], room.doc)
                if reply is not None and _payload(reply) != EMPTY_UPDATE:
                    await self.broker.publish(room.page_id, create_update_message(_payload(reply)))
            else:
                update = _payload(message)
                if update == EMPTY_UPDATE:
                    return
                room.doc.apply_update(update)
                out = create_update_message(update)
                for connection in room.connections:
                    connection.send(out)
                self._changed(room)
        elif message[0] == YMessageType.AWARENESS:
            room.awareness.apply_awareness_update(Decoder(message[1:]).read_message(), "peer")
            for connection in room.connections:
                connection.send(message)

    async def leave(self, room: Room, connection: Connection) -> None:
        """Remove a client: clear its presence for the others, and close the room when it's empty."""
        async with self._lock(room.page_id):
            ids = room.connections.pop(connection, set())
            if ids:
                room.awareness.remove_awareness_states(list(ids), connection)
                # Encoded after removal, these are the "gone" (null) states the others need.
                gone = create_awareness_message(room.awareness.encode_awareness_update(list(ids)))
                for other in room.connections:
                    other.send(gone)
                await self.broker.publish(room.page_id, gone)
            if not room.connections and self.rooms.get(room.page_id) is room:
                del self.rooms[room.page_id]
                await self.broker.unsubscribe(room.page_id)
                await self._save_now(room)
        await connection.stop()

    # Saving: at most `save_delay` after the last change, and at least every `save_max_delay` while
    # changes keep coming.

    def _changed(self, room: Room) -> None:
        loop = asyncio.get_running_loop()
        room.last_change = loop.time()
        if room.first_change is None:
            room.first_change = room.last_change
        if room.save_task is None:
            room.save_task = loop.create_task(self._save_later(room))

    async def _save_later(self, room: Room) -> None:
        loop = asyncio.get_running_loop()
        while room.first_change is not None:
            due = min(room.last_change + self.save_delay, room.first_change + self.save_max_delay)
            if (wait := due - loop.time()) <= 0:
                break
            await asyncio.sleep(wait)
        room.save_task = None
        await self._save(room)

    async def _save_now(self, room: Room) -> None:
        task, room.save_task = room.save_task, None
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        await self._save(room)

    async def _save(self, room: Room) -> None:
        if room.first_change is None:
            return
        room.first_change = None
        try:
            await self.store.save(room.page_id, room.doc.get_update())
        except Exception:
            logger.exception("Realtime: saving page %s failed; will retry", room.page_id)
            self._changed(room)

    async def flush(self) -> None:
        """Save every open room now (tests, shutdown)."""
        for room in list(self.rooms.values()):
            await self._save_now(room)

    async def close(self) -> None:
        for room in list(self.rooms.values()):
            for connection in list(room.connections):
                await connection.close(1012, "Server restarting")
            await self._save_now(room)
        self.rooms.clear()
        await self.broker.close()
