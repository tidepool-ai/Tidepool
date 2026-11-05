"""Local image storage for development: an S3 emulator (moto) on http://127.0.0.1:9000.

    python -m scripts.dev_storage

Keeps files in memory only: they are gone when it stops. For a real setup, see docs/DEPLOY.md.
Then set in api/.env:

    S3_BUCKET=tidepool
    S3_ENDPOINT_URL=http://127.0.0.1:9000
    S3_ACCESS_KEY_ID=dev
    S3_SECRET_ACCESS_KEY=dev
"""

import argparse
import time

import boto3
from moto.server import ThreadedMotoServer


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=9000)
    parser.add_argument("--bucket", default="tidepool")
    args = parser.parse_args()

    server = ThreadedMotoServer(ip_address="127.0.0.1", port=args.port, verbose=False)
    server.start()
    endpoint = f"http://127.0.0.1:{args.port}"
    keys = {"aws_access_key_id": "dev", "aws_secret_access_key": "dev"}
    s3 = boto3.client("s3", endpoint_url=endpoint, region_name="us-east-1", **keys)
    s3.create_bucket(Bucket=args.bucket)
    print(f"Dev storage on {endpoint}, bucket {args.bucket!r} (in memory). Ctrl+C to stop.", flush=True)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        server.stop()


if __name__ == "__main__":
    main()
