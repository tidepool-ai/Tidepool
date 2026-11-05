import dataclasses
import io
import json
import logging
import re
import urllib.error
from urllib.parse import parse_qs, urlparse

import pytest
from httpx2 import AsyncClient

from app.auth import service
from app.config import settings
from app.email import sender
from app.email.sender import Email, EmailError

Logs = pytest.LogCaptureFixture
LINK = "https://tidepool.example/auth/verify?token=s3cret-token"


@pytest.fixture
def configure(monkeypatch: pytest.MonkeyPatch):
    """Replace settings where the auth service and the sender read them."""

    def apply(**changes: object) -> None:
        patched = dataclasses.replace(settings, **changes)
        monkeypatch.setattr(service, "settings", patched)
        monkeypatch.setattr(sender, "settings", patched)

    return apply


@pytest.fixture
def outbox(monkeypatch: pytest.MonkeyPatch) -> list[Email]:
    """Capture emails instead of calling Resend."""
    sent: list[Email] = []

    async def fake_send(email: Email) -> None:
        sent.append(email)

    monkeypatch.setattr(service, "send_email", fake_send)
    return sent


# Choosing between email and logs


@pytest.mark.anyio
async def test_emails_the_link_when_resend_is_configured(
    configure, outbox: list[Email], caplog: Logs
) -> None:
    configure(resend_api_key="re_test", log_magic_links=True)
    with caplog.at_level(logging.INFO, logger="app.auth"):
        await service.deliver_magic_link(" Ada@Example.com ", LINK)

    assert len(outbox) == 1
    email = outbox[0]
    assert email.to == "ada@example.com"
    assert email.subject == "Your Tidepool sign-in link"
    assert LINK in email.text
    assert "expires in 15 minutes" in email.text
    assert f'href="{LINK}"' in email.html
    # With a real sender, the link never goes to the logs, even if logging is on.
    assert "s3cret-token" not in caplog.text
    assert "Sign-in email sent to ada@example.com" in caplog.text


@pytest.mark.anyio
async def test_html_in_the_link_is_escaped(configure, outbox: list[Email]) -> None:
    configure(resend_api_key="re_test")
    await service.deliver_magic_link("ada@example.com", 'https://x/?token=a"><script>')
    assert "<script>" not in outbox[0].html
    assert "&quot;&gt;&lt;script&gt;" in outbox[0].html


@pytest.mark.anyio
async def test_a_failed_send_is_logged_without_the_link(
    configure, monkeypatch: pytest.MonkeyPatch, caplog: Logs
) -> None:
    configure(resend_api_key="re_test")

    async def failing_send(email: Email) -> None:
        raise EmailError("Resend answered 403: domain not verified")

    monkeypatch.setattr(service, "send_email", failing_send)
    with caplog.at_level(logging.INFO, logger="app.auth"):
        await service.deliver_magic_link("ada@example.com", LINK)

    assert "Sign-in email to ada@example.com failed: Resend answered 403: domain not verified" in caplog.text
    assert "s3cret-token" not in caplog.text


@pytest.mark.anyio
async def test_logs_the_link_without_resend_when_allowed(
    configure, outbox: list[Email], caplog: Logs
) -> None:
    configure(resend_api_key="", app_env="production", log_magic_links=True)
    with caplog.at_level(logging.INFO, logger="app.auth"):
        await service.deliver_magic_link("ada@example.com", LINK)
    assert f"Magic link for ada@example.com: {LINK}" in caplog.text
    assert outbox == []


@pytest.mark.anyio
async def test_neither_emails_nor_logs_when_nothing_is_configured(
    configure, outbox: list[Email], caplog: Logs
) -> None:
    configure(resend_api_key="", log_magic_links=False)
    with caplog.at_level(logging.INFO, logger="app.auth"):
        await service.deliver_magic_link("ada@example.com", LINK)
    assert "s3cret-token" not in caplog.text
    assert "not configured" in caplog.text
    assert outbox == []


# The Resend request


def test_resend_request_shape(configure) -> None:
    configure(resend_api_key="re_123", email_from="Tidepool <login@tidepool.example>")
    request = sender.build_request(Email(to="ada@example.com", subject="Hi", text="t", html="<p>h</p>"))

    assert request.full_url == "https://api.resend.com/emails"
    assert request.get_method() == "POST"
    assert request.get_header("Authorization") == "Bearer re_123"
    assert request.get_header("Content-type") == "application/json"
    assert json.loads(request.data) == {
        "from": "Tidepool <login@tidepool.example>",
        "to": ["ada@example.com"],
        "subject": "Hi",
        "text": "t",
        "html": "<p>h</p>",
    }


def test_default_sender_is_resends_test_address() -> None:
    assert settings.email_from == "Tidepool <onboarding@resend.dev>"


def test_provider_errors_become_email_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    request = sender.build_request(Email(to="a@example.com", subject="s", text="t", html="h"))

    def refused(*_args: object, **_kwargs: object):
        raise urllib.error.HTTPError(
            sender.RESEND_URL, 403, "Forbidden", {}, io.BytesIO(b'{"message":"bad"}')
        )

    monkeypatch.setattr(sender.urllib.request, "urlopen", refused)
    with pytest.raises(EmailError, match='403: {"message":"bad"}'):
        sender._send_blocking(request)

    def unreachable(*_args: object, **_kwargs: object):
        raise urllib.error.URLError("no route")

    monkeypatch.setattr(sender.urllib.request, "urlopen", unreachable)
    with pytest.raises(EmailError, match="Could not reach Resend"):
        sender._send_blocking(request)


@pytest.mark.anyio
async def test_send_email_refuses_without_a_key(configure) -> None:
    configure(resend_api_key="")
    with pytest.raises(EmailError, match="RESEND_API_KEY"):
        await sender.send_email(Email(to="a@example.com", subject="s", text="t", html="h"))


# Through the API


@pytest.mark.anyio
async def test_sign_in_end_to_end_with_email(client: AsyncClient, configure, outbox: list[Email]) -> None:
    configure(resend_api_key="re_test")

    response = await client.post("/api/auth/magic-link", json={"email": "ada@example.com"})

    assert response.status_code == 202
    assert len(outbox) == 1
    url = re.search(r"https?://\S+", outbox[0].text).group(0)
    token = parse_qs(urlparse(url).query)["token"][0]
    verified = await client.post("/api/auth/verify", json={"token": token})
    assert verified.status_code == 200


@pytest.mark.anyio
async def test_a_failed_email_does_not_change_the_answer(
    client: AsyncClient, configure, monkeypatch: pytest.MonkeyPatch
) -> None:
    configure(resend_api_key="re_test")

    async def failing_send(email: Email) -> None:
        raise EmailError("down")

    monkeypatch.setattr(service, "send_email", failing_send)
    response = await client.post("/api/auth/magic-link", json={"email": "ada@example.com"})
    assert response.status_code == 202


@pytest.mark.anyio
async def test_health_is_also_under_api(client: AsyncClient) -> None:
    response = await client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "database": "ok"}
