"""Token issuing and validation for magic-link sign-in."""

import hashlib
import logging
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from urllib.parse import urlencode

import jwt
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import MagicLink, RefreshToken, User
from app.config import settings
from app.workspaces.service import create_personal_workspace

logger = logging.getLogger(__name__)

JWT_ALGORITHM = "HS256"


class InvalidTokenError(Exception):
    """A magic link, refresh token or access token is missing, wrong, expired or reused."""


def now() -> datetime:
    return datetime.now(UTC)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def normalize_email(email: str) -> str:
    return email.strip().lower()


def _jwt_secret() -> str:
    if not settings.jwt_secret:
        raise RuntimeError("JWT_SECRET is not set")
    return settings.jwt_secret


async def create_magic_link(session: AsyncSession, email: str) -> str:
    """Store a new single-use link for `email` and return its URL."""
    token = secrets.token_urlsafe(32)
    session.add(
        MagicLink(
            email=normalize_email(email),
            token_hash=hash_token(token),
            expires_at=now() + timedelta(minutes=settings.magic_link_minutes),
        )
    )
    await session.commit()
    return f"{settings.app_url}/auth/verify?{urlencode({'token': token})}"


def deliver_magic_link(email: str, url: str) -> None:
    # No email sender yet (MVP): in development the link goes to the console.
    if settings.app_env == "development":
        logger.info("Magic link for %s: %s", normalize_email(email), url)
    else:
        logger.warning("Email delivery is not configured; magic link for %s was not sent", email)


async def consume_magic_link(session: AsyncSession, token: str) -> User:
    """Mark the link used and return its user. First sign-in creates the user and a personal workspace."""
    link = await session.scalar(
        select(MagicLink).where(MagicLink.token_hash == hash_token(token)).with_for_update()
    )
    if link is None or link.used_at is not None or link.expires_at <= now():
        raise InvalidTokenError
    link.used_at = now()

    user = await session.scalar(select(User).where(User.email == link.email))
    if user is None:
        user = User(email=link.email)
        session.add(user)
        await session.flush()
        await create_personal_workspace(session, user)
    return user


def create_access_token(user_id: uuid.UUID, issued_at: datetime | None = None) -> str:
    issued_at = issued_at or now()
    claims = {
        "sub": str(user_id),
        "type": "access",
        "iat": issued_at,
        "exp": issued_at + timedelta(minutes=settings.access_token_minutes),
    }
    return jwt.encode(claims, _jwt_secret(), algorithm=JWT_ALGORITHM)


def decode_access_token(token: str) -> uuid.UUID:
    try:
        claims = jwt.decode(
            token, _jwt_secret(), algorithms=[JWT_ALGORITHM], options={"require": ["exp", "sub"]}
        )
        if claims.get("type") != "access":
            raise InvalidTokenError
        return uuid.UUID(claims["sub"])
    except (jwt.PyJWTError, ValueError) as exc:
        raise InvalidTokenError from exc


async def issue_refresh_token(
    session: AsyncSession, user_id: uuid.UUID, family_id: uuid.UUID | None = None
) -> str:
    token = secrets.token_urlsafe(32)
    session.add(
        RefreshToken(
            user_id=user_id,
            family_id=family_id or uuid.uuid4(),
            token_hash=hash_token(token),
            expires_at=now() + timedelta(days=settings.refresh_token_days),
        )
    )
    await session.flush()
    return token


async def _revoke_family(session: AsyncSession, family_id: uuid.UUID) -> None:
    await session.execute(
        update(RefreshToken)
        .where(RefreshToken.family_id == family_id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=now())
    )


async def rotate_refresh_token(session: AsyncSession, token: str) -> tuple[uuid.UUID, str]:
    """Swap a valid refresh token for a new one. Returns (user_id, new token).

    A revoked (already rotated or logged-out) token revokes its whole family.
    """
    stored = await session.scalar(
        select(RefreshToken).where(RefreshToken.token_hash == hash_token(token)).with_for_update()
    )
    if stored is None:
        raise InvalidTokenError
    if stored.revoked_at is not None:
        await _revoke_family(session, stored.family_id)
        await session.commit()
        logger.warning("Refresh token reuse detected for user %s; family revoked", stored.user_id)
        raise InvalidTokenError
    if stored.expires_at <= now():
        raise InvalidTokenError

    stored.revoked_at = now()
    new_token = await issue_refresh_token(session, stored.user_id, stored.family_id)
    return stored.user_id, new_token


async def revoke_refresh_token(session: AsyncSession, token: str) -> None:
    """Log out: revoke the token's whole family (this device's session)."""
    stored = await session.scalar(select(RefreshToken).where(RefreshToken.token_hash == hash_token(token)))
    if stored is not None:
        await _revoke_family(session, stored.family_id)
        await session.commit()
