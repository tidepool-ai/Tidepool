"""Who can do what on a page (FR-29, FR-30).

Levels, lowest first: view < comment < edit < full. A person's level on a page is the highest of:

- **Their own access**: the nearest grant for them on the page or an ancestor. A grant further down
  overrides one higher up, so it can raise or lower what they inherit.
- **General access**: the nearest page (itself or an ancestor) with general access set; the top level
  defaults to "workspace" with full access.
  - "invited": nobody but the people with their own access.
  - "workspace": workspace members (not guests) get the page's general level.
  - "public": as "workspace", and anyone else signed in who has the link can view.

Workspace owners and admins always have full access, so a page can't be locked away from everyone.
"""

import html
import logging
import uuid
from collections.abc import Iterable
from dataclasses import dataclass
from enum import IntEnum

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.auth.service import normalize_email
from app.config import settings
from app.email.sender import Email, EmailError, email_configured, send_email
from app.pages.models import Page
from app.permissions.models import PagePermission
from app.workspaces.models import Member, Role

logger = logging.getLogger(__name__)

GENERAL_ACCESS = ("invited", "workspace", "public")
DEFAULT_GENERAL = ("workspace", "full")


class Level(IntEnum):
    NONE = 0
    VIEW = 1
    COMMENT = 2
    EDIT = 3
    FULL = 4

    @property
    def label(self) -> str:
        return self.name.lower()

    @classmethod
    def parse(cls, value: str | None) -> "Level":
        return cls[value.upper()] if value else cls.NONE


def chain(page: Page) -> list[uuid.UUID]:
    """The page and its ancestors, nearest first (from its ltree path of hex ids)."""
    return [uuid.UUID(hex=label) for label in reversed(page.path.split("."))]


async def levels(session: AsyncSession, pages: Iterable[Page], user_id: uuid.UUID) -> dict[uuid.UUID, Level]:
    """The caller's level on each page, in a few queries whatever the number of pages."""
    pages = list(pages)
    if not pages:
        return {}
    chains = {page.id: chain(page) for page in pages}
    ids = {page_id for ids in chains.values() for page_id in ids}
    roles = dict(
        (
            await session.execute(
                select(Member.workspace_id, Member.role).where(
                    Member.user_id == user_id, Member.workspace_id.in_({p.workspace_id for p in pages})
                )
            )
        ).all()
    )
    grants = dict(
        (
            await session.execute(
                select(PagePermission.page_id, PagePermission.level).where(
                    PagePermission.user_id == user_id, PagePermission.page_id.in_(ids)
                )
            )
        ).all()
    )
    generals = {
        page_id: (access, level)
        for page_id, access, level in (
            await session.execute(
                select(Page.id, Page.general_access, Page.general_level).where(
                    Page.id.in_(ids), Page.general_access.is_not(None)
                )
            )
        ).all()
    }
    result: dict[uuid.UUID, Level] = {}
    for page in pages:
        role = roles.get(page.workspace_id)
        if role in (Role.OWNER, Role.ADMIN):
            result[page.id] = Level.FULL
            continue
        path = chains[page.id]
        own = next((Level.parse(grants[i]) for i in path if i in grants), Level.NONE)
        access, general_level = next((generals[i] for i in path if i in generals), DEFAULT_GENERAL)
        general = Level.NONE
        if access in ("workspace", "public") and role == Role.MEMBER:
            general = Level.parse(general_level or "full")
        if access == "public":
            general = max(general, Level.VIEW)
        result[page.id] = max(own, general)
    return result


async def level(session: AsyncSession, page: Page, user_id: uuid.UUID) -> Level:
    return (await levels(session, [page], user_id))[page.id]


async def visible(session: AsyncSession, pages: Iterable[Page], user_id: uuid.UUID) -> list[Page]:
    """The pages the caller can open, each with `access` set, in the same order."""
    pages = list(pages)
    found = await levels(session, pages, user_id)
    shown = []
    for page in pages:
        if found[page.id] > Level.NONE:
            page.access = found[page.id].label
            shown.append(page)
    return shown


# Sharing ----------------------------------------------------------------------------------------


class LockoutError(Exception):
    """The change would take the caller's own full access away."""


@dataclass
class Person:
    user_id: uuid.UUID
    email: str
    level: str
    # Where the level comes from when it isn't set on this page itself.
    inherited_from: uuid.UUID | None
    role: str | None


@dataclass
class General:
    access: str
    level: str
    inherited_from: uuid.UUID | None


@dataclass
class Sharing:
    general: General
    people: list[Person]
    titles: dict[uuid.UUID, str]


