"""Integration tests for the Unix domain socket server.

Connect to the server, send config + control:start, verify status messages.
"""

from __future__ import annotations

import asyncio
import os
import tempfile

import pytest
import pytest_asyncio

from sidecar.protocol import (
    ConfigMessage,
    ControlMessage,
    StatusMessage,
    ErrorMessage,
    deserialize,
    serialize,
)
from sidecar.server import SocketServer


def _make_config(**overrides) -> ConfigMessage:
    """Create a ConfigMessage with sensible defaults."""
    defaults = dict(
        inputMode="wakeWord",
        whisperModel="base",
        wakeWord="hey_claude",
        submitWords=["send it", "go", "submit"],
        cancelWords=["never mind", "cancel"],
        silenceTimeout=1500,
        maxUtteranceDuration=60000,
        micDevice="",
    )
    defaults.update(overrides)
    return ConfigMessage(**defaults)


@pytest.fixture
def socket_path(tmp_path):
    """Provide a temporary socket path."""
    return str(tmp_path / "test-server.sock")


class TestSocketServer:
    """Integration tests for SocketServer."""

    @pytest.mark.asyncio
    async def test_server_creates_and_cleans_up_socket_file(self, socket_path):
        """Server creates socket file on start and removes it on shutdown."""
        server = SocketServer(socket_path)

        async with server:
            assert os.path.exists(socket_path)

        assert not os.path.exists(socket_path)

    @pytest.mark.asyncio
    async def test_client_connects_and_receives_ready(self, socket_path):
        """Client connects and receives a 'ready' status message."""
        server = SocketServer(socket_path)

        async with server:
            reader, writer = await asyncio.open_unix_connection(socket_path)

            # Server should send 'ready' status on connection
            line = await asyncio.wait_for(reader.readline(), timeout=2.0)
            msg = deserialize(line.decode("utf-8"))
            assert isinstance(msg, StatusMessage)
            assert msg.state == "ready"

            writer.close()
            await writer.wait_closed()

    @pytest.mark.asyncio
    async def test_send_config_and_control_start(self, socket_path):
        """Send config then control:start, verify status messages."""
        received: list = []
        config_received = asyncio.Event()
        start_received = asyncio.Event()

        async def on_config(cfg: ConfigMessage):
            received.append(("config", cfg))
            config_received.set()

        async def on_control(ctl: ControlMessage):
            received.append(("control", ctl))
            start_received.set()

        server = SocketServer(socket_path)
        server.on_config = on_config
        server.on_control = on_control

        async with server:
            reader, writer = await asyncio.open_unix_connection(socket_path)

            # Read the ready message
            line = await asyncio.wait_for(reader.readline(), timeout=2.0)
            msg = deserialize(line.decode("utf-8"))
            assert isinstance(msg, StatusMessage)
            assert msg.state == "ready"

            # Send config
            config = _make_config()
            writer.write(serialize(config).encode("utf-8"))
            await writer.drain()
            await asyncio.wait_for(config_received.wait(), timeout=2.0)

            # Send control:start
            control = ControlMessage(action="start")
            writer.write(serialize(control).encode("utf-8"))
            await writer.drain()
            await asyncio.wait_for(start_received.wait(), timeout=2.0)

            assert len(received) == 2
            assert received[0][0] == "config"
            assert received[0][1].inputMode == "wakeWord"
            assert received[1][0] == "control"
            assert received[1][1].action == "start"

            writer.close()
            await writer.wait_closed()

    @pytest.mark.asyncio
    async def test_server_sends_messages_to_client(self, socket_path):
        """Server can send status/transcript/error messages to connected client."""
        server = SocketServer(socket_path)

        async with server:
            reader, writer = await asyncio.open_unix_connection(socket_path)

            # Read ready message
            line = await asyncio.wait_for(reader.readline(), timeout=2.0)
            assert deserialize(line.decode("utf-8")).state == "ready"

            # Server sends a status message
            await server.send(StatusMessage(state="listening"))

            line = await asyncio.wait_for(reader.readline(), timeout=2.0)
            msg = deserialize(line.decode("utf-8"))
            assert isinstance(msg, StatusMessage)
            assert msg.state == "listening"

            # Server sends an error message
            await server.send(ErrorMessage(code="MIC_NOT_FOUND", message="No mic"))

            line = await asyncio.wait_for(reader.readline(), timeout=2.0)
            msg = deserialize(line.decode("utf-8"))
            assert isinstance(msg, ErrorMessage)
            assert msg.code == "MIC_NOT_FOUND"

            writer.close()
            await writer.wait_closed()

    @pytest.mark.asyncio
    async def test_single_client_only(self, socket_path):
        """Server accepts only one client at a time; second connection is rejected."""
        server = SocketServer(socket_path)

        async with server:
            # First client connects
            reader1, writer1 = await asyncio.open_unix_connection(socket_path)
            line = await asyncio.wait_for(reader1.readline(), timeout=2.0)
            assert deserialize(line.decode("utf-8")).state == "ready"

            # Second client connects — should get disconnected
            reader2, writer2 = await asyncio.open_unix_connection(socket_path)
            # The second connection should receive EOF or error
            line = await asyncio.wait_for(reader2.readline(), timeout=2.0)
            # Either empty (EOF) or an error message
            if line:
                msg = deserialize(line.decode("utf-8"))
                assert isinstance(msg, ErrorMessage)

            writer1.close()
            await writer1.wait_closed()
            writer2.close()
            await writer2.wait_closed()

    @pytest.mark.asyncio
    async def test_malformed_json_sends_error(self, socket_path):
        """Malformed JSON from client sends an error message back."""
        server = SocketServer(socket_path)

        async with server:
            reader, writer = await asyncio.open_unix_connection(socket_path)

            # Read ready
            line = await asyncio.wait_for(reader.readline(), timeout=2.0)
            assert deserialize(line.decode("utf-8")).state == "ready"

            # Send garbage
            writer.write(b"not valid json\n")
            await writer.drain()

            line = await asyncio.wait_for(reader.readline(), timeout=2.0)
            msg = deserialize(line.decode("utf-8"))
            assert isinstance(msg, ErrorMessage)
            assert msg.code == "PROTOCOL_ERROR"

            writer.close()
            await writer.wait_closed()

    @pytest.mark.asyncio
    async def test_client_disconnect_detected(self, socket_path):
        """Server detects client disconnect gracefully."""
        disconnect_event = asyncio.Event()

        async def on_disconnect():
            disconnect_event.set()

        server = SocketServer(socket_path)
        server.on_disconnect = on_disconnect

        async with server:
            reader, writer = await asyncio.open_unix_connection(socket_path)

            # Read ready
            line = await asyncio.wait_for(reader.readline(), timeout=2.0)
            assert deserialize(line.decode("utf-8")).state == "ready"

            # Disconnect
            writer.close()
            await writer.wait_closed()

            # Server should detect the disconnect
            await asyncio.wait_for(disconnect_event.wait(), timeout=2.0)


class TestSocketPathGeneration:
    """Test socket path generation logic."""

    def test_default_path_uses_xdg_runtime_dir(self, monkeypatch):
        """Socket path uses XDG_RUNTIME_DIR when available."""
        from sidecar.server import default_socket_path

        monkeypatch.setenv("XDG_RUNTIME_DIR", "/run/user/1000")
        path = default_socket_path(pid=12345)
        assert path == "/run/user/1000/claude-voice-12345.sock"

    def test_fallback_to_tmp(self, monkeypatch):
        """Socket path falls back to /tmp when XDG_RUNTIME_DIR not set."""
        from sidecar.server import default_socket_path

        monkeypatch.delenv("XDG_RUNTIME_DIR", raising=False)
        path = default_socket_path(pid=12345)
        assert path == "/tmp/claude-voice-12345.sock"
