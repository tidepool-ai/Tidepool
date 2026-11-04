import logging
import re
from datetime import timedelta
from urllib.parse import parse_qs, urlparse

import pytest
from httpx2 import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import service
from app.auth.models import MagicLink, RefreshToken, User
from app.auth.router import REFRESH_COOKIE

Logs = pytest.LogCaptureFixture

pytestmark = pytest.mark.anyio

EMAIL = "ada@example.com"


async def request_link(client: AsyncClient, caplog: Logs, email: str = EMAIL) -> str:
    """Request a magic link and return its token, read from the dev console log."""
    caplog.clear()
    with caplog.at_level(logging.INFO, logger="app.auth"):
        response = await client.post("/api/auth/magic-link", json={"email": email})
    assert response.status_code == 202
    match = re.search(r"Magic link for \S+: (\S+)", caplog.text)
    assert match, caplog.text
    return parse_qs(urlparse(match.group(1)).query)["token"][0]


async def sign_in(client: AsyncClient, caplog: Logs, email: str = EMAIL) -> str:
    """Sign in and return the access token; the refresh cookie is left in the client."""
    token = await request_link(client, caplog, email)
    response = await client.post("/api/auth/verify", json={"token": token})
    assert response.status_code == 200
    return response.json()["access_token"]


def refresh_cookie(client: AsyncClient) -> str:
    return client.cookies[REFRESH_COOKIE]


def use_refresh_cookie(client: AsyncClient, token: str) -> None:
    """Make the client present `token`, as another device (or an attacker) would."""
    client.cookies.clear()
    client.cookies.set(REFRESH_COOKIE, token)


# Request link


async def test_request_link_logs_url_to_web_app(client: AsyncClient, caplog: Logs) -> None:
    caplog.clear()
    with caplog.at_level(logging.INFO, logger="app.auth"):
        await client.post("/api/auth/magic-link", json={"email": "  Ada@Example.com "})
    assert "Magic link for ada@example.com: http://localhost:4200/auth/verify?token=" in caplog.text


async def test_request_link_stores_only_a_hash(
    client: AsyncClient, db_session: AsyncSession, caplog: Logs
) -> None:
    token = await request_link(client, caplog)
    link = await db_session.scalar(select(MagicLink))
    assert link is not None
    assert link.email == EMAIL
    assert link.token_hash == service.hash_token(token)
    assert token not in link.token_hash


async def test_request_link_does_not_create_user(
    client: AsyncClient, db_session: AsyncSession, caplog: Logs
) -> None:
    await request_link(client, caplog)
    assert await db_session.scalar(select(User)) is None


async def test_request_link_rejects_invalid_email(client: AsyncClient) -> None:
    response = await client.post("/api/auth/magic-link", json={"email": "not-an-email"})
    assert response.status_code == 422


# Verify link


async def test_verify_creates_user_and_issues_tokens(
    client: AsyncClient, db_session: AsyncSession, caplog: Logs
) -> None:
    token = await request_link(client, caplog)
    response = await client.post("/api/auth/verify", json={"token": token})

    assert response.status_code == 200
    body = response.json()
    assert body["token_type"] == "bearer"
    assert body["expires_in"] == 15 * 60

    cookie = response.headers["set-cookie"]
    assert cookie.startswith(f"{REFRESH_COOKIE}=")
    for attribute in ("HttpOnly", "Secure", "SameSite=strict", "Path=/api/auth"):
        assert attribute.lower() in cookie.lower()

    me = await client.get("/api/auth/me", headers={"Authorization": f"Bearer {body['access_token']}"})
    assert me.status_code == 200
    assert me.json()["email"] == EMAIL
    assert (await db_session.scalar(select(User))).email == EMAIL


async def test_verify_reuses_existing_user(
    client: AsyncClient, db_session: AsyncSession, caplog: Logs
) -> None:
    await sign_in(client, caplog)
    await sign_in(client, caplog, email="ADA@example.com")
    users = (await db_session.scalars(select(User))).all()
    assert [user.email for user in users] == [EMAIL]


async def test_verify_rejects_unknown_token(client: AsyncClient) -> None:
    response = await client.post("/api/auth/verify", json={"token": "nope"})
    assert response.status_code == 401
    assert REFRESH_COOKIE not in client.cookies


