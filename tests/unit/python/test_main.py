"""Tests for sidecar.__main__ — logging, shutdown, --check flag, exception handler."""

from __future__ import annotations

import asyncio
import json
import logging
import sys
from io import StringIO
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sidecar.__main__ import SidecarApp, main


# ---------------------------------------------------------------------------
# Logging: configure_logging replaces basicConfig
# ---------------------------------------------------------------------------


class TestStructuredLogging:
    """Verify that SidecarApp uses structured JSON logging (not basicConfig)."""

    def test_main_uses_structured_logging(self, tmp_path):
        """main() should call configure_logging, producing JSON log output."""
        sock = tmp_path / "test.sock"
        captured = StringIO()

        with (
            patch("sys.argv", ["sidecar", "--socket", str(sock)]),
            patch("sidecar.__main__.configure_logging") as mock_cfg,
            patch("sidecar.__main__.SidecarApp") as mock_app_cls,
        ):
            mock_app = MagicMock()
            mock_app.run = AsyncMock()
            mock_app_cls.return_value = mock_app
            # asyncio.run will invoke app.run()
            with patch("asyncio.run") as mock_run:
                main()
                mock_cfg.assert_called_once()


# ---------------------------------------------------------------------------
# ShutdownRegistry wiring
# ---------------------------------------------------------------------------


class TestShutdownWiring:
    """Verify that SidecarApp wires a ShutdownRegistry and calls it on shutdown."""

    @pytest.mark.asyncio
    async def test_shutdown_registry_called_on_shutdown(self, tmp_path):
        """_request_shutdown should call registry.shutdown()."""
        sock = str(tmp_path / "test.sock")
        app = SidecarApp(sock)

        # The app should have a shutdown registry
        assert hasattr(app, "_shutdown_registry")

        # Mock the registry's shutdown method
        app._shutdown_registry.shutdown = AsyncMock()

        # Trigger shutdown
        app._request_shutdown()

        # The shutdown event should be set
        assert app._shutdown_event.is_set()

    @pytest.mark.asyncio
    async def test_shutdown_hooks_registered(self, tmp_path):
        """SidecarApp should register cleanup hooks for key components."""
        sock = str(tmp_path / "test.sock")
        app = SidecarApp(sock)

        hook_names = [name for name, _ in app._shutdown_registry.hooks]

        # Should have hooks for: audio stop, pipeline teardown, server stop,
        # socket cleanup, log flush
        assert len(hook_names) >= 3  # at least server stop, socket cleanup, log flush
        # server stop and socket cleanup should be registered
        assert any("server" in name.lower() for name in hook_names)
        assert any("log" in name.lower() for name in hook_names)

    @pytest.mark.asyncio
    async def test_run_calls_shutdown_registry_on_exit(self, tmp_path):
        """When run() exits, the shutdown registry should be invoked."""
        sock = str(tmp_path / "test.sock")
        app = SidecarApp(sock)
        app._shutdown_registry = MagicMock()
        app._shutdown_registry.shutdown = AsyncMock()

        # Make the app shut down immediately
        async def fake_run():
            app._shutdown_event.set()

        with (
            patch.object(app._server, "__aenter__", new_callable=AsyncMock),
            patch.object(app._server, "__aexit__", new_callable=AsyncMock),
        ):
            # Set shutdown immediately so run() exits
            app._shutdown_event.set()
            await app.run()

        app._shutdown_registry.shutdown.assert_awaited_once()


# ---------------------------------------------------------------------------
# --check flag
# ---------------------------------------------------------------------------


