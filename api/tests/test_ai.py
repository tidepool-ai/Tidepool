"""AI service (T23): streaming, prompts with page context, quota, timeouts and the usage log.

The model is a fake OpenAI-compatible server (an in-process ASGI app the real `openai` SDK talks to).
"""

import asyncio
import dataclasses
import json
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any

import pytest
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from httpx2 import AsyncClient
from openai import AsyncOpenAI
from pycrdt import Doc, XmlElement, XmlFragment, XmlText
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai import context
from app.ai import router as ai_router
from app.ai.client import AiClient, get_ai_client
from app.ai.models import AiUsage
from app.ai.service import get_usage_sessions
from app.main import app
from app.realtime.models import PageDoc
from app.workspaces.models import Member, Role
from tests.test_pages import Api, Logs, api_for
from tests.test_permissions import Sharing

pytestmark = pytest.mark.anyio


# The fake model --------------------------------------------------------------------------------


@dataclass
class FakeModel:
    """Answers chat completions the way an OpenAI-compatible server streams them."""

    chunks: list[str] = field(default_factory=lambda: ["Hello", ", ", "world."])
    usage: dict[str, int] | None = field(
        default_factory=lambda: {"prompt_tokens": 40, "completion_tokens": 3, "total_tokens": 43}
    )
    # Wait this long before answering at all, or between chunks.
    delay_before: float = 0
    delay_between: float = 0
    status: int = 200
    requests: list[dict[str, Any]] = field(default_factory=list)

    def app(self) -> FastAPI:
        fake = FastAPI()

        @fake.post("/v1/chat/completions")
        async def completions(request: Request) -> Any:
            body = await request.json()
            self.requests.append(body)
            await asyncio.sleep(self.delay_before)
            if self.status != 200:
                return JSONResponse({"error": {"message": "overloaded", "type": "server_error"}}, self.status)
            return StreamingResponse(self.stream(body), media_type="text/event-stream")

        return fake

    async def stream(self, body: dict[str, Any]):
        base = {"id": "c1", "object": "chat.completion.chunk", "created": 1, "model": body["model"]}
        for i, text in enumerate(self.chunks):
            if i:
                await asyncio.sleep(self.delay_between)
            choice = {"index": 0, "delta": {"role": "assistant", "content": text}, "finish_reason": None}
            yield f"data: {json.dumps({**base, 'choices': [choice]})}\n\n"
        last = {"index": 0, "delta": {}, "finish_reason": "stop"}
        yield f"data: {json.dumps({**base, 'choices': [last]})}\n\n"
        if self.usage and body.get("stream_options", {}).get("include_usage"):
            yield f"data: {json.dumps({**base, 'choices': [], 'usage': self.usage})}\n\n"
        yield "data: [DONE]\n\n"


@pytest.fixture
def model() -> FakeModel:
    return FakeModel()


@pytest.fixture(autouse=True)
async def use_fake_model(model: FakeModel, db_session: AsyncSession):
    """Serve the fake model over real HTTP on a free local port, so answers really stream."""
    server = uvicorn.Server(
        uvicorn.Config(
            model.app(), host="127.0.0.1", port=0, log_level="warning", timeout_graceful_shutdown=0
        )
    )
    task = asyncio.create_task(server.serve())
    while not server.started:  # noqa: ASYNC110 - uvicorn has no "started" event to wait on
        await asyncio.sleep(0.01)
    port = server.servers[0].sockets[0].getsockname()[1]
    # trust_env=False: never send local requests through the environment's proxy.
    http = AsyncClient(trust_env=False)
    openai = AsyncOpenAI(
        base_url=f"http://127.0.0.1:{port}/v1", api_key="test-key", http_client=http, max_retries=0
    )
    app.dependency_overrides[get_ai_client] = lambda: AiClient(openai, "glm-test")

    # Usage rows go to the test's session (rolled back afterwards) instead of a new connection.
    @asynccontextmanager
    async def test_session():
        yield db_session

    app.dependency_overrides[get_usage_sessions] = lambda: test_session
    yield
    app.dependency_overrides.pop(get_ai_client, None)
    app.dependency_overrides.pop(get_usage_sessions, None)
    await http.aclose()
    server.should_exit = True
    await task


def configure(monkeypatch: pytest.MonkeyPatch, **changes: Any) -> None:
    monkeypatch.setattr(ai_router, "settings", dataclasses.replace(ai_router.settings, **changes))


@pytest.fixture
async def ada(client: AsyncClient, caplog: Logs) -> Api:
    return await api_for(client, caplog, "ada@example.com")


# Helpers -----------------------------------------------------------------------------------------


