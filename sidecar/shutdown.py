"""Shutdown hook registry for graceful sidecar teardown."""

from __future__ import annotations

import asyncio
import inspect
import logging
import time
from typing import Callable

logger = logging.getLogger(__name__)


class ShutdownRegistry:
    """Registry for shutdown cleanup hooks.

    Hooks are executed in reverse registration order during shutdown,
    with per-hook and overall timeout enforcement.
    """

    def __init__(
        self,
        per_hook_timeout: float = 5.0,
        overall_timeout: float = 5.0,
    ) -> None:
        self.hooks: list[tuple[str, Callable]] = []
        self.per_hook_timeout = per_hook_timeout
        self.overall_timeout = overall_timeout

    def register_hook(self, name: str, cleanup_fn: Callable) -> None:
        """Register a cleanup function to run during shutdown."""
        self.hooks.append((name, cleanup_fn))
        logger.info("Registered shutdown hook: %s", name)

    async def shutdown(self) -> None:
        """Execute all hooks in reverse registration order."""
        if not self.hooks:
            logger.info("No shutdown hooks registered")
            return

        logger.info("Starting shutdown with %d hooks", len(self.hooks))
        deadline = time.monotonic() + self.overall_timeout

        for name, fn in reversed(self.hooks):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                logger.warning(
                    "Overall shutdown timeout reached, skipping remaining hooks"
                )
                break

            timeout = min(self.per_hook_timeout, remaining)
            logger.info("Running shutdown hook: %s", name)

            try:
                if inspect.iscoroutinefunction(fn):
                    await asyncio.wait_for(fn(), timeout=timeout)
                else:
                    await asyncio.wait_for(
                        asyncio.get_event_loop().run_in_executor(None, fn),
                        timeout=timeout,
                    )
                logger.info("Shutdown hook completed: %s", name)
            except asyncio.TimeoutError:
                logger.warning(
                    "Shutdown hook timed out: %s (%.1fs)", name, timeout
                )
            except Exception:
                logger.warning(
                    "Shutdown hook failed: %s", name, exc_info=True
                )

        logger.info("Shutdown complete")
