"""AI over SSE (T23): POST /api/ai/complete streams the model's answer, within a daily token quota.

Events (each `event: <name>` then `data: <json>`):
- `delta`  {"text": "..."}: the next piece of the answer
- `done`   {"finish_reason", "usage": {prompt_tokens, completion_tokens, total_tokens}, "remaining"}
- `error`  {"code": "timeout" | "unavailable", "message"}: the answer stopped part way

Problems found before the answer starts are ordinary HTTP errors: 503 (AI not set up), 404/403 (page),
422 (request), 429 (quota used up, with Retry-After), 502 (the model couldn't be reached), 504 (no
answer in time).
"""

import asyncio
import json
import logging
import time
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any

import openai
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai import context, prompts, service
from app.ai.client import AiClient, get_ai_client
from app.ai.models import AiUsage
from app.ai.schemas import CompleteIn, UsageOut, UsageRow
from app.auth.deps import CurrentUser
from app.config import settings
from app.db import get_session
from app.pages import service as pages
from app.pages.models import Page, PageContent
from app.permissions.service import Level
from app.realtime.models import PageDoc
from app.workspaces.models import Role
from app.workspaces.service import WorkspaceForbiddenError, WorkspaceNotFoundError, require_member

logger = logging.getLogger(__name__)

router = APIRouter(tags=["ai"])

Session = Annotated[AsyncSession, Depends(get_session)]
Client = Annotated[AiClient | None, Depends(get_ai_client)]
UsageSessions = Annotated[service.UsageSessions, Depends(service.get_usage_sessions)]

NOT_SET_UP = HTTPException(
    status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="AI isn't set up on this server"
)
TIMEOUT_MESSAGE = "The AI took too long to answer. Try again."
UNAVAILABLE_MESSAGE = "The AI service couldn't answer. Try again in a moment."


def _sse(event: str, data: dict[str, Any]) -> bytes:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode()


async def _page_markdown(request: Request, session: AsyncSession, page: Page) -> str:
    """The page as Markdown: the live document if it's open on this worker, else the saved one."""
    rooms = getattr(request.app.state, "rooms", None)
    room = rooms.rooms.get(page.id) if rooms is not None else None
    state = room.doc.get_update() if room is not None else None
    if state is None:
        state = await session.scalar(select(PageDoc.state).where(PageDoc.page_id == page.id))
    nodes = context.from_yjs(state) if state else []
    if not nodes:
        # Pages saved before live editing (T09) and never opened since.
        nodes = context.from_json(
            await session.scalar(select(PageContent.doc).where(PageContent.page_id == page.id))
        )
    return context.trim(context.to_markdown(nodes), settings.ai_context_chars)


def _remaining(used: int) -> int | None:
    quota = settings.ai_daily_token_quota
    return max(quota - used, 0) if quota > 0 else None


@router.get("/api/ai/usage")
async def my_usage(user: CurrentUser, session: Session, client: Client) -> UsageOut:
    """The caller's tokens used today and what's left (the web app shows it near the AI prompt)."""
    used = await service.used_today(session, user.id)
    quota = settings.ai_daily_token_quota
    return UsageOut(
        used_today=used,
        quota=quota if quota > 0 else None,
        remaining=_remaining(used),
        resets_at=service.resets_at(),
        enabled=client is not None,
    )


@router.get("/api/workspaces/{workspace_id}/ai-usage")
async def workspace_usage(
    workspace_id: uuid.UUID, user: CurrentUser, session: Session, days: int = 30
) -> list[UsageRow]:
    """Tokens per person and feature over the last `days` days (1–90). Owners and admins only."""
    try:
        await require_member(session, workspace_id, user.id, frozenset({Role.OWNER, Role.ADMIN}))
    except WorkspaceNotFoundError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workspace not found") from None
    except WorkspaceForbiddenError:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Only owners and admins can see AI usage"
        ) from None
    since = datetime.now(UTC) - timedelta(days=min(max(days, 1), 90))
    rows = await service.workspace_usage(session, workspace_id, since)
    return [
        UsageRow(user_id=uid, email=email, action=action, requests=count, total_tokens=tokens)
        for uid, email, action, count, tokens in rows
    ]


