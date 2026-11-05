"""S3-compatible object storage (AWS S3, MinIO): presigned uploads and downloads.

Uploads go straight from the browser to the bucket. The upload policy is signed, so the storage
service itself rejects files that are too big or of another type, whatever the client claims.
"""

import re
import uuid
from functools import lru_cache
from typing import Any

import boto3
from botocore.config import Config

from app.config import Settings

# SVG is left out on purpose: it can carry scripts.
IMAGE_TYPES: dict[str, str] = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/avif": ".avif",
}
UPLOAD_EXPIRES_SECONDS = 10 * 60
DOWNLOAD_EXPIRES_SECONDS = 60 * 60

_EXTENSIONS = "|".join(ext.removeprefix(".") for ext in IMAGE_TYPES.values())
KEY_PATTERN = re.compile(rf"pages/[0-9a-f-]{{36}}/[0-9a-f]{{32}}\.(?:{_EXTENSIONS})")


def is_configured(settings: Settings) -> bool:
    return bool(settings.s3_bucket)


def new_key(page_id: uuid.UUID, content_type: str) -> str:
    return f"pages/{page_id}/{uuid.uuid4().hex}{IMAGE_TYPES[content_type]}"


@lru_cache(maxsize=4)
def _client(endpoint_url: str, region: str, access_key_id: str, secret_access_key: str) -> Any:
    return boto3.client(
        "s3",
        endpoint_url=endpoint_url or None,
        region_name=region,
        # Empty keys fall back to boto3's usual sources (e.g. an IAM role).
        aws_access_key_id=access_key_id or None,
        aws_secret_access_key=secret_access_key or None,
        # MinIO and other self-hosted endpoints need path-style URLs.
        config=Config(
            signature_version="s3v4", s3={"addressing_style": "path" if endpoint_url else "virtual"}
        ),
    )


def client(settings: Settings) -> Any:
    return _client(
        settings.s3_endpoint_url, settings.s3_region, settings.s3_access_key_id, settings.s3_secret_access_key
    )


def presign_upload(settings: Settings, key: str, content_type: str) -> dict[str, Any]:
    """A presigned POST that only accepts this key, this content type and 1..max_upload_bytes bytes."""
    return client(settings).generate_presigned_post(
        settings.s3_bucket,
        key,
        Fields={"Content-Type": content_type},
        Conditions=[
            {"Content-Type": content_type},
            ["content-length-range", 1, settings.max_upload_bytes],
        ],
        ExpiresIn=UPLOAD_EXPIRES_SECONDS,
    )


def presign_download(settings: Settings, key: str) -> str:
    return client(settings).generate_presigned_url(
        "get_object", Params={"Bucket": settings.s3_bucket, "Key": key}, ExpiresIn=DOWNLOAD_EXPIRES_SECONDS
    )
