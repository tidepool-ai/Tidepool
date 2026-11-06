import uuid
from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr

LevelName = Literal["view", "comment", "edit", "full"]
GeneralAccess = Literal["invited", "workspace", "public"]


class ShareIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: EmailStr
    level: LevelName = "edit"


class LevelIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    level: LevelName


class GeneralAccessIn(BaseModel):
    """null `access` goes back to inheriting from the parent page."""

    model_config = ConfigDict(extra="forbid")

    access: GeneralAccess | None
    # What workspace members get with "workspace" or "public".
    level: LevelName = "full"


class PageRef(BaseModel):
    id: uuid.UUID
    title: str


class PersonOut(BaseModel):
    user_id: uuid.UUID
    email: str
    level: LevelName
    # Set when the access comes from a page above this one.
    inherited_from: PageRef | None
    # Their workspace role, or null if they've left it.
    role: str | None


class GeneralOut(BaseModel):
    access: GeneralAccess
    level: LevelName
    # The page it's set on, when that's a page above; null when set here or the default.
    inherited_from: PageRef | None


class PermissionsOut(BaseModel):
    page_id: uuid.UUID
    # The caller's own level, and whether they can change sharing (full access).
    access: LevelName
    can_share: bool
    general: GeneralOut
    people: list[PersonOut]