async def describe(session: AsyncSession, page: Page) -> Sharing:
    """Who has access to the page and why: people's own access and its general access."""
    path = chain(page)
    rows = (
        await session.execute(
            select(
                PagePermission.page_id, PagePermission.user_id, PagePermission.level, User.email, Member.role
            )
            .join(User, User.id == PagePermission.user_id)
            .outerjoin(Member, (Member.user_id == User.id) & (Member.workspace_id == page.workspace_id))
            .where(PagePermission.page_id.in_(path))
            .order_by(PagePermission.created_at, User.email)
        )
    ).all()
    depth = {page_id: i for i, page_id in enumerate(path)}
    nearest: dict[uuid.UUID, Person] = {}
    for page_id, user_id, level_name, email, role in sorted(rows, key=lambda r: depth[r.page_id]):
        if user_id not in nearest:
            inherited = None if page_id == page.id else page_id
            nearest[user_id] = Person(user_id, email, level_name, inherited, role)
    people = sorted(nearest.values(), key=lambda p: (p.inherited_from is None, p.email))
    titles = dict((await session.execute(select(Page.id, Page.title).where(Page.id.in_(path)))).all())
    configured = {
        page_id: (access, level_name)
        for page_id, access, level_name in (
            await session.execute(
                select(Page.id, Page.general_access, Page.general_level).where(
                    Page.id.in_(path), Page.general_access.is_not(None)
                )
            )
        ).all()
    }
    for page_id in path:
        if page_id in configured:
            access, level_name = configured[page_id]
            general = General(access, level_name or "full", None if page_id == page.id else page_id)
            break
    else:
        general = General(*DEFAULT_GENERAL, inherited_from=None)
    return Sharing(general, people, titles)


async def find_or_invite(session: AsyncSession, email: str, workspace_id: uuid.UUID) -> User:
    """The user with this email (created if new to Tidepool); a workspace guest unless already a member."""
    address = normalize_email(email)
    user = await session.scalar(select(User).where(User.email == address))
    if user is None:
        user = User(email=address)
        session.add(user)
        await session.flush()
    if await session.get(Member, (workspace_id, user.id)) is None:
        session.add(Member(workspace_id=workspace_id, user_id=user.id, role=Role.GUEST))
        await session.flush()
    return user


async def grant(
    session: AsyncSession, page: Page, user_id: uuid.UUID, level_name: str, invited_by: uuid.UUID | None
) -> None:
    await session.execute(
        insert(PagePermission)
        .values(page_id=page.id, user_id=user_id, level=level_name, invited_by=invited_by)
        .on_conflict_do_update(
            index_elements=[PagePermission.page_id, PagePermission.user_id], set_={"level": level_name}
        )
    )


async def revoke(session: AsyncSession, page: Page, user_id: uuid.UUID) -> bool:
    result = await session.execute(
        delete(PagePermission).where(PagePermission.page_id == page.id, PagePermission.user_id == user_id)
    )
    return bool(result.rowcount)  # type: ignore[attr-defined]


async def set_general(session: AsyncSession, page: Page, access: str | None, level_name: str | None) -> None:
    page.general_access = access
    page.general_level = level_name if access in ("workspace", "public") else None
    await session.flush()


async def keep_full_access(
    session: AsyncSession, page: Page, user_id: uuid.UUID, *, grant_if_lost: bool
) -> None:
    """After a change, make sure the person who made it still has full access to the page.

    Narrowing general access gives them their own full access (as Notion does); changing or removing
    their own access in a way that loses it is refused.
    """
    if await level(session, page, user_id) >= Level.FULL:
        return
    if not grant_if_lost:
        raise LockoutError("You can't take away your own full access")
    await grant(session, page, user_id, "full", user_id)


def invite_email(to: str, inviter: str, title: str, url: str) -> Email:
    name = title or "Untitled"
    text = f"{inviter} shared “{name}” with you on Tidepool:\n\n{url}\n"
    link = html.escape(url, quote=True)
    body = (
        f"<p>{html.escape(inviter)} shared <strong>{html.escape(name)}</strong> with you on Tidepool.</p>"
        f'<p><a href="{link}">Open the page</a></p>'
    )
    return Email(to=to, subject=f"{inviter} shared “{name}” with you", text=text, html=body)


async def deliver_invite(to: str, inviter: str, title: str, page_id: uuid.UUID) -> None:
    """Tell the person about the page (runs after the response; failures are only logged)."""
    url = f"{settings.app_url.rstrip('/')}/p/{page_id}"
    if email_configured():
        try:
            await send_email(invite_email(to, inviter, title, url))
        except EmailError as exc:
            logger.error("Share email to %s failed: %s", to, exc)
    elif settings.log_magic_links:
        logger.info("Shared page for %s: %s", to, url)
