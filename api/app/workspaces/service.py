"""Workspace queries and the access check every workspace endpoint uses."""

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.workspaces.models import Member, Role, Workspace


class WorkspaceNotFoundError(Exception):
    """The workspace doesn't exist or the caller isn't a member (indistinguishable on purpose)."""


class WorkspaceForbiddenError(Exception):
    """The caller is a member, but their role can't do this."""


def personal_workspace_name(email: str) -> str:
    local = email.split("@", 1)[0] or "My"
    return f"{local[:80]}'s workspace"


async def create_personal_workspace(session: AsyncSession, user: User) -> Workspace:
    """Called on a user's first sign-in: a workspace they own, with them as its owner member."""
    workspace = Workspace(name=personal_workspace_name(user.email), owner_id=user.id)
    session.add(workspace)
    await session.flush()
    session.add(Member(workspace_id=workspace.id, user_id=user.id, role=Role.OWNER))
    await session.flush()
    return workspace


async def list_workspaces(session: AsyncSession, user_id: uuid.UUID) -> list[tuple[Workspace, str]]:
    """Workspaces the user is a member of, with their role, oldest first."""
    rows = await session.execute(
        select(Workspace, Member.role)
        .join(Member, Member.workspace_id == Workspace.id)
        .where(Member.user_id == user_id)
        .order_by(Workspace.created_at, Workspace.id)
    )
    return [(workspace, role) for workspace, role in rows.all()]


async def require_member(
    session: AsyncSession,
    workspace_id: uuid.UUID,
    user_id: uuid.UUID,
    allowed: frozenset[Role] = frozenset(Role),
) -> Member:
    """Return the caller's membership, or raise if they aren't a member or their role isn't allowed."""
    member = await session.get(Member, (workspace_id, user_id))
    if member is None:
        raise WorkspaceNotFoundError
    if Role(member.role) not in allowed:
        raise WorkspaceForbiddenError
    return member


async def list_members(session: AsyncSession, workspace_id: uuid.UUID) -> list[tuple[Member, str]]:
    rows = await session.execute(
        select(Member, User.email)
        .join(User, User.id == Member.user_id)
        .where(Member.workspace_id == workspace_id)
        .order_by(Member.created_at, User.email)
    )
    return [(member, email) for member, email in rows.all()]