@dataclass
class Answer:
    status: int
    events: list[tuple[str, dict[str, Any]]]
    body: dict[str, Any] | None
    headers: Any

    @property
    def text(self) -> str:
        return "".join(data["text"] for name, data in self.events if name == "delta")

    def last(self, name: str) -> dict[str, Any]:
        return [data for event, data in self.events if event == name][-1]


async def complete(api: Api, page: dict, action: str = "continue", **body: Any) -> Answer:
    response = await api.client.post(
        "/api/ai/complete", json={"action": action, "page_id": page["id"], **body}, headers=api.headers
    )
    if not response.headers.get("content-type", "").startswith("text/event-stream"):
        return Answer(response.status_code, [], response.json(), response.headers)
    events = []
    for block in response.text.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.splitlines())
        events.append((lines["event"], json.loads(lines["data"])))
    return Answer(response.status_code, events, None, response.headers)


async def logged(session: AsyncSession) -> list[AiUsage]:
    return list(await session.scalars(select(AiUsage).order_by(AiUsage.created_at)))


def yjs_page(*blocks: XmlElement) -> bytes:
    doc = Doc()
    fragment = doc.get(context.FIELD, type=XmlFragment)
    for block in blocks:
        fragment.children.append(block)
    return doc.get_update()


# Streaming ---------------------------------------------------------------------------------------


async def test_streams_the_answer_and_logs_the_usage(
    ada: Api, model: FakeModel, db_session: AsyncSession
) -> None:
    page = await ada.create("Launch plan")
    answer = await complete(ada, page, "write", prompt="An intro paragraph")

    assert answer.status == 200
    assert answer.headers["cache-control"] == "no-cache"
    assert [name for name, _ in answer.events] == ["delta", "delta", "delta", "done"]
    assert answer.text == "Hello, world."
    done = answer.last("done")
    assert done["finish_reason"] == "stop"
    assert done["usage"] == {"prompt_tokens": 40, "completion_tokens": 3, "total_tokens": 43}
    assert done["remaining"] == 200_000 - 43

    sent = model.requests[0]
    assert sent["model"] == "glm-test"
    assert sent["stream"] is True
    assert sent["stream_options"] == {"include_usage": True}
    assert sent["max_tokens"] == 1_500
    assert sent["messages"][0]["role"] == "system"
    user = sent["messages"][1]["content"]
    assert "Write what the user asks for" in user
    assert "Page title: Launch plan" in user
    assert "Request: An intro paragraph" in user

    [row] = await logged(db_session)
    assert (row.action, row.status, row.model, row.exact) == ("write", "completed", "glm-test", True)
    assert (row.prompt_tokens, row.completion_tokens, row.total_tokens) == (40, 3, 43)
    assert str(row.page_id) == page["id"] and str(row.workspace_id) == ada.workspace_id


async def test_estimates_tokens_when_the_provider_reports_none(
    ada: Api, model: FakeModel, db_session: AsyncSession
) -> None:
    model.usage = None
    answer = await complete(ada, await ada.create("Notes"), "explain", selection="Eventual consistency")
    assert answer.text == "Hello, world."
    [row] = await logged(db_session)
    assert row.exact is False
    assert row.completion_tokens == 3  # "Hello, world." is 13 characters
    assert row.prompt_tokens > 0
    assert answer.last("done")["usage"]["total_tokens"] == row.total_tokens


# Prompts and page context ------------------------------------------------------------------------


async def test_sends_the_live_page_as_markdown(ada: Api, model: FakeModel, db_session: AsyncSession) -> None:
    page = await ada.create("Roadmap")
    state = yjs_page(
        XmlElement("heading", {"level": "2"}, [XmlText("Goals")]),
        XmlElement("paragraph", {}, [XmlText("Ship sharing.")]),
        XmlElement(
            "bulletList",
            {},
            [
                XmlElement("listItem", {}, [XmlElement("paragraph", {}, [XmlText("Permissions")])]),
                XmlElement("listItem", {}, [XmlElement("paragraph", {}, [XmlText("Search")])]),
            ],
        ),
        XmlElement(
            "taskList",
            {},
            [XmlElement("taskItem", {"checked": "true"}, [XmlElement("paragraph", {}, [XmlText("Done")])])],
        ),
    )
    db_session.add(PageDoc(page_id=uuid.UUID(page["id"]), state=state))
    await db_session.flush()

    await complete(ada, page, "summarize")
    user = model.requests[0]["messages"][1]["content"]
    assert "**TL;DR:**" in user
    assert "<page>\n## Goals\n\nShip sharing.\n\n- Permissions\n- Search\n\n- [x] Done\n</page>" in user


