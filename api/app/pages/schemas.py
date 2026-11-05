import uuid
from datetime import datetime
from typing import Any

from pydantic import AnyHttpUrl, BaseModel, ConfigDict, Field, field_validator

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
    # Set for database rows (T16).
    database_id: uuid.UUID | None = None
    created_at: datetime
    updated_at: datetime


class PageContentIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # A Tiptap document: {"type": "doc", "content": [...]}
    content: dict[str, Any]

    @field_validator("content")
    @classmethod
    def _is_document(cls, value: dict[str, Any]) -> dict[str, Any]:
        if value.get("type") != "doc":
            raise ValueError('content must be a document: {"type": "doc", ...}')
        if not isinstance(value.get("content", []), list):
            raise ValueError("content.content must be a list of blocks")
        return value


class PageContentOut(BaseModel):
    # Echoed so a client can tell which page a (possibly late) response belongs to.
    page_id: uuid.UUID
    # null until the page is first saved
    content: dict[str, Any] | None
    updated_at: datetime | None
