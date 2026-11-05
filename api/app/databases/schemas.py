import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.databases.properties import PropertyDef

Layout = Literal["table", "board"]


class DatabaseCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    workspace_id: uuid.UUID
    parent_id: uuid.UUID | None = None
    title: str = Field(default="", max_length=200)
    # Defaults to just the title property ("Name").
    properties: list[PropertyDef] | None = Field(default=None, min_length=1, max_length=100)


class SchemaIn(BaseModel):
    """The whole schema. Properties keep their values while their id and type stay the same."""

    model_config = ConfigDict(extra="forbid")

    properties: list[PropertyDef] = Field(min_length=1, max_length=100)


class ViewConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    filter: dict[str, Any] | None = None
    sorts: list[dict[str, Any]] = Field(default_factory=list)
    # Board: the select or status property that makes the columns.
    group_by: str | None = None
    # Property ids to show, in order; null shows all.
    visible_properties: list[str] | None = None
    # Column widths in px, by property id (Table).
    widths: dict[str, int] = Field(default_factory=dict)


class ViewIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=100)
    layout: Layout = "table"
    config: ViewConfig = Field(default_factory=ViewConfig)


class ViewUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=100)
    layout: Layout | None = None
    config: ViewConfig | None = None
    position: int | None = Field(default=None, ge=0)


class ViewOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    layout: Layout
    config: ViewConfig
    position: int


class DatabaseOut(BaseModel):
    id: uuid.UUID
    page_id: uuid.UUID
    title: str
    archived_at: datetime | None
    properties: list[dict[str, Any]]
    views: list[ViewOut]


class RowIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(default="", max_length=200)
    icon: str | None = Field(default=None, max_length=32)
    # Values by property id; see app/databases/properties.py for each type's form.
    properties: dict[str, Any] = Field(default_factory=dict)


class RowUpdate(BaseModel):
    """Only what's sent changes; a property set to null is cleared."""

    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, max_length=200)
    icon: str | None = Field(default=None, max_length=32)
    properties: dict[str, Any] = Field(default_factory=dict)


class RowOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    database_id: uuid.UUID
    title: str
    icon: str | None
    properties: dict[str, Any]
    created_at: datetime
    updated_at: datetime


class QueryIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Use this view's filter and sorts unless `filter` / `sorts` are given.
    view_id: uuid.UUID | None = None
    filter: dict[str, Any] | None = None
    sorts: list[dict[str, Any]] | None = None
    page_size: int = Field(default=50, ge=1, le=100)
    # `next_cursor` from the previous page of the same query.
    cursor: str | None = Field(default=None, max_length=4000)


class QueryOut(BaseModel):
    results: list[RowOut]
    next_cursor: str | None
    has_more: bool