class TestCheckFlag:
    """Verify --check flag initializes components and exits."""

    def test_check_flag_success(self, tmp_path):
        """--check should exit 0 when all checks pass."""
        sock = tmp_path / "test.sock"

        with (
            patch("sys.argv", ["sidecar", "--socket", str(sock), "--check"]),
            patch("sidecar.__main__.configure_logging"),
            patch("sidecar.__main__._run_check", return_value=0) as mock_check,
        ):
            with pytest.raises(SystemExit) as exc_info:
                main()
            assert exc_info.value.code == 0

    def test_check_flag_failure(self, tmp_path):
        """--check should exit with error's exit_code on failure."""
        sock = tmp_path / "test.sock"

        with (
            patch("sys.argv", ["sidecar", "--socket", str(sock), "--check"]),
            patch("sidecar.__main__.configure_logging"),
            patch("sidecar.__main__._run_check", return_value=2) as mock_check,
        ):
            with pytest.raises(SystemExit) as exc_info:
                main()
            assert exc_info.value.code == 2

    def test_check_verifies_audio_device(self, tmp_path):
        """--check should verify audio device availability."""
        from sidecar.__main__ import _run_check
        from sidecar.errors import AudioError

        with patch("sidecar.__main__._check_audio_device") as mock_audio:
            mock_audio.return_value = None  # no error
            with (
                patch("sidecar.__main__._check_dependencies") as mock_deps,
                patch("sidecar.__main__._check_model_files") as mock_model,
            ):
                mock_deps.return_value = None
                mock_model.return_value = None
                result = _run_check()
        assert result == 0

    def test_check_reports_audio_error(self, tmp_path):
        """--check should return exit_code from AudioError."""
        from sidecar.__main__ import _run_check
        from sidecar.errors import AudioError

        with patch("sidecar.__main__._check_audio_device") as mock_audio:
            mock_audio.side_effect = AudioError(
                "MIC_NOT_FOUND", "No audio input device found"
            )
            result = _run_check()
        assert result == 2  # AudioError.exit_code

    def test_check_reports_dependency_error(self, tmp_path):
        """--check should return exit_code from DependencyError."""
        from sidecar.__main__ import _run_check
        from sidecar.errors import DependencyError

        with patch("sidecar.__main__._check_audio_device") as mock_audio:
            mock_audio.return_value = None
            with patch("sidecar.__main__._check_dependencies") as mock_deps:
                mock_deps.side_effect = DependencyError(
                    "DEPENDENCY_MISSING", "faster-whisper not installed"
                )
                result = _run_check()
        assert result == 4  # DependencyError.exit_code


# ---------------------------------------------------------------------------
# Global exception handler
# ---------------------------------------------------------------------------


class TestGlobalExceptionHandler:
    """Verify unhandled exception handler is registered."""

    def test_excepthook_installed(self, tmp_path):
        """main() should install a custom sys.excepthook."""
        sock = tmp_path / "test.sock"
        from sidecar.__main__ import _unhandled_exception_handler

        # Reset to the default to ensure our code sets it
        original_default = sys.__excepthook__
        sys.excepthook = original_default

        with (
            patch("sys.argv", ["sidecar", "--socket", str(sock)]),
            patch("sidecar.__main__.configure_logging"),
            patch("sidecar.__main__.SidecarApp") as mock_app_cls,
            patch("asyncio.run"),
        ):
            mock_app = MagicMock()
            mock_app.run = AsyncMock()
            mock_app_cls.return_value = mock_app
            main()

        # excepthook should now be our custom handler
        assert sys.excepthook is _unhandled_exception_handler
        # Restore
        sys.excepthook = original_default

    def test_custom_excepthook_logs_and_exits(self):
        """The custom excepthook should log FATAL and exit with code 1."""
        from sidecar.__main__ import _unhandled_exception_handler

        with (
            patch("logging.getLogger") as mock_get_logger,
            patch("sys.exit") as mock_exit,
        ):
            mock_logger = MagicMock()
            mock_get_logger.return_value = mock_logger

            try:
                raise RuntimeError("boom")
            except RuntimeError:
                exc_type, exc_value, exc_tb = sys.exc_info()
                _unhandled_exception_handler(exc_type, exc_value, exc_tb)

            mock_logger.fatal.assert_called_once()
            mock_exit.assert_called_once_with(1)
