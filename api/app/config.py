"""Settings read from environment variables (see api/.env.example)."""

import os
from dataclasses import dataclass, field


def _flag(value: str) -> bool:
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _split(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


@dataclass(frozen=True)
class Settings:
    cors_origins: list[str] = field(
        default_factory=lambda: _split(os.getenv("CORS_ORIGINS", "http://localhost:4200"))
    )
    database_url: str = os.getenv(
        "DATABASE_URL", "postgresql+asyncpg://tidepool:tidepool@localhost:5432/tidepool"
    )
    # Used by the test suite. Empty means DATABASE_URL with "_test" appended to the database name.
    test_database_url: str = os.getenv("TEST_DATABASE_URL", "")
    # "development" logs magic links to the console instead of emailing them.
    app_env: str = os.getenv("APP_ENV", "development")
    # Web app origin, used to build magic links.
    app_url: str = os.getenv("APP_URL", "http://localhost:4200")
    # Signs access tokens. Required; there is deliberately no default.
    jwt_secret: str = os.getenv("JWT_SECRET", "")
    access_token_minutes: int = 15
    refresh_token_days: int = 30
    magic_link_minutes: int = 15
    refresh_cookie_secure: bool = _flag(os.getenv("REFRESH_COOKIE_SECURE", "true"))
    glm_base_url: str = os.getenv("GLM_BASE_URL", "")
    glm_api_key: str = os.getenv("GLM_API_KEY", "")
    glm_model: str = os.getenv("GLM_MODEL", "")


settings = Settings()
