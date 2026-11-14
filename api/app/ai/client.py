"""The shared GLM client (OpenAI-compatible API). The key stays on the server."""

from dataclasses import dataclass
from functools import lru_cache

from openai import AsyncOpenAI

from app.config import settings


@dataclass(frozen=True)
class AiClient:
    openai: AsyncOpenAI
    model: str


@lru_cache
def _client(base_url: str, api_key: str, model: str, timeout: float) -> AiClient:
    # The SDK retries connection errors and 429/5xx itself; once is enough inside our time limit.
    openai = AsyncOpenAI(base_url=base_url, api_key=api_key, timeout=timeout, max_retries=1)
    return AiClient(openai, model)


def get_ai_client() -> AiClient | None:
    """FastAPI dependency: the client, or None while GLM_BASE_URL / GLM_API_KEY / GLM_MODEL aren't set."""
    if not (settings.glm_base_url and settings.glm_api_key and settings.glm_model):
        return None
    return _client(
        settings.glm_base_url, settings.glm_api_key, settings.glm_model, settings.ai_timeout_seconds
    )
