"""Files: presigned image uploads to object storage, and links that show them (T13, FR-10)."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import RedirectResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import CurrentUser
from app.config import settings
from app.db import get_session
from app.files import storage
from app.files.schemas import PresignIn, PresignOut
from app.pages import service as pages

router = APIRouter(tags=["files"])

Session = Annotated[AsyncSession, Depends(get_session)]

NOT_SET_UP = HTTPException(
    status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Image uploads aren't set up on this server"
)


@router.post("/api/files/presign")
async def presign(body: PresignIn, user: CurrentUser, session: Session) -> PresignOut:
    """Check the image and the caller's access to the page, then hand out a short-lived upload form."""
    try:
        page = await pages.get_page(session, body.page_id, user.id)
    except pages.PageNotFoundError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Page not found") from None
    if page.archived_at is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Page is in the trash")
    if body.content_type not in storage.IMAGE_TYPES:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Only PNG, JPEG, GIF, WebP and AVIF images can be uploaded",
        )
    limit = settings.max_upload_bytes
    if body.size > limit:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail=f"Images can be up to {limit // (1024 * 1024)} MB",
        )
    if not storage.is_configured(settings):
        raise NOT_SET_UP
    key = storage.new_key(page.id, body.content_type)
    post = storage.presign_upload(settings, key, body.content_type)
    return PresignOut(
        upload_url=post["url"],
        fields=post["fields"],
        url=f"/api/files/{key}",
        key=key,
        max_bytes=limit,
        expires_in=storage.UPLOAD_EXPIRES_SECONDS,
    )


@router.get("/api/files/{key:path}", response_class=RedirectResponse, status_code=307)
async def show(key: str) -> RedirectResponse:
    """Redirect to a short-lived download link.

    No sign-in check: <img> tags can't send the access token. Keys are random (122 bits), so a link
    works like an unlisted share link: only people who have it can open the image.
    """
    if not storage.KEY_PATTERN.fullmatch(key):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    if not storage.is_configured(settings):
        raise NOT_SET_UP
    # Let the browser reuse the redirect while the signed link is still valid.
    max_age = storage.DOWNLOAD_EXPIRES_SECONDS - 5 * 60
    return RedirectResponse(
        storage.presign_download(settings, key),
        status_code=status.HTTP_307_TEMPORARY_REDIRECT,
        headers={"Cache-Control": f"private, max-age={max_age}"},
    )
