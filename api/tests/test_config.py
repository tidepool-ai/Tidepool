import dataclasses
import logging

import pytest
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

from app.auth import service
from app.config import magic_link_logging, normalize_database_url, settings

NEON = "postgresql://alex:secret@ep-cool-name-123.eu-central-1.aws.neon.tech/tidepool?sslmode=require&channel_binding=require"


def test_neon_url_is_converted_for_asyncpg() -> None:
    assert normalize_database_url(NEON) == (
        "postgresql+asyncpg://alex:secret@ep-cool-name-123.eu-central-1.aws.neon.tech/tidepool?ssl=require"
    )


@pytest.mark.parametrize(
    ("given", "expected"),
    [
        ("postgres://u:p@h:5432/db", "postgresql+asyncpg://u:p@h:5432/db"),
        ("postgresql://u:p@h/db", "postgresql+asyncpg://u:p@h/db"),
        ("postgresql+asyncpg://u:p@h/db?ssl=require", "postgresql+asyncpg://u:p@h/db?ssl=require"),
        (
            "postgresql://u:p@h/db?sslmode=disable&application_name=api",
            "postgresql+asyncpg://u:p@h/db?ssl=disable&application_name=api",
        ),
        ("", ""),
    ],
)
def test_other_urls(given: str, expected: str) -> None:
    assert normalize_database_url(given) == expected


def test_passwords_with_special_characters_survive() -> None:
    url = normalize_database_url("postgresql://u:p%40ss%2Fw0rd@h/db?sslmode=require")
    assert make_url(url).password == "p@ss/w0rd"


@pytest.mark.anyio
async def test_converted_url_connects(database_url: str) -> None:
    # A libpq-style URL for the real test database, as a host like Neon would hand it out.
    parsed = make_url(database_url)
    libpq = parsed.set(drivername="postgresql").render_as_string(hide_password=False) + "?sslmode=disable"
    engine = create_async_engine(normalize_database_url(libpq), poolclass=NullPool)
    try:
        async with engine.connect() as connection:
            assert await connection.scalar(text("SELECT 1")) == 1
    finally:
        await engine.dispose()


@pytest.mark.parametrize(
    ("value", "app_env", "expected"),
    [
        (None, "development", True),
        ("", "development", True),  # LOG_MAGIC_LINKS= as copied from .env.example
        ("  ", "production", False),
        (None, "production", False),
        ("true", "production", True),
        ("false", "development", False),
    ],
)
def test_magic_link_logging_default(value: str | None, app_env: str, expected: bool) -> None:
    assert magic_link_logging(value, app_env) is expected


def test_magic_links_are_not_logged_when_turned_off(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr(service, "settings", dataclasses.replace(settings, log_magic_links=False))
    with caplog.at_level(logging.INFO, logger="app.auth"):
        service.deliver_magic_link("ada@example.com", "https://app/auth/verify?token=secret")
    assert "secret" not in caplog.text
    assert "not configured" in caplog.text


def test_magic_links_are_logged_when_turned_on(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr(
        service, "settings", dataclasses.replace(settings, app_env="production", log_magic_links=True)
    )
    with caplog.at_level(logging.INFO, logger="app.auth"):
        service.deliver_magic_link("ada@example.com", "https://app/auth/verify?token=abc")
    assert "Magic link for ada@example.com: https://app/auth/verify?token=abc" in caplog.text
