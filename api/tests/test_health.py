from collections.abc import AsyncIterator

import pytest
from httpx2 import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.pool import NullPool

from app.db import get_session
from app.main import app

pytestmark = pytest.mark.anyio


async def test_health_reports_database_ok(client: AsyncClient) -> None:
    response = await client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "database": "ok"}


async def test_health_reports_database_unavailable() -> None:
    # Port 1 on localhost refuses connections, so the DB check fails fast.
    engine = create_async_engine("postgresql+asyncpg://nobody:nobody@127.0.0.1:1/none", poolclass=NullPool)

    async def unreachable_session() -> AsyncIterator[AsyncSession]:
        async with AsyncSession(engine) as session:
            yield session

    app.dependency_overrides[get_session] = unreachable_session
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
            response = await http.get("/health")
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()

    assert response.status_code == 503
    assert response.json() == {"status": "degraded", "database": "unavailable"}
