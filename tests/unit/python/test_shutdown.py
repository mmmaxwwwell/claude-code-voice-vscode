"""Unit tests for sidecar.shutdown — shutdown hook registry."""

import asyncio
import logging
import time

import pytest

from sidecar.shutdown import ShutdownRegistry


class TestRegistration:
    def test_register_single_hook(self):
        registry = ShutdownRegistry()
        registry.register_hook("audio", lambda: None)
        assert len(registry.hooks) == 1
        assert registry.hooks[0][0] == "audio"

    def test_register_multiple_hooks_preserves_order(self):
        registry = ShutdownRegistry()
        registry.register_hook("audio", lambda: None)
        registry.register_hook("pipeline", lambda: None)
        registry.register_hook("socket", lambda: None)
        names = [name for name, _ in registry.hooks]
        assert names == ["audio", "pipeline", "socket"]

    def test_register_returns_none(self):
        registry = ShutdownRegistry()
        result = registry.register_hook("x", lambda: None)
        assert result is None


class TestShutdownExecution:
    def test_hooks_execute_in_reverse_order(self):
        registry = ShutdownRegistry()
        order = []
        registry.register_hook("first", lambda: order.append("first"))
        registry.register_hook("second", lambda: order.append("second"))
        registry.register_hook("third", lambda: order.append("third"))
        asyncio.run(registry.shutdown())
        assert order == ["third", "second", "first"]

    def test_all_hooks_execute_even_if_one_raises(self):
        registry = ShutdownRegistry()
        order = []
        registry.register_hook("ok1", lambda: order.append("ok1"))
        registry.register_hook("bad", lambda: (_ for _ in ()).throw(RuntimeError("fail")))
        registry.register_hook("ok2", lambda: order.append("ok2"))
        asyncio.run(registry.shutdown())
        # ok2 runs first (reverse), then bad raises, then ok1 still runs
        assert "ok2" in order
        assert "ok1" in order

    def test_shutdown_with_no_hooks(self):
        registry = ShutdownRegistry()
        # Should not raise
        asyncio.run(registry.shutdown())

    def test_async_hooks_supported(self):
        registry = ShutdownRegistry()
        order = []

        async def async_cleanup():
            order.append("async")

        registry.register_hook("async_hook", async_cleanup)
        asyncio.run(registry.shutdown())
        assert order == ["async"]


class TestTimeouts:
    def test_per_hook_timeout_enforced(self):
        registry = ShutdownRegistry(per_hook_timeout=0.1, overall_timeout=5.0)
        order = []
        registry.register_hook("slow", lambda: time.sleep(1.0))
        registry.register_hook("fast", lambda: order.append("fast"))
        # fast is registered second so executes first (reverse order)
        asyncio.run(registry.shutdown())
        # fast should have run, slow should have timed out
        assert "fast" in order

    def test_overall_timeout_enforced(self):
        registry = ShutdownRegistry(per_hook_timeout=5.0, overall_timeout=0.2)

        def slow():
            time.sleep(0.15)

        # Register enough slow hooks to exceed overall timeout
        for i in range(5):
            registry.register_hook(f"slow_{i}", slow)

        start = time.monotonic()
        asyncio.run(registry.shutdown())
        elapsed = time.monotonic() - start
        # Should finish within overall_timeout + some margin, not 5*0.15=0.75s
        assert elapsed < 0.5

    def test_default_timeouts(self):
        registry = ShutdownRegistry()
        assert registry.per_hook_timeout == 5.0
        assert registry.overall_timeout == 5.0


class TestLogging:
    def test_logs_each_hook_execution(self, caplog):
        registry = ShutdownRegistry()
        registry.register_hook("audio", lambda: None)
        registry.register_hook("socket", lambda: None)
        with caplog.at_level(logging.INFO):
            asyncio.run(registry.shutdown())
        messages = caplog.text
        assert "audio" in messages
        assert "socket" in messages

    def test_logs_hook_failure(self, caplog):
        registry = ShutdownRegistry()

        def bad():
            raise RuntimeError("cleanup failed")

        registry.register_hook("bad_hook", bad)
        with caplog.at_level(logging.WARNING):
            asyncio.run(registry.shutdown())
        assert "bad_hook" in caplog.text
        assert "cleanup failed" in caplog.text or "RuntimeError" in caplog.text

    def test_logs_hook_timeout(self, caplog):
        registry = ShutdownRegistry(per_hook_timeout=0.1)
        registry.register_hook("stuck", lambda: time.sleep(2.0))
        with caplog.at_level(logging.WARNING):
            asyncio.run(registry.shutdown())
        assert "stuck" in caplog.text
        assert "timeout" in caplog.text.lower() or "timed out" in caplog.text.lower()
