"""T13: presigned image uploads. A local S3 emulator (moto) stands in for S3/MinIO."""

import base64
import dataclasses
import json
import time
import uuid
from collections.abc import Iterator

import boto3
import httpx2
import pytest
from httpx2 import AsyncClient
from moto.server import ThreadedMotoServer

from app.config import settings
from app.files import router as files_router
from tests.test_page_content import User, user

pytestmark = pytest.mark.anyio

Logs = pytest.LogCaptureFixture
BUCKET = "tidepool-test"
MB = 1024 * 1024
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


@pytest.fixture(scope="module")
def s3_endpoint() -> Iterator[str]:
    server = ThreadedMotoServer(ip_address="127.0.0.1", port=0, verbose=False)
    server.start()
    host, port = server.get_host_and_port()
    endpoint = f"http://{host}:{port}"
    keys = {"aws_access_key_id": "test", "aws_secret_access_key": "test"}
    boto3.client("s3", endpoint_url=endpoint, region_name="us-east-1", **keys).create_bucket(Bucket=BUCKET)
    yield endpoint
    server.stop()


@pytest.fixture
def storage_on(monkeypatch: pytest.MonkeyPatch, s3_endpoint: str) -> None:
    configured = dataclasses.replace(
        settings,
        s3_bucket=BUCKET,
        s3_endpoint_url=s3_endpoint,
        s3_access_key_id="test",
        s3_secret_access_key="test",
    )
    monkeypatch.setattr(files_router, "settings", configured)


@pytest.fixture
async def ada(client: AsyncClient, caplog: Logs) -> User:
    return await user(client, caplog, "ada@example.com")


async def presign(who: User, page_id: str, **overrides: object):
    body = {"page_id": page_id, "filename": "photo.png", "content_type": "image/png", "size": len(PNG)}
    return await who.client.post("/api/files/presign", json={**body, **overrides}, headers=who.headers)


def policy_of(fields: dict[str, str]) -> dict:
    return json.loads(base64.b64decode(fields["policy"]))


@pytest.mark.usefixtures("storage_on")
async def test_presign_signs_a_policy_limited_to_this_key_type_and_25_mb(ada: User) -> None:
    page_id = await ada.new_page()
    response = await presign(ada, page_id)
    assert response.status_code == 200, response.text
    out = response.json()
    assert out["key"].startswith(f"pages/{page_id}/") and out["key"].endswith(".png")
    assert out["url"] == f"/api/files/{out['key']}"
    assert out["max_bytes"] == 25 * MB
    assert out["fields"]["Content-Type"] == "image/png"

    policy = policy_of(out["fields"])
    conditions = policy["conditions"]
    assert {"bucket": BUCKET} in conditions
    assert {"key": out["key"]} in conditions
    assert {"Content-Type": "image/png"} in conditions
    assert ["content-length-range", 1, 25 * MB] in conditions
    expires = time.mktime(time.strptime(policy["expiration"], "%Y-%m-%dT%H:%M:%SZ")) - time.timezone
    assert 0 < expires - time.time() <= 10 * 60 + 5


@pytest.mark.usefixtures("storage_on")
async def test_uploaded_image_is_shown_through_a_redirect(ada: User) -> None:
    out = (await presign(ada, await ada.new_page())).json()
    async with httpx2.AsyncClient() as storage:
        upload = await storage.post(
            out["upload_url"], data=out["fields"], files={"file": ("photo.png", PNG, "image/png")}
        )
        assert upload.status_code in (200, 201, 204), upload.text

        shown = await ada.client.get(out["url"])  # no sign-in needed, like <img src>
        assert shown.status_code == 307
        assert "max-age=" in shown.headers["cache-control"]
        image = await storage.get(shown.headers["location"])
    assert image.status_code == 200
    assert image.content == PNG
    assert image.headers["content-type"] == "image/png"


@pytest.mark.usefixtures("storage_on")
@pytest.mark.parametrize("content_type", ["image/svg+xml", "text/html", "application/pdf", "image/tiff"])
async def test_only_image_types_are_accepted(ada: User, content_type: str) -> None:
    response = await presign(ada, await ada.new_page(), content_type=content_type, filename="file")
    assert response.status_code == 415
    assert "PNG, JPEG, GIF, WebP and AVIF" in response.json()["detail"]


@pytest.mark.usefixtures("storage_on")
@pytest.mark.parametrize("content_type", ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"])
async def test_each_image_type_gets_its_own_extension(ada: User, content_type: str) -> None:
    response = await presign(ada, await ada.new_page(), content_type=content_type)
    assert response.status_code == 200
    assert response.json()["key"].rsplit(".", 1)[1] in {"png", "jpg", "gif", "webp", "avif"}


@pytest.mark.usefixtures("storage_on")
async def test_size_limit_is_25_mb(ada: User) -> None:
    page_id = await ada.new_page()
    assert (await presign(ada, page_id, size=25 * MB)).status_code == 200
    too_big = await presign(ada, page_id, size=25 * MB + 1)
    assert too_big.status_code == 413
    assert too_big.json()["detail"] == "Images can be up to 25 MB"
    assert (await presign(ada, page_id, size=0)).status_code == 422


@pytest.mark.usefixtures("storage_on")
async def test_only_people_with_access_can_upload(ada: User, client: AsyncClient, caplog: Logs) -> None:
    page_id = await ada.new_page()
    bob = await user(client, caplog, "bob@example.com")
    assert (await presign(bob, page_id)).status_code == 404
    assert (await presign(ada, str(uuid.uuid4()))).status_code == 404
    signed_out = await client.post(
        "/api/files/presign",
        json={"page_id": page_id, "filename": "a.png", "content_type": "image/png", "size": 10},
    )
    assert signed_out.status_code == 401


@pytest.mark.usefixtures("storage_on")
async def test_pages_in_the_trash_take_no_uploads(ada: User) -> None:
    page_id = await ada.new_page()
    assert (await ada.client.delete(f"/api/pages/{page_id}", headers=ada.headers)).status_code == 200
    assert (await presign(ada, page_id)).status_code == 409


async def test_without_a_bucket_uploads_are_switched_off(ada: User, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(files_router, "settings", dataclasses.replace(settings, s3_bucket=""))
    response = await presign(ada, await ada.new_page())
    assert response.status_code == 503
    assert response.json()["detail"] == "Image uploads aren't set up on this server"


@pytest.mark.usefixtures("storage_on")
@pytest.mark.parametrize(
    "key",
    [
        "../secret.png",
        "pages/../../etc/passwd",
        f"pages/{uuid.uuid4()}/{uuid.uuid4().hex}.svg",
        f"other/{uuid.uuid4()}/{uuid.uuid4().hex}.png",
        f"pages/{uuid.uuid4()}/short.png",
    ],
)
async def test_only_upload_keys_can_be_shown(client: AsyncClient, key: str) -> None:
    assert (await client.get(f"/api/files/{key}")).status_code == 404


def test_upload_limit_default() -> None:
    assert settings.max_upload_bytes == 25 * MB
