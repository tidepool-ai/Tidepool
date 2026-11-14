"""Quota and the usage log (T23)."""

import uuid
from collections.abc import Callable
from contextlib import AbstractAsyncContextManager
from datetime import UTC, datetime, time, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.models import AiUsage
from app.auth.models import User
from app.db import SessionLocal

UsageSessions = Callable[[], AbstractAsyncContextManager[AsyncSession]]


def get_usage_sessions() -> UsageSessions:
    """FastAPI dependency: where usage rows are written.

    Not the request's session: when someone stops an answer, the request ends (and its session closes)
    while the usage still has to be counted.
    """
    return SessionLocal


def day_start(now: datetime | None = None) -> datetime:
    now = now or datetime.now(UTC)
    return datetime.combine(now.date(), time(), tzinfo=UTC)


def resets_at(now: datetime | None = None) -> datetime:
    return day_start(now) + timedelta(days=1)


async def used_today(session: AsyncSession, user_id: uuid.UUID) -> int:
    used = await session.scalar(
        select(func.coalesce(func.sum(AiUsage.total_tokens), 0)).where(
            AiUsage.user_id == user_id, AiUsage.created_at >= day_start()
        )
    )
    return int(used or 0)


def estimate_tokens(text: str) -> int:
    """About four characters per token, for providers that don't report usage."""
    return max(1, round(len(text) / 4)) if text else 0


async def log(sessions: UsageSessions, usage: AiUsage) -> None:
    async with sessions() as session:
        session.add(usage)
        await session.commit()


async def workspace_usage(
    session: AsyncSession, workspace_id: uuid.UUID, since: datetime
) -> list[tuple[uuid.UUID, str, str, int, int]]:
    """Requests and tokens per person and action since `since`, most tokens first."""
    total = func.sum(AiUsage.total_tokens)
    rows = await session.execute(
        select(AiUsage.user_id, User.email, AiUsage.action, func.count(), total)
        .join(User, User.id == AiUsage.user_id)
        .where(AiUsage.workspace_id == workspace_id, AiUsage.created_at >= since)
        .group_by(AiUsage.user_id, User.email, AiUsage.action)
        .order_by(total.desc(), User.email, AiUsage.action)
    )
    return [(row[0], row[1], row[2], int(row[3]), int(row[4] or 0)) for row in rows.all()]
