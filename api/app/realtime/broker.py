"""Fan-out between API workers. Each worker keeps its own copy of an open page's document; messages
published for a page reach every other worker that has that page open.

Without REDIS_URL there is one worker, so the local broker has nobody to tell. Tests also use it to
stand in for several workers in one process.
"""

import asyncio
import contextlib
import logging
import uuid
from collections.abc import Awaitable, Callable
from typing import Any, Protocol

logger = logging.getLogger(__name__)

Handler = Callable[[bytes], Awaitable[None]]


class Broker(Protocol):
    async def subscribe(self, page_id: uuid.UUID, handler: Handler) -> None: ...
    async def unsubscribe(self, page_id: uuid.UUID) -> None: ...
    async def publish(self, page_id: uuid.UUID, data: bytes) -> None: ...
    async def close(self) -> None: ...


class LocalHub:
    """Shared by the LocalBrokers of "workers" in one process."""

    def __init__(self) -> None:
        self.handlers: dict[uuid.UUID, dict[uuid.UUID, Handler]] = {}


class LocalBroker:
    def __init__(self, hub: LocalHub | None = None) -> None:
        self.hub = hub or LocalHub()
        self.worker_id = uuid.uuid4()

    async def subscribe(self, page_id: uuid.UUID, handler: Handler) -> None:
        self.hub.handlers.setdefault(page_id, {})[self.worker_id] = handler

    async def unsubscribe(self, page_id: uuid.UUID) -> None:
        handlers = self.hub.handlers.get(page_id, {})
        handlers.pop(self.worker_id, None)
        if not handlers:
            self.hub.handlers.pop(page_id, None)

    async def publish(self, page_id: uuid.UUID, data: bytes) -> None:
        for worker_id, handler in list(self.hub.handlers.get(page_id, {}).items()):
            if worker_id != self.worker_id:
                await handler(data)

    async def close(self) -> None:
        for page_id in [p for p, h in self.hub.handlers.items() if self.worker_id in h]:
            await self.unsubscribe(page_id)


def channel(page_id: uuid.UUID) -> str:
    return f"tidepool:page:{page_id}"


class RedisBroker:
    """Redis pub/sub, one channel per page. Each message starts with the sender's worker id, so a
    worker ignores its own."""

    def __init__(self, redis: Any) -> None:
        self.redis = redis
        self.worker_id = uuid.uuid4()
        self.pubsub = redis.pubsub()
        self.handlers: dict[str, Handler] = {}
        self._listener: asyncio.Task[None] | None = None

    @classmethod
    def from_url(cls, url: str) -> "RedisBroker":
        from redis.asyncio import Redis

        return cls(Redis.from_url(url))

    async def subscribe(self, page_id: uuid.UUID, handler: Handler) -> None:
        name = channel(page_id)
        self.handlers[name] = handler
        await self.pubsub.subscribe(name)
        if self._listener is None or self._listener.done():
            self._listener = asyncio.create_task(self._listen())

    async def unsubscribe(self, page_id: uuid.UUID) -> None:
        name = channel(page_id)
        if self.handlers.pop(name, None) is not None:
            await self.pubsub.unsubscribe(name)

    async def publish(self, page_id: uuid.UUID, data: bytes) -> None:
        await self.redis.publish(channel(page_id), self.worker_id.bytes + data)

    async def _listen(self) -> None:
        while self.handlers:
            try:
                message = await self.pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Realtime: reading from Redis failed; retrying")
                await asyncio.sleep(1)
                continue
            if message is None or message.get("type") != "message":
                continue
            name = message["channel"]
            name = name.decode() if isinstance(name, bytes) else name
            data: bytes = message["data"]
            handler = self.handlers.get(name)
            if handler is None or data[:16] == self.worker_id.bytes:
                continue
            try:
                await handler(data[16:])
            except Exception:
                logger.exception("Realtime: handling a message from another worker failed")

    async def close(self) -> None:
        self.handlers.clear()
        if self._listener is not None:
            self._listener.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._listener
        await self.pubsub.aclose()
        await self.redis.aclose()