async def test_falls_back_to_content_saved_before_live_editing(ada: Api, model: FakeModel) -> None:
    page = await ada.create("Old page")
    doc = {
        "type": "doc",
        "content": [
            {"type": "heading", "attrs": {"level": 1}, "content": [{"type": "text", "text": "Intro"}]},
            {"type": "paragraph", "content": [{"type": "text", "text": "Written in T09."}]},
        ],
    }
    response = await ada.client.put(
        f"/api/pages/{page['id']}/content", json={"content": doc}, headers=ada.headers
    )
    assert response.status_code == 200
    await complete(ada, page, "continue")
    assert "<page>\n# Intro\n\nWritten in T09.\n</page>" in model.requests[0]["messages"][1]["content"]


async def test_rewrites_use_the_selection_not_the_page(ada: Api, model: FakeModel) -> None:
    page = await ada.create("Doc")
    await complete(ada, page, "tone", selection="pls send the file", tone="professional")
    await complete(ada, page, "translate", selection="Hello", language="French")
    tone, translate = (r["messages"][1]["content"] for r in model.requests)
    assert "in a professional tone" in tone
    assert "<selection>\npls send the file\n</selection>" in tone
    assert "<page>" not in tone
    assert "Translate the selection into French" in translate


async def test_markdown_keeps_headings_when_trimmed() -> None:
    blocks = ["# Plan", "a" * 100, "## Risks", "b" * 100, "## Dates", "c" * 30]
    trimmed = context.trim(blocks, 90)
    assert trimmed.split("\n\n") == ["# Plan", "…", "## Risks", "…", "## Dates", "c" * 30]
    assert len(trimmed) <= 90
    assert context.trim(["short"], 90) == "short"


# Access and validation ---------------------------------------------------------------------------


async def test_needs_edit_access_and_a_live_page(ada: Api, client: AsyncClient, caplog: Logs) -> None:
    page = await ada.create("Private")
    cy = await api_for(client, caplog, "cy@example.com")
    assert (await complete(cy, page)).status == 404
    await Sharing(ada).share(page, "cy@example.com", "view")
    denied = await complete(cy, page)
    assert denied.status == 403
    assert denied.body == {"detail": "You can view this page but not change it"}
    await ada.trash(page)
    assert (await complete(ada, page)).status == 409


@pytest.mark.parametrize(
    ("body", "message"),
    [
        ({"action": "write"}, "write needs a prompt"),
        ({"action": "improve"}, "improve needs a selection"),
        ({"action": "tone", "selection": "x"}, "tone needs a tone"),
        ({"action": "translate", "selection": "x"}, "translate needs a language"),
        ({"action": "dance"}, "Input should be"),
    ],
)
async def test_checks_what_each_action_needs(ada: Api, body: dict, message: str) -> None:
    page = await ada.create("Doc")
    answer = await complete(ada, page, **body)
    assert answer.status == 422
    assert message in json.dumps(answer.body)


async def test_off_until_configured(ada: Api) -> None:
    app.dependency_overrides[get_ai_client] = lambda: None
    answer = await complete(ada, await ada.create("Doc"))
    assert answer.status == 503
    assert answer.body == {"detail": "AI isn't set up on this server"}
    usage = await ada.client.get("/api/ai/usage", headers=ada.headers)
    assert usage.json()["enabled"] is False


# Quota -------------------------------------------------------------------------------------------


