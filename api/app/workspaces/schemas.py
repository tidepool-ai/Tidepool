import uuid

from pydantic import BaseModel

from app.workspaces.models import Role


class WorkspaceOut(BaseModel):
    id: uuid.UUID
    name: str
    owner_id: uuid.UUID
    # The caller's role in this workspace.
    role: Role


class MemberOut(BaseModel):
    user_id: uuid.UUID
    email: str
    role: Role
