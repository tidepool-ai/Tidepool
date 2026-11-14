import uuid
from datetime import datetime
from typing import Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.ai.prompts import NEEDS_PROMPT, NEEDS_SELECTION, Action, Tone


class CompleteIn(BaseModel):
    """POST /api/ai/complete. Which fields an action needs: app/ai/prompts.py."""

    model_config = ConfigDict(extra="forbid")

    action: Action
    page_id: uuid.UUID
    prompt: str = Field(default="", max_length=2_000)
    selection: str = Field(default="", max_length=20_000)
    tone: Tone | None = None
    language: str = Field(default="", max_length=40)

    @model_validator(mode="after")
    def _needs(self) -> Self:
        if self.action in NEEDS_PROMPT and not self.prompt.strip():
            raise ValueError(f"{self.action} needs a prompt")
        if self.action in NEEDS_SELECTION and not self.selection.strip():
            raise ValueError(f"{self.action} needs a selection")
        if self.action == "tone" and self.tone is None:
            raise ValueError("tone needs a tone")
        if self.action == "translate" and not self.language.strip():
            raise ValueError("translate needs a language")
        return self


class UsageOut(BaseModel):
    """The caller's AI allowance for today (UTC)."""

    used_today: int
    # null when there's no daily limit.
    quota: int | None
    remaining: int | None
    resets_at: datetime
    enabled: bool


class UsageRow(BaseModel):
    user_id: uuid.UUID
    email: str
    action: str
    requests: int
    total_tokens: int
