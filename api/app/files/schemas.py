import uuid

from pydantic import BaseModel, Field


class PresignIn(BaseModel):
    page_id: uuid.UUID
    filename: str = Field(min_length=1, max_length=255)
    content_type: str = Field(min_length=1, max_length=100)
    size: int = Field(gt=0, description="File size in bytes")


class PresignOut(BaseModel):
    """Upload with a multipart POST to `upload_url`: every entry of `fields`, then the file as `file`."""

    upload_url: str
    fields: dict[str, str]
    # Where the image is shown from once uploaded (same origin as the API).
    url: str
    key: str
    max_bytes: int
    expires_in: int