async def test_daily_quota(
    ada: Api, model: FakeModel, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    configure(monkeypatch, ai_daily_token_quota=100)
    page = await ada.create("Doc")
    first = await complete(ada, page)
    assert first.last("done")["remaining"] == 57
    # The answer can't be longer than what's left.
    await complete(ada, page)
    assert model.requests[1]["max_tokens"] == 57

    usage = (await ada.client.get("/api/ai/usage", headers=ada.headers)).json()
    assert (usage["used_today"], usage["quota"], usage["remaining"], usage["enabled"]) == (86, 100, 14, True)

    await complete(ada, page)  # 129 used: over
    refused = await complete(ada, page)
    assert refused.status == 429
    assert refused.body == {"detail": "You've used today's AI allowance. It resets at midnight UTC."}
    assert 0 < int(refused.headers["retry-after"]) <= 86_400
    assert len(model.requests) == 3

    # Yesterday's usage doesn't count.
    for row in await logged(db_session):
        row.created_at = row.created_at.replace(year=2020)
    await db_session.flush()
    assert (await complete(ada, page)).status == 200


async def test_quota_is_per_person(
    ada: Api, client: AsyncClient, caplog: Logs, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    configure(monkeypatch, ai_daily_token_quota=40)
    page = await ada.create("Doc")
    await complete(ada, page)
    assert (await complete(ada, page)).status == 429
    bob = await api_for(client, caplog, "bob@example.com")
    assert (await complete(bob, await bob.create("Mine"))).status == 200


async def test_no_limit_with_quota_zero(ada: Api, model: FakeModel, monkeypatch: pytest.MonkeyPatch) -> None:
    configure(monkeypatch, ai_daily_token_quota=0)
    answer = await complete(ada, await ada.create("Doc"))
    assert answer.last("done")["remaining"] is None
    usage = (await ada.client.get("/api/ai/usage", headers=ada.headers)).json()
    assert usage["quota"] is None and usage["remaining"] is None


# Timeouts and provider errors --------------------------------------------------------------------


async def test_times_out_before_the_answer_starts(
    ada: Api, model: FakeModel, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    configure(monkeypatch, ai_timeout_seconds=0.2)
    model.delay_before = 5
    answer = await complete(ada, await ada.create("Doc"))
    assert answer.status == 504
    assert answer.body == {"detail": "The AI took too long to answer. Try again."}
    [row] = await logged(db_session)
    assert row.status == "timeout"


async def test_times_out_part_way_and_keeps_what_arrived(
    ada: Api, model: FakeModel, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    configure(monkeypatch, ai_timeout_seconds=0.3)
    model.chunks = ["One", " two", " three"]
    model.delay_between = 0.2
    answer = await complete(ada, await ada.create("Doc"))
    assert answer.status == 200
    assert answer.text == "One two"
    assert answer.events[-1] == (
        "error",
        {"code": "timeout", "message": "The AI took too long to answer. Try again."},
    )
    [row] = await logged(db_session)
    assert (row.status, row.exact) == ("timeout", False)
    assert row.completion_tokens == 2  # "One two", estimated


async def test_stopping_an_answer_still_counts_its_tokens(
    ada: Api, model: FakeModel, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The browser closes the connection (Stop) part way: the request ends, the usage is logged."""
    model.chunks = ["One", " two", " three", " four"]
    model.delay_between = 0.3
    page = await ada.create("Doc")
    body = json.dumps({"action": "continue", "page_id": page["id"]}).encode()
    headers = [(b"content-type", b"application/json")] + [
        (k.lower().encode(), v.encode()) for k, v in ada.headers.items()
    ]
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "https",
        "path": "/api/ai/complete",
        "raw_path": b"/api/ai/complete",
        "query_string": b"",
        "headers": headers,
        "client": ("127.0.0.1", 1),
        "server": ("test", 443),
        "app": app,
    }
    first_text = asyncio.Event()
    received: list[bytes] = []
    requested = False

    async def receive() -> dict:
        nonlocal requested
        if not requested:
            requested = True
            return {"type": "http.request", "body": body, "more_body": False}
        await first_text.wait()
        return {"type": "http.disconnect"}

    async def send(message: dict) -> None:
        if message["type"] == "http.response.body" and message.get("body"):
            received.append(message["body"])
            if b"event: delta" in message["body"]:
                first_text.set()

    await asyncio.wait_for(app(scope, receive, send), 5)
    assert b"One" in b"".join(received)
    assert b"four" not in b"".join(received)
    [row] = await logged(db_session)
    assert row.status == "stopped"
    assert row.completion_tokens >= 1


async def test_provider_errors_are_reported(ada: Api, model: FakeModel, db_session: AsyncSession) -> None:
    model.status = 500
    answer = await complete(ada, await ada.create("Doc"))
    assert answer.status == 502
    assert answer.body == {"detail": "The AI service couldn't answer. Try again in a moment."}
    [row] = await logged(db_session)
    assert row.status == "failed"


# Usage report ------------------------------------------------------------------------------------


async def test_workspace_usage_for_owners_and_admins(
    ada: Api, client: AsyncClient, caplog: Logs, db_session: AsyncSession
) -> None:
    page = await ada.create("Doc")
    await complete(ada, page)
    await complete(ada, page)
    await complete(ada, page, "explain", selection="x")
    rows = (await ada.client.get(f"/api/workspaces/{ada.workspace_id}/ai-usage", headers=ada.headers)).json()
    assert [(r["email"], r["action"], r["requests"], r["total_tokens"]) for r in rows] == [
        ("ada@example.com", "continue", 2, 86),
        ("ada@example.com", "explain", 1, 43),
    ]

    bob = await api_for(client, caplog, "bob@example.com")
    path = f"/api/workspaces/{ada.workspace_id}/ai-usage"
    assert (await bob.client.get(path, headers=bob.headers)).status_code == 404
    db_session.add(
        Member(workspace_id=uuid.UUID(ada.workspace_id), user_id=uuid.UUID(bob.user_id), role=Role.MEMBER)
    )
    await db_session.flush()
    assert (await bob.client.get(path, headers=bob.headers)).status_code == 403


async def test_ai_routes_require_sign_in(client: AsyncClient) -> None:
    assert (await client.post("/api/ai/complete", json={})).status_code == 401
    assert (await client.get("/api/ai/usage")).status_code == 401
