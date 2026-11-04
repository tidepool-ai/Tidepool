import pytest
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from tests.conftest import alembic_config

pytestmark = pytest.mark.anyio


async def test_migrations_are_at_head(db_session: AsyncSession, database_url: str) -> None:
    head = ScriptDirectory.from_config(alembic_config(database_url)).get_current_head()
    version = await db_session.scalar(text("SELECT version_num FROM alembic_version"))
    assert version == head


# Runs twice: whichever run goes second proves the first run's committed writes were rolled back.
@pytest.mark.parametrize("run", [1, 2])
async def test_each_test_gets_a_clean_database(db_session: AsyncSession, run: int) -> None:
    assert await db_session.scalar(text("SELECT to_regclass('isolation_probe')")) is None

    await db_session.execute(text("CREATE TABLE isolation_probe (id int PRIMARY KEY)"))
    await db_session.execute(text("INSERT INTO isolation_probe VALUES (:id)"), {"id": run})
    await db_session.commit()

    assert await db_session.scalar(text("SELECT count(*) FROM isolation_probe")) == 1
