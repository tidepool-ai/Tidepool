import os

# Settings are read at import time, so test values must be set before `app` is imported.
os.environ.setdefault("JWT_SECRET", "test-secret-not-for-production-0123456789")
os.environ.setdefault("APP_ENV", "development")
