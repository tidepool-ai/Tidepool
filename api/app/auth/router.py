"""Magic-link sign-in, token refresh and logout under /api/auth."""

import uuid
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Cookie, Depends, HTTPException, Response, status
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import service
from app.auth.deps import CurrentUser
from app.auth.schemas import MagicLinkRequest, TokenResponse, UserOut, VerifyRequest
from app.config import settings
from app.db import get_session

router = APIRouter(prefix="/api/auth", tags=["auth"])

REFRESH_COOKIE = "tp_refresh"
REFRESH_COOKIE_PATH = "/api/auth"

Session = Annotated[AsyncSession, Depends(get_session)]
RefreshCookie = Annotated[str | None, Cookie(alias=REFRESH_COOKIE)]


def _invalid(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=detail)


def _set_refresh_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        REFRESH_COOKIE,
        token,
        max_age=settings.refresh_token_days * 24 * 3600,
        path=REFRESH_COOKIE_PATH,
        httponly=True,
        secure=settings.refresh_cookie_secure,
        samesite="strict",
    )


def _clear_refresh_cookie(response: Response) -> None:
    response.delete_cookie(
        REFRESH_COOKIE,
        path=REFRESH_COOKIE_PATH,
        httponly=True,
        secure=settings.refresh_cookie_secure,
        samesite="strict",
    )


def _token_response(user_id: uuid.UUID) -> TokenResponse:
    return TokenResponse(
        access_token=service.create_access_token(user_id),
        expires_in=settings.access_token_minutes * 60,
    )


@router.post("/magic-link", status_code=status.HTTP_202_ACCEPTED)
async def request_magic_link(
    body: MagicLinkRequest, session: Session, background: BackgroundTasks
) -> dict[str, str]:
    # Same answer, and about the same time, whether or not the email has an account or the send works:
    # the email goes out after the response.
    url = await service.create_magic_link(session, body.email)
    background.add_task(service.deliver_magic_link, body.email, url)
    return {"detail": "If the address is valid, a sign-in link is on its way."}


@router.post("/verify")
async def verify_magic_link(body: VerifyRequest, response: Response, session: Session) -> TokenResponse:
    try:
        user = await service.consume_magic_link(session, body.token)
    except service.InvalidTokenError:
        raise _invalid("Sign-in link is invalid or expired") from None
    refresh_token = await service.issue_refresh_token(session, user.id)
    await session.commit()
    _set_refresh_cookie(response, refresh_token)
    return _token_response(user.id)


@router.post("/refresh", response_model=TokenResponse)
async def refresh(
    response: Response, session: Session, refresh_token: RefreshCookie = None
) -> TokenResponse | JSONResponse:
    try:
        if not refresh_token:
            raise service.InvalidTokenError
        user_id, new_token = await service.rotate_refresh_token(session, refresh_token)
    except service.InvalidTokenError:
        failed = JSONResponse(
            status_code=status.HTTP_401_UNAUTHORIZED,
            content={"detail": "Refresh token is invalid or expired"},
        )
        _clear_refresh_cookie(failed)
        return failed
    await session.commit()
    _set_refresh_cookie(response, new_token)
    return _token_response(user_id)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(session: Session, refresh_token: RefreshCookie = None) -> Response:
    if refresh_token:
        await service.revoke_refresh_token(session, refresh_token)
    response = Response(status_code=status.HTTP_204_NO_CONTENT)
    _clear_refresh_cookie(response)
    return response


@router.get("/me")
async def me(user: CurrentUser) -> UserOut:
    return UserOut(id=user.id, email=user.email)
