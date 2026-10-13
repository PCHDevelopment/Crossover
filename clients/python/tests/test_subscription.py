"""How a subscription renews an expired token, without a server: the socket and the refresh are fakes (T1103)."""

from __future__ import annotations

import asyncio
import json
import unittest
from types import SimpleNamespace
from unittest import mock

from crossover_sdk import CrossoverError, SubscribeOptions, TransportError
from crossover_sdk import ws as ws_module
from crossover_sdk.ws import Subscription, WsConfig, WsSession


def expired_socket(calls: list[str]):
    """A `connect` whose every connection is refused for an expired access token."""

    async def connect(url: str):
        calls.append(url)
        raise CrossoverError("UNAUTHENTICATED", "expired")

    return connect


def subscription(refresh, connects: list[str]) -> Subscription:
    config = WsConfig(
        url="ws://server.test/v1/rooms/room_1/ws",
        token="old",
        client="test",
        client_version="0",
        refresh=refresh,
        connect=expired_socket(connects),
    )
    return Subscription(config, SubscribeOptions(reconnect_min_s=0.001, reconnect_max_s=0.002))


async def drain(sub: Subscription) -> BaseException | None:
    try:
        async for _ in sub:
            pass
    except BaseException as error:  # noqa: BLE001 - the error the stream ended with is the result
        return error
    return None


class FakeWebSocket:
    def __init__(self) -> None:
        self.incoming: asyncio.Queue[str | None] = asyncio.Queue()
        self.sent: list[dict[str, object]] = []
        self.pong_sent = asyncio.Event()
        self.close_code: int | None = None
        self.close_reason = ""

    async def send(self, raw: str) -> None:
        frame = json.loads(raw)
        self.sent.append(frame)
        if frame.get("type") == "hello":
            self.incoming.put_nowait(json.dumps({"type": "hello_ok"}))
        elif frame.get("type") == "pong":
            self.pong_sent.set()

    async def recv(self) -> str:
        raw = await self.incoming.get()
        if raw is None:
            raise asyncio.CancelledError
        return raw

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.close_code = code
        self.close_reason = reason
        self.incoming.put_nowait(None)


class Liveness(unittest.IsolatedAsyncioTestCase):
    async def session(self, socket: FakeWebSocket, read_timeout_s: float = 1.0) -> WsSession:
        async def connect(_url: str) -> FakeWebSocket:
            return socket

        return await WsSession.open(
            WsConfig(
                url="ws://server.test/v1/rooms/room_1/ws",
                token="tok",
                client="test",
                client_version="0",
                connect=connect,
                read_timeout_s=read_timeout_s,
            )
        )

    async def test_echoes_application_heartbeat_ping(self) -> None:
        socket = FakeWebSocket()
        session = await self.session(socket)
        socket.incoming.put_nowait(json.dumps({"type": "ping", "id": "ping-1"}))
        await asyncio.wait_for(socket.pong_sent.wait(), 1)
        self.assertIn({"type": "pong", "id": "ping-1"}, socket.sent)
        await session.close()

    async def test_read_deadline_closes_idle_socket_with_timeout_code(self) -> None:
        socket = FakeWebSocket()
        session = await self.session(socket, read_timeout_s=0.1)
        closed: asyncio.Future[tuple[int, str]] = asyncio.get_running_loop().create_future()
        session.on_close(lambda code, reason: closed.set_result((code, reason)))
        self.assertEqual(await asyncio.wait_for(closed, 1), (4408, "read timeout"))


class Renew(unittest.IsolatedAsyncioTestCase):
    async def test_a_refresh_that_fails_for_a_transient_reason_backs_off_and_tries_again(self) -> None:
        connects: list[str] = []
        outcomes: list[object] = [TransportError("network", retryable=True), CrossoverError("RATE_LIMITED", "busy", retryable=True), False]
        refreshes: list[str] = []

        async def refresh(used: str) -> bool:
            refreshes.append(used)
            outcome = outcomes.pop(0)
            if isinstance(outcome, BaseException):
                raise outcome
            return bool(outcome)

        error = await asyncio.wait_for(drain(subscription(refresh, connects)), 5)
        # Two transient failures were waited out with a reconnect each; the refusal ended it.
        self.assertEqual(len(refreshes), 3)
        self.assertEqual(len(connects), 3)
        self.assertIsInstance(error, CrossoverError)
        self.assertEqual(error.code, "UNAUTHENTICATED")

    async def test_it_stops_retrying_a_failing_refresh_25_s_after_the_first_failure(self) -> None:
        connects: list[str] = []
        refreshes = 0
        clock = [1000.0]

        async def refresh(used: str) -> bool:
            nonlocal refreshes
            refreshes += 1
            clock[0] += 10.0  # each failing refresh takes 10 s
            raise TransportError("busy", retryable=True)

        # Only the SDK's clock: asyncio's own loop keeps real time.
        with mock.patch.object(ws_module, "time", SimpleNamespace(monotonic=lambda: clock[0])):
            error = await asyncio.wait_for(drain(subscription(refresh, connects)), 5)
        # The first failure starts the clock. Retries checked 0, 10 and 20 s after it are inside
        # REFRESH_PATIENCE_S; the one at 30 s is not sent (it could land outside the server's 30 s
        # grace and revoke the login), so four refreshes go out and the stream ends.
        self.assertEqual(refreshes, 4)
        self.assertIsInstance(error, CrossoverError)


if __name__ == "__main__":
    unittest.main()
