"""Run the pipeline once and exit. In daily-edition mode this publishes an
edition right away, even if one already went out today.

    python -m scripts.refresh_once
"""

import asyncio
import json

from app.config import settings
from app.pipeline import refresh, run_edition_if_due
from app.push import init_push
from app.store import store


async def main() -> None:
    store.init()
    init_push()
    stats = await run_edition_if_due(force=True) if settings.edition_mode else await refresh()
    print(json.dumps(stats, indent=2))
    store.close()


asyncio.run(main())
