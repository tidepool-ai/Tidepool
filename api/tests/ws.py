"""A WebSocket client that talks to the ASGI app in-process, plus a Yjs (pycrdt) client on top of it."""

import asyncio
import contextlib
from collections.abc import Callable
from typing import Any

from pycrdt import (
    Decoder,
    Doc,
    Text,
    YMessageType,
    YSyncMessageType,
    create_sync_message,
    create_update_message,
    handle_sync_message,
)

TIMEOUT = 2.0


class Closed(Exception):  # noqa: N818 (reads better at call sites)
    def __init__(self, code: int, reason: str) -> None:
        super().__init__(f"closed {code}: {reason}")
        self.code, self.reason = code, reason


class WebSocketClient:
    def __init__(self, app: Callable[..., Any], path: str) -> None:
        path, _, query = path.partition("?")
        self.scope = {
            "type": "websocket",
            "asgi": {"version": "3.0"},
            "scheme": "ws",
            "path": path,
            "raw_path": path.encode(),
            "root_path": "",
            "query_string": query.encode(),
            "headers": [(b"host", b"test")],
            "client": ("127.0.0.1", 50000),
            "server": ("test", 80),
            "subprotocols": [],
            "state": {},
        }
        self.app = app
        self.to_app: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self.from_app: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self.task: asyncio.Task[None] | None = None
        self.closed: Closed | None = None

    async def __aenter__(self) -> "WebSocketClient":
        self.task = asyncio.create_task(self.app(self.scope, self.to_app.get, self.from_app.put))
        await self.to_app.put({"type": "websocket.connect"})
        event = await asyncio.wait_for(self.from_app.get(), TIMEOUT)
        assert event["type"] == "websocket.accept", event
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.disconnect()

    async def disconnect(self) -> None:
        if self.task is None:
            return
        if not self.task.done():
            await self.to_app.put({"type": "websocket.disconnect", "code": 1000})
            with contextlib.suppress(Exception):
                await asyncio.wait_for(self.task, TIMEOUT)
        self.task = None

    async def send(self, data: bytes) -> None:
        await self.to_app.put({"type": "websocket.receive", "bytes": data})

    async def receive(self, within: float = TIMEOUT) -> bytes:
        if self.closed:
            raise self.closed
        event = await asyncio.wait_for(self.from_app.get(), within)
        if event["type"] == "websocket.close":
            self.closed = Closed(event.get("code", 1000), event.get("reason", ""))
            raise self.closed
        return event["bytes"]

    async def wait_closed(self, within: float = TIMEOUT) -> Closed:
        """Read until the server closes the socket."""
        try:
            while True:
                await self.receive(within)
        except Closed as closed:
            return closed


class YClient:
    """A Yjs client with one shared text, like a browser tab with a y-websocket provider."""

    def __init__(self, ws: WebSocketClient) -> None:
        self.ws = ws
        self.doc = Doc()
        self.text = self.doc.get("content", type=Text)
        self._outbox: list[bytes] = []
        self._applying = False
        self.awareness: list[bytes] = []
        self.doc.observe(self._local_change)

    def _local_change(self, event: Any) -> None:
        if not self._applying:
            self._outbox.append(create_update_message(event.update))

    async def flush(self) -> None:
        """Send local edits made since the last flush."""
        outbox, self._outbox = self._outbox, []
        for message in outbox:
            await self.ws.send(message)

    async def edit(self, change: Callable[[Text], None]) -> None:
        change(self.text)
        await self.flush()

    def _apply(self, message: bytes) -> bytes | None:
        self._applying = True
        try:
            return handle_sync_message(message[1:], self.doc)
        finally:
            self._applying = False

    async def handshake(self) -> None:
        """Answer the server's step 1, then ask for its state (step 1 → step 2)."""
        greeting = await self.ws.receive()
        assert greeting[:2] == bytes([YMessageType.SYNC, YSyncMessageType.SYNC_STEP1]), greeting
        reply = self._apply(greeting)
        assert reply is not None
        await self.ws.send(reply)
        await self.ws.send(create_sync_message(self.doc))
        await self.read_until(lambda m: m[:2] == bytes([YMessageType.SYNC, YSyncMessageType.SYNC_STEP2]))

    async def read_until(self, done: Callable[[bytes], bool], within: float = TIMEOUT) -> bytes:
        """Apply incoming messages until `done(message)`; returns that message."""
        while True:
            message = await self.ws.receive(within)
            if message[0] == YMessageType.SYNC:
                reply = self._apply(message)
                if reply is not None and message[1] == YSyncMessageType.SYNC_STEP1:
                    await self.ws.send(reply)
            elif message[0] == YMessageType.AWARENESS:
                self.awareness.append(Decoder(message[1:]).read_message())
            if done(message):
                return message

    async def wait_for_text(self, expected: str, within: float = TIMEOUT) -> None:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + within
        while str(self.text) != expected:
            remaining = deadline - loop.time()
            if remaining <= 0:
                raise AssertionError(f"text is {str(self.text)!r}, expected {expected!r}")
            await self.read_until(lambda _m: True, remaining)

    async def quiet(self, within: float = 0.2) -> list[bytes]:
        """Messages received `within` seconds (applied), for asserting nothing arrives."""
        seen: list[bytes] = []
        with contextlib.suppress(TimeoutError):
            while True:
                seen.append(await self.read_until(lambda _m: True, within))
        return seen
