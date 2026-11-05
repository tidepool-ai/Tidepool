"""Sending email through Resend's HTTP API (https://resend.com/docs/api-reference/emails/send-email).

Uses the standard library in a worker thread, so there is no extra HTTP dependency for one POST.
"""

import asyncio
import json
import logging
import urllib.error
import urllib.request
from dataclasses import dataclass

from app.config import settings

logger = logging.getLogger(__name__)

RESEND_URL = "https://api.resend.com/emails"
TIMEOUT_SECONDS = 10


class EmailError(Exception):
    """The provider refused the message or could not be reached."""


@dataclass(frozen=True)
class Email:
    to: str
    subject: str
    text: str
    html: str


def email_configured() -> bool:
    return bool(settings.resend_api_key)


def build_request(email: Email) -> urllib.request.Request:
    body = {
        "from": settings.email_from,
        "to": [email.to],
        "subject": email.subject,
        "text": email.text,
        "html": email.html,
    }
    return urllib.request.Request(
        RESEND_URL,
        data=json.dumps(body).encode(),
        method="POST",
        headers={
            "Authorization": f"Bearer {settings.resend_api_key}",
            "Content-Type": "application/json",
            "User-Agent": "tidepool-api",
        },
    )


def _send_blocking(request: urllib.request.Request) -> None:
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:  # noqa: S310 - fixed https URL
            if response.status >= 300:
                raise EmailError(f"Resend answered {response.status}")
    except urllib.error.HTTPError as exc:
        # The body explains what's wrong (unverified domain, bad key, ...); it never contains the key.
        detail = exc.read().decode(errors="replace")[:300]
        raise EmailError(f"Resend answered {exc.code}: {detail}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise EmailError(f"Could not reach Resend: {exc}") from exc


async def send_email(email: Email) -> None:
    """Send one email. Raises EmailError on failure."""
    if not email_configured():
        raise EmailError("RESEND_API_KEY is not set")
    await asyncio.to_thread(_send_blocking, build_request(email))
