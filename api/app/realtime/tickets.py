"""Short-lived tickets that open a page's socket.

Browsers can't set headers on a WebSocket, so the token travels in the URL. A ticket is only good
for one page for a minute, so one that ends up in a log is of little use; the access token never does.
"""

import uuid
from datetime import UTC, datetime, timedelta

import jwt

from app.auth.service import JWT_ALGORITHM, _jwt_secret

TICKET_TYPE = "realtime"
TICKET_SECONDS = 60


class InvalidTicketError(Exception):
    pass


def create_ticket(user_id: uuid.UUID, page_id: uuid.UUID, issued_at: datetime | None = None) -> str:
    issued_at = issued_at or datetime.now(UTC)
    claims = {
        "sub": str(user_id),
        "page": str(page_id),
        "type": TICKET_TYPE,
        "iat": issued_at,
        "exp": issued_at + timedelta(seconds=TICKET_SECONDS),
    }
    return jwt.encode(claims, _jwt_secret(), algorithm=JWT_ALGORITHM)


def read_ticket(ticket: str, page_id: uuid.UUID) -> uuid.UUID:
    """The user the ticket was issued to, if it's valid for this page."""
    try:
        options = {"require": ["exp", "sub"]}
        claims = jwt.decode(ticket, _jwt_secret(), algorithms=[JWT_ALGORITHM], options=options)
        if claims.get("type") != TICKET_TYPE or claims.get("page") != str(page_id):
            raise InvalidTicketError
        return uuid.UUID(claims["sub"])
    except (jwt.PyJWTError, ValueError, KeyError) as exc:
        raise InvalidTicketError from exc
