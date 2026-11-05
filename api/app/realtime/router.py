"""Live page documents over WebSocket (T14): `WS /ws/pages/{id}`, Yjs sync plus awareness."""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import CurrentUser
from app.config import settings
from app.db import get_session
from app.pages import service as pages
from app.realtime.access import Access, page_access
from app.realtime.rooms import Connection, RoomManager, is_change
from app.realtime.tickets import TICKET_SECONDS, InvalidTicketError, create_ticket, read_ticket

router = APIRouter(tags=["realtime"])

# Close codes the web app can act on (4000-4999 are for applications).
CLOSE_UNAUTHORIZED = 4401  # ticket missing, expired or for another page: get a new one
CLOSE_FORBIDDEN = 4403  # no access (any more), or read-only and tried to edit
CLOSE_TOO_BIG = 1009


class Ticket(BaseModel):
    ticket: str
    expires_in: int
    # Path of the page's socket; add ?ticket=<ticket>.
    url: str


def get_rooms(websocket: WebSocket) -> RoomManager:
    return websocket.app.state.rooms


Rooms = Annotated[RoomManager, Depends(get_rooms)]


@router.post("/api/pages/{page_id}/realtime-ticket")
async def realtime_ticket(
    page_id: uuid.UUID, user: CurrentUser, session: Annotated[AsyncSession, Depends(get_session)]
) -> Ticket:
    """A one-minute ticket to open this page's socket (browsers can't send the access token there)."""
    try:
        await pages.get_page(session, page_id, user.id)
    except pages.PageNotFoundError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Page not found") from None
    ticket = create_ticket(user.id, page_id)
    return Ticket(ticket=ticket, expires_in=TICKET_SECONDS, url=f"/ws/pages/{page_id}")


async def check_access(rooms: RoomManager, page_id: uuid.UUID, user_id: uuid.UUID) -> Access:
    async with rooms.store.sessions() as session:
        return await page_access(session, page_id, user_id)


@router.websocket("/ws/pages/{page_id}")
async def page_socket(websocket: WebSocket, page_id: uuid.UUID, rooms: Rooms, ticket: str = "") -> None:
    await websocket.accept()
    try:
        user_id = read_ticket(ticket, page_id)
    except InvalidTicketError:
        await websocket.close(CLOSE_UNAUTHORIZED, "Sign in again")
        return
    if await check_access(rooms, page_id, user_id) is Access.NONE:
        await websocket.close(CLOSE_FORBIDDEN, "No access to this page")
        return

    connection = Connection(websocket.send_bytes, websocket.close)
    room = await rooms.join(page_id, connection)
    try:
        while True:
            event = await websocket.receive()
            if event["type"] == "websocket.disconnect":
                break
            message = event.get("bytes")
            if not message:
                continue  # text frames aren't part of the protocol
            if len(message) > settings.max_realtime_message_bytes:
                await connection.close(CLOSE_TOO_BIG, "Message too big")
                break
            if is_change(message):
                # Checked on every edit: access can be taken away while the page is open.
                access = await check_access(rooms, page_id, user_id)
                if access is not Access.WRITE:
                    reason = "No access to this page" if access is Access.NONE else "This page is read-only"
                    await connection.close(CLOSE_FORBIDDEN, reason)
                    break
            await rooms.handle(room, connection, message)
    except WebSocketDisconnect:
        pass
    finally:
        await rooms.leave(room, connection)
