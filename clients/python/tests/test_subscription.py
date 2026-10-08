"""How a subscription renews an expired token, without a server: the socket and the refresh are fakes (T1103)."""

from __future__ import annotations

import asyncio
import unittest
from types import SimpleNamespace
from unittest import mock

from crossover_sdk import CrossoverError, SubscribeOptions, TransportError
from crossover_sdk import ws as ws_module
from crossover_sdk.ws import Subscription, WsConfig


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
