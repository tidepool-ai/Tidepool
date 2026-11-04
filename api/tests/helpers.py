"""Shared test helpers that go through the real sign-in flow."""

import logging
import re
from urllib.parse import parse_qs, urlparse

import pytest
from httpx2 import AsyncClient


async def sign_in(client: AsyncClient, caplog: pytest.LogCaptureFixture, email: str) -> dict[str, str]:
    """Sign in via magic link (read from the dev log) and return auth headers for that user."""
    caplog.clear()
    with caplog.at_level(logging.INFO, logger="app.auth"):
        await client.post("/api/auth/magic-link", json={"email": email})
    match = re.search(r"Magic link for \S+: (\S+)", caplog.text)
    assert match, caplog.text
    token = parse_qs(urlparse(match.group(1)).query)["token"][0]
    response = await client.post("/api/auth/verify", json={"token": token})
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['access_token']}"}