async def test_verify_rejects_reused_link(client: AsyncClient, caplog: Logs) -> None:
    token = await request_link(client, caplog)
    assert (await client.post("/api/auth/verify", json={"token": token})).status_code == 200
    assert (await client.post("/api/auth/verify", json={"token": token})).status_code == 401


async def test_verify_rejects_expired_link(
    client: AsyncClient, db_session: AsyncSession, caplog: Logs
) -> None:
    token = await request_link(client, caplog)
    await db_session.execute(update(MagicLink).values(expires_at=service.now() - timedelta(seconds=1)))
    response = await client.post("/api/auth/verify", json={"token": token})
    assert response.status_code == 401


# Access token


async def test_me_requires_access_token(client: AsyncClient) -> None:
    response = await client.get("/api/auth/me")
    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"


async def test_me_rejects_expired_access_token(client: AsyncClient, caplog: Logs) -> None:
    await sign_in(client, caplog)
    user_id = service.decode_access_token((await client.post("/api/auth/refresh")).json()["access_token"])
    expired = service.create_access_token(user_id, issued_at=service.now() - timedelta(minutes=16))
    response = await client.get("/api/auth/me", headers={"Authorization": f"Bearer {expired}"})
    assert response.status_code == 401


async def test_me_rejects_tampered_access_token(client: AsyncClient, caplog: Logs) -> None:
    access = await sign_in(client, caplog)
    header, payload, signature = access.split(".")
    tampered = f"{header}.{payload}.{signature[::-1]}"
    response = await client.get("/api/auth/me", headers={"Authorization": f"Bearer {tampered}"})
    assert response.status_code == 401


# Refresh


async def test_refresh_rotates_cookie_and_returns_new_access_token(client: AsyncClient, caplog: Logs) -> None:
    await sign_in(client, caplog)
    first = refresh_cookie(client)

    response = await client.post("/api/auth/refresh")

    assert response.status_code == 200
    second = refresh_cookie(client)
    assert second != first
    access = response.json()["access_token"]
    me = await client.get("/api/auth/me", headers={"Authorization": f"Bearer {access}"})
    assert me.status_code == 200


async def test_refresh_without_cookie_is_rejected(client: AsyncClient) -> None:
    response = await client.post("/api/auth/refresh")
    assert response.status_code == 401


async def test_refresh_rejects_expired_token(
    client: AsyncClient, db_session: AsyncSession, caplog: Logs
) -> None:
    await sign_in(client, caplog)
    await db_session.execute(update(RefreshToken).values(expires_at=service.now() - timedelta(seconds=1)))

    response = await client.post("/api/auth/refresh")

    assert response.status_code == 401
    assert REFRESH_COOKIE not in client.cookies


async def test_reused_refresh_token_revokes_the_whole_family(client: AsyncClient, caplog: Logs) -> None:
    await sign_in(client, caplog)
    stolen = refresh_cookie(client)
    assert (await client.post("/api/auth/refresh")).status_code == 200
    current = refresh_cookie(client)

    # An attacker replays the old, already-rotated token.
    use_refresh_cookie(client, stolen)
    replay = await client.post("/api/auth/refresh")
    assert replay.status_code == 401

    # The legitimate client's newer token is now dead too.
    use_refresh_cookie(client, current)
    after = await client.post("/api/auth/refresh")
    assert after.status_code == 401


async def test_refresh_does_not_affect_other_sessions(client: AsyncClient, caplog: Logs) -> None:
    await sign_in(client, caplog)
    laptop = refresh_cookie(client)
    client.cookies.clear()
    await sign_in(client, caplog)
    phone = refresh_cookie(client)

    use_refresh_cookie(client, laptop)
    assert (await client.post("/api/auth/refresh")).status_code == 200
    use_refresh_cookie(client, phone)
    assert (await client.post("/api/auth/refresh")).status_code == 200


# Logout


async def test_logout_clears_cookie_and_revokes_refresh_token(client: AsyncClient, caplog: Logs) -> None:
    await sign_in(client, caplog)
    token = refresh_cookie(client)

    response = await client.post("/api/auth/logout")

    assert response.status_code == 204
    assert REFRESH_COOKIE not in client.cookies
    use_refresh_cookie(client, token)
    reuse = await client.post("/api/auth/refresh")
    assert reuse.status_code == 401


async def test_logout_without_cookie_succeeds(client: AsyncClient) -> None:
    assert (await client.post("/api/auth/logout")).status_code == 204
