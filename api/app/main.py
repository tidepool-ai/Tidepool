"""Tidepool API entry point."""

import asyncio
import logging
from typing import Annotated

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.router import router as auth_router
from app.config import settings
from app.db import get_session
from app.pages.router import router as pages_router
from app.workspaces.router import router as workspaces_router

HEALTH_DB_TIMEOUT_SECONDS = 2


def _configure_dev_logging() -> None:
    """Show app INFO logs (such as magic links) on the console in development."""
    app_logger = logging.getLogger("app")
    if settings.app_env == "development" and not app_logger.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("%(levelname)s [%(name)s] %(message)s"))
        app_logger.addHandler(handler)
        app_logger.setLevel(logging.INFO)


def create_app() -> FastAPI:
    _configure_dev_logging()
    app = FastAPI(title="Tidepool API", version="0.1.0")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(auth_router)
    app.include_router(workspaces_router)
    app.include_router(pages_router)

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
