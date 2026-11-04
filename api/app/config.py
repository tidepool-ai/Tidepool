"""Settings read from environment variables (see api/.env.example)."""

import os
from dataclasses import dataclass, field
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


def _flag(value: str) -> bool:
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _split(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def normalize_database_url(url: str) -> str:
    """Accept the connection strings hosts hand out (Neon, Render, Heroku-style) for the asyncpg driver.

    - postgres:// and postgresql:// become postgresql+asyncpg://
    - libpq's sslmode=... becomes asyncpg's ssl=...
    - channel_binding is dropped (libpq-only; asyncpg negotiates SCRAM itself)
    """
    parts = urlsplit(url)
    if parts.scheme in {"postgres", "postgresql"}:
        parts = parts._replace(scheme="postgresql+asyncpg")
    if parts.scheme != "postgresql+asyncpg" or not parts.query:
        return urlunsplit(parts)
    query = []
    for key, value in parse_qsl(parts.query, keep_blank_values=True):
        if key == "channel_binding":
            continue
        query.append(("ssl" if key == "sslmode" else key, value))
    return urlunsplit(parts._replace(query=urlencode(query)))


_APP_ENV = os.getenv("APP_ENV", "development")


@dataclass(frozen=True)
class Settings:
    cors_origins: list[str] = field(
        default_factory=lambda: _split(os.getenv("CORS_ORIGINS", "http://localhost:4200"))
    )
    database_url: str = normalize_database_url(
        os.getenv("DATABASE_URL", "postgresql+asyncpg://tidepool:tidepool@localhost:5432/tidepool")
    )
    # Used by the test suite. Empty means DATABASE_URL with "_test" appended to the database name.
    test_database_url: str = normalize_database_url(os.getenv("TEST_DATABASE_URL", ""))
    app_env: str = _APP_ENV
    # No email sender yet, so sign-in links can only be logged. On by default in development.
    # Turning it on elsewhere lets anyone who can read the logs sign in as any user: test deploys only.
    log_magic_links: bool = _flag(
        os.getenv("LOG_MAGIC_LINKS", "true" if _APP_ENV == "development" else "false")
    )
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
