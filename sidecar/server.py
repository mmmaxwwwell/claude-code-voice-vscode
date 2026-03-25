"""Unix domain socket server for extension <-> sidecar communication.

Listens on a Unix domain socket, accepts a single client connection,
reads NDJSON config/control messages, writes NDJSON status/transcript/error
messages. Cleans up socket file on shutdown.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Callable, Awaitable

from sidecar.protocol import (
    ConfigMessage,
    ControlMessage,
    ErrorMessage,
    Message,
    StatusMessage,
    deserialize,
    serialize,
)

logger = logging.getLogger(__name__)


def default_socket_path(pid: int | None = None) -> str:
    """Return the default socket path based on environment.

    Uses $XDG_RUNTIME_DIR if set, otherwise falls back to /tmp.
    """
    if pid is None:
        pid = os.getpid()
    runtime_dir = os.environ.get("XDG_RUNTIME_DIR", "/tmp")
    return os.path.join(runtime_dir, f"claude-voice-{pid}.sock")


class SocketServer:
    """Unix domain socket server accepting a single client connection.

    Usage::

        server = SocketServer("/path/to/socket.sock")
        server.on_config = my_config_handler
        server.on_control = my_control_handler

        async with server:
            # server is listening, use server.send() to push messages
            await server.send(StatusMessage(state="listening"))

    Args:
        socket_path: Path to the Unix domain socket file.
    """

    def __init__(self, socket_path: str) -> None:
        self._socket_path = socket_path
        self._server: asyncio.AbstractServer | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._reader_task: asyncio.Task | None = None
        self._has_client = False

        # Callbacks — set by the caller
        self.on_config: Callable[[ConfigMessage], Awaitable[None]] | None = None
        self.on_control: Callable[[ControlMessage], Awaitable[None]] | None = None
        self.on_disconnect: Callable[[], Awaitable[None]] | None = None

    async def __aenter__(self) -> SocketServer:
        await self.start()
        return self

    async def __aexit__(self, *exc) -> None:
        await self.stop()

    async def start(self) -> None:
        """Start listening on the Unix domain socket."""
        # Remove stale socket file if it exists
        if os.path.exists(self._socket_path):
            os.unlink(self._socket_path)

        self._server = await asyncio.start_unix_server(
            self._handle_client, path=self._socket_path
        )
        logger.info("Socket server listening on %s", self._socket_path)

    async def stop(self) -> None:
        """Stop the server and clean up."""
        # Cancel reader task
        if self._reader_task and not self._reader_task.done():
            self._reader_task.cancel()
            try:
                await self._reader_task
            except asyncio.CancelledError:
                pass

        # Close client connection
        if self._writer and not self._writer.is_closing():
            self._writer.close()
            try:
                await self._writer.wait_closed()
            except (ConnectionError, BrokenPipeError):
                pass

        self._writer = None
        self._has_client = False

        # Stop the server
        if self._server:
            self._server.close()
            await self._server.wait_closed()
            self._server = None

        # Clean up socket file
        if os.path.exists(self._socket_path):
            os.unlink(self._socket_path)
            logger.info("Cleaned up socket file %s", self._socket_path)

    async def send(self, msg: Message) -> None:
        """Send a message to the connected client.

        Silently drops the message if no client is connected.
        """
        if self._writer is None or self._writer.is_closing():
            return
        try:
            self._writer.write(serialize(msg).encode("utf-8"))
            await self._writer.drain()
        except (ConnectionError, BrokenPipeError):
            logger.warning("Failed to send message, client disconnected")

    async def _handle_client(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        """Handle a new client connection."""
        if self._has_client:
            # Reject second connection
            logger.warning("Rejecting second client connection")
            try:
                error = ErrorMessage(
                    code="CONNECTION_REJECTED",
                    message="Another client is already connected.",
                )
                writer.write(serialize(error).encode("utf-8"))
                await writer.drain()
            except (ConnectionError, BrokenPipeError):
                pass
            writer.close()
            try:
                await writer.wait_closed()
            except (ConnectionError, BrokenPipeError):
                pass
            return

        self._has_client = True
        self._writer = writer
        logger.info("Client connected")

        # Send ready status
        await self.send(StatusMessage(state="ready"))

        # Start reading messages from client
        self._reader_task = asyncio.current_task()
        try:
            await self._read_loop(reader)
        finally:
            self._has_client = False
            self._writer = None
            logger.info("Client disconnected")
            if self.on_disconnect:
                await self.on_disconnect()

    async def _read_loop(self, reader: asyncio.StreamReader) -> None:
        """Read NDJSON messages from the client."""
        while True:
            try:
                line = await reader.readline()
            except (ConnectionError, BrokenPipeError):
                break

            if not line:
                # EOF — client disconnected
                break

            line_str = line.decode("utf-8").strip()
            if not line_str:
                continue

            try:
                msg = deserialize(line_str)
            except ValueError as e:
                logger.warning("Protocol error: %s", e)
                await self.send(
                    ErrorMessage(
                        code="PROTOCOL_ERROR",
                        message=f"Invalid message: {e}",
                    )
                )
                continue

            if isinstance(msg, ConfigMessage) and self.on_config:
                await self.on_config(msg)
            elif isinstance(msg, ControlMessage) and self.on_control:
                await self.on_control(msg)
            else:
                logger.warning("Unhandled message type: %s", type(msg).__name__)
