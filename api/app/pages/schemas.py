import uuid
from datetime import datetime

from pydantic import AnyHttpUrl, BaseModel, ConfigDict, Field

Title = Field(default="", max_length=200)
Icon = Field(default=None, max_length=32)


class PageCreate(BaseModel):
    workspace_id: uuid.UUID
    parent_id: uuid.UUID | None = None
    title: str = Title
    icon: str | None = Icon
    # http(s) only, so a cover can't be a javascript: URL.
    cover: AnyHttpUrl | None = None


class PageUpdate(BaseModel):
    """Rename and/or move. Only fields present in the request are changed."""

    model_config = ConfigDict(extra="forbid")

    title: str = Title
    icon: str | None = Icon
    cover: AnyHttpUrl | None = None
    # Move: another page in the same workspace, or null for the top level.
    parent_id: uuid.UUID | None = None


class PageOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    workspace_id: uuid.UUID
    parent_id: uuid.UUID | None
    title: str
    icon: str | None
    cover: str | None
    archived_at: datetime | None
    created_at: datetime
    updated_at: datetime
