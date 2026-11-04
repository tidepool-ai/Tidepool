"""Tidepool API entry point."""

import asyncio
from typing import Annotated

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import get_session

HEALTH_DB_TIMEOUT_SECONDS = 2


def create_app() -> FastAPI:
    app = FastAPI(title="Tidepool API", version="0.1.0")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/health", tags=["system"])
    async def health(session: Annotated[AsyncSession, Depends(get_session)]) -> JSONResponse:
        try:
            async with asyncio.timeout(HEALTH_DB_TIMEOUT_SECONDS):
                await session.execute(text("SELECT 1"))
        except (SQLAlchemyError, OSError, TimeoutError):
            return JSONResponse(status_code=503, content={"status": "degraded", "database": "unavailable"})
        return JSONResponse(content={"status": "ok", "database": "ok"})

    return app


app = create_app()
