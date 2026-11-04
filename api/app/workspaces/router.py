"""Workspaces the caller belongs to, and their members, under /api/workspaces."""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import CurrentUser
from app.db import get_session
from app.workspaces import service
from app.workspaces.models import Role
from app.workspaces.schemas import MemberOut, WorkspaceOut

router = APIRouter(prefix="/api/workspaces", tags=["workspaces"])

Session = Annotated[AsyncSession, Depends(get_session)]

# Guests only see the pages shared with them, not who else is in the workspace.
CAN_LIST_MEMBERS = frozenset({Role.OWNER, Role.ADMIN, Role.MEMBER})


@router.get("")
async def list_workspaces(user: CurrentUser, session: Session) -> list[WorkspaceOut]:
    rows = await service.list_workspaces(session, user.id)
    return [
        WorkspaceOut(id=workspace.id, name=workspace.name, owner_id=workspace.owner_id, role=Role(role))
        for workspace, role in rows
    ]


@router.get("/{workspace_id}/members")
async def list_members(workspace_id: uuid.UUID, user: CurrentUser, session: Session) -> list[MemberOut]:
    try:
        await service.require_member(session, workspace_id, user.id, CAN_LIST_MEMBERS)
    except service.WorkspaceNotFoundError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workspace not found") from None
    except service.WorkspaceForbiddenError:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Guests can't view workspace members"
        ) from None
    rows = await service.list_members(session, workspace_id)
    return [MemberOut(user_id=member.user_id, email=email, role=Role(member.role)) for member, email in rows]