@router.post("/api/ai/complete", response_class=StreamingResponse)
async def complete(
    body: CompleteIn,
    request: Request,
    user: CurrentUser,
    session: Session,
    client: Client,
    usage_sessions: UsageSessions,
) -> StreamingResponse:
    """Stream the answer for one action (write, rewrite, summarize, ...) on a page the caller can edit."""
    if client is None:
        raise NOT_SET_UP
    try:
        page = await pages.get_page(session, body.page_id, user.id, need=Level.EDIT)
    except pages.PageNotFoundError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Page not found") from None
    except pages.PageForbiddenError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from None
    if page.archived_at is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Restore the page before using AI on it"
        )

    used = await service.used_today(session, user.id)
    remaining = _remaining(used)
    if remaining == 0:
        retry = int((service.resets_at() - datetime.now(UTC)).total_seconds()) + 1
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="You've used today's AI allowance. It resets at midnight UTC.",
            headers={"Retry-After": str(retry)},
        )

    page_text = await _page_markdown(request, session, page) if body.action in prompts.USES_PAGE else ""
    messages = prompts.messages(
        prompts.Request(
            action=body.action,
            title=page.title,
            page=page_text,
            selection=body.selection,
            prompt=body.prompt.strip(),
            tone=body.tone or "",
            language=body.language.strip(),
        )
    )
    max_tokens = (
        settings.ai_max_output_tokens if remaining is None else min(settings.ai_max_output_tokens, remaining)
    )
    usage = AiUsage(
        user_id=user.id,
        workspace_id=page.workspace_id,
        page_id=page.id,
        action=body.action,
        model=client.model,
        status="failed",
    )
    started = time.monotonic()
    deadline = asyncio.get_running_loop().time() + settings.ai_timeout_seconds
    prompt_text = "".join(m["content"] for m in messages)

    async def finish(answer: str, reported: Any | None) -> None:
        if reported is not None:
            usage.prompt_tokens = int(getattr(reported, "prompt_tokens", 0) or 0)
            usage.completion_tokens = int(getattr(reported, "completion_tokens", 0) or 0)
        else:
            usage.exact = False
            usage.prompt_tokens = service.estimate_tokens(prompt_text)
            usage.completion_tokens = service.estimate_tokens(answer)
        usage.total_tokens = usage.prompt_tokens + usage.completion_tokens
        usage.duration_ms = int((time.monotonic() - started) * 1000)
        try:
            await service.log(usage_sessions, usage)
        except Exception:  # the answer was delivered; a lost log row mustn't hide that
            logger.exception("Couldn't log AI usage for %s", user.id)

    # Open the stream before answering, so a provider that's down or slow gets a proper HTTP error.
    try:
        async with asyncio.timeout_at(deadline):
            stream = await client.openai.chat.completions.create(
                model=client.model,
                messages=messages,  # type: ignore[arg-type]
                stream=True,
                stream_options={"include_usage": True},
                max_tokens=max_tokens,
            )
    except (TimeoutError, openai.APITimeoutError):
        usage.status = "timeout"
        await finish("", None)
        raise HTTPException(status_code=status.HTTP_504_GATEWAY_TIMEOUT, detail=TIMEOUT_MESSAGE) from None
    except openai.APIError as exc:
        logger.warning("AI request failed: %s", exc)
        await finish("", None)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=UNAVAILABLE_MESSAGE) from None

    async def events() -> AsyncIterator[bytes]:
        answer: list[str] = []
        reported = None
        finish_reason = None
        try:
            async with asyncio.timeout_at(deadline):
                async for chunk in stream:
                    if chunk.usage is not None:
                        reported = chunk.usage
                    for choice in chunk.choices:
                        finish_reason = choice.finish_reason or finish_reason
                        text = choice.delta.content if choice.delta else None
                        if text:
                            answer.append(text)
                            yield _sse("delta", {"text": text})
            usage.status = "completed"
            await finish("".join(answer), reported)
            yield _sse(
                "done",
                {
                    "finish_reason": finish_reason,
                    "usage": {
                        "prompt_tokens": usage.prompt_tokens,
                        "completion_tokens": usage.completion_tokens,
                        "total_tokens": usage.total_tokens,
                    },
                    "remaining": _remaining(used + usage.total_tokens),
                },
            )
        except (TimeoutError, openai.APITimeoutError):
            usage.status = "timeout"
            await finish("".join(answer), reported)
            yield _sse("error", {"code": "timeout", "message": TIMEOUT_MESSAGE})
        except openai.APIError as exc:
            logger.warning("AI stream failed: %s", exc)
            await finish("".join(answer), reported)
            yield _sse("error", {"code": "unavailable", "message": UNAVAILABLE_MESSAGE})
        except (asyncio.CancelledError, GeneratorExit):
            # The person pressed Stop (the browser closed the connection): count what was generated.
            usage.status = "stopped"
            await asyncio.shield(finish("".join(answer), reported))
            raise
        finally:
            await stream.close()

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
