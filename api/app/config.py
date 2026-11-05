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


# `or`, not a getenv default: an empty value (as in .env.example) means "use the default".
_APP_ENV = os.getenv("APP_ENV") or "development"


def magic_link_logging(value: str | None, app_env: str) -> bool:
    """LOG_MAGIC_LINKS: an explicit value wins; unset or empty means on in development only."""
    if value is None or not value.strip():
        return app_env == "development"
    return _flag(value)


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
    log_magic_links: bool = field(
        default_factory=lambda: magic_link_logging(os.getenv("LOG_MAGIC_LINKS"), _APP_ENV)
    )
    # Web app origin, used to build magic links.
    app_url: str = os.getenv("APP_URL", "http://localhost:4200")
    # Signs access tokens. Required; there is deliberately no default.
    jwt_secret: str = os.getenv("JWT_SECRET", "")
    access_token_minutes: int = 15
    refresh_token_days: int = 30
    magic_link_minutes: int = 15
    refresh_cookie_secure: bool = _flag(os.getenv("REFRESH_COOKIE_SECURE", "true"))
    # Largest page document the API accepts, in bytes of JSON (PUT /api/pages/{id}/content).
    max_page_content_bytes: int = int(os.getenv("MAX_PAGE_CONTENT_BYTES") or 1_000_000)
    # Email (sign-in links) via Resend (https://resend.com). With a key set, links are emailed and
    # never logged. EMAIL_FROM must be an address on a domain verified in Resend; Resend's test sender
    # onboarding@resend.dev only delivers to the Resend account's own email address.
    resend_api_key: str = os.getenv("RESEND_API_KEY", "")
    email_from: str = os.getenv("EMAIL_FROM") or "Tidepool <onboarding@resend.dev>"
    # Image uploads (T13): any S3-compatible bucket that supports POST policy uploads (AWS S3, MinIO).
    # Empty S3_BUCKET turns uploads off. S3_ENDPOINT_URL is only for non-AWS services such as MinIO.
    s3_bucket: str = os.getenv("S3_BUCKET", "")
    s3_endpoint_url: str = os.getenv("S3_ENDPOINT_URL", "")
    s3_region: str = os.getenv("S3_REGION") or "us-east-1"
    s3_access_key_id: str = os.getenv("S3_ACCESS_KEY_ID", "")
    s3_secret_access_key: str = os.getenv("S3_SECRET_ACCESS_KEY", "")
    # Largest image accepted, in bytes (25 MB, PRD security table).
    max_upload_bytes: int = int(os.getenv("MAX_UPLOAD_BYTES") or 25 * 1024 * 1024)
    glm_base_url: str = os.getenv("GLM_BASE_URL", "")
    glm_api_key: str = os.getenv("GLM_API_KEY", "")
    glm_model: str = os.getenv("GLM_MODEL", "")


settings = Settings()
