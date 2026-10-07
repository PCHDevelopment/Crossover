"""The Python SDK against a real server: the same contract as the TypeScript SDK's (T1103).

Run by `apps/server/src/e2e/python-sdk.test.ts`, which starts the server and sets
CROSSOVER_BASE_URL and CROSSOVER_CONTROL_URL; skipped when they aren't set.
"""

from __future__ import annotations

import asyncio
import unittest

import httpx

from crossover_sdk import CrossoverClient, CrossoverError, SubscribeOptions, TransportError

from . import helpers as h


@unittest.skipUnless(h.BASE_URL, "needs a running server (CROSSOVER_BASE_URL)")
class Contract(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.connections = h.Connections()
        self.client = CrossoverClient(h.BASE_URL, connect=self.connections)
        self.addAsyncCleanup(self.client.aclose)

    async def test_commands_are_typed_calls_replay_on_the_same_key_and_errors_are_crossover_errors(self) -> None:
        r = await h.new_room(self.client)
        first = await r["dev"].api.messages.send({"body": "hello"}, idempotency_key="k-1")
        self.assertFalse(first.replayed)
        again = await r["dev"].api.messages.send({"body": "hello"}, idempotency_key="k-1")
        self.assertTrue(again.replayed)
        self.assertEqual(again.response, first.response)
        listed = await r["owner"].api.messages.list()
        self.assertEqual([m["body"] for m in listed.response["messages"]], ["hello"])
        with self.assertRaises(CrossoverError) as caught:
            await r["dev"].api.events.redact({"sequence": 1, "reason": "x"})
        self.assertEqual(caught.exception.code, "FORBIDDEN")
        self.assertFalse(caught.exception.retryable)

    async def test_the_catalog_is_the_api_and_nothing_else(self) -> None:
        r = await h.new_room(self.client)
        api = r["owner"].api
        self.assertTrue(callable(api.tasks.create))
        self.assertTrue(callable(api.sandbox.exec))  # a command that is also a namespace…
        self.assertTrue(callable(api.sandbox.exec.cancel))  # …and what is under it
        self.assertTrue(callable(api.git.import_))  # a Python keyword gets a trailing underscore
        with self.assertRaises(AttributeError):
            api.nonsense  # noqa: B018
        with self.assertRaises(AttributeError):
            api.tasks.nonsense  # noqa: B018
        with self.assertRaises(ValueError):
            await r["owner"].call("nonsense.method")

    async def test_a_response_lost_on_the_way_back_is_retried_with_the_same_key_and_runs_once(self) -> None:
        spy = h.Spy()
        client = CrossoverClient(h.BASE_URL, http=httpx.AsyncClient(transport=spy), retry=h.fast_retry())
        r = await h.new_room(client)
        spy.lose_next = "/commands|only once"
        sent = await r["dev"].api.messages.send({"body": "only once"})
        self.assertEqual(spy.lost, 1)
        self.assertTrue(sent.replayed)  # the retry got the stored answer
        listed = await r["owner"].api.messages.list()
        self.assertEqual([m["body"] for m in listed.response["messages"]], ["only once"])

    async def test_commands_over_a_websocket_give_the_same_answers_as_rest(self) -> None:
        r = await h.new_room(self.client)
        socket = r["dev"].socket()
        try:
            sent = await socket.api.messages.send({"body": "over the socket"}, idempotency_key="ws-1")
            self.assertFalse(sent.replayed)
            replay = await socket.api.messages.send({"body": "over the socket"}, idempotency_key="ws-1")
            self.assertTrue(replay.replayed)
            with self.assertRaises(CrossoverError) as caught:
                await socket.api.events.redact({"sequence": 1, "reason": "x"})
            self.assertEqual(caught.exception.code, "FORBIDDEN")
            read = await socket.api.messages.list()
            self.assertEqual([m["body"] for m in read.response["messages"]], ["over the socket"])
        finally:
            await socket.close()

    async def test_a_stream_cut_over_and_over_loses_no_event_and_repeats_none(self) -> None:
        r = await h.new_room(self.client)
        received: list[int] = []
        sub = r["owner"].subscribe(
            SubscribeOptions(after=0, reconnect_min_s=0.02, reconnect_max_s=0.06, on_event=lambda e: received.append(e["sequence"]))
        )
        cuts = 0
        for i in range(30):
            await r["owner"].api.messages.send({"body": f"m{i}"})  # a human: agents have a message budget
            if i % 8 == 4 and cuts < 3:
                cuts += 1
                await self.connections.cut_latest()  # the network drops
        target = await h.last_sequence(r["owner"])
        await h.wait_until(lambda: sub.last_sequence >= target, 15)
        await sub.close()
        self.assertEqual(cuts, 3)
        self.assertEqual(received, list(range(1, target + 1)))  # once each, in order
        self.assertGreaterEqual(len(self.connections.sockets), 4)  # it really did reconnect

    async def test_a_stream_resumes_from_where_a_client_left_off_and_ends_with_the_error_when_its_token_is_bad(self) -> None:
        r = await h.new_room(self.client)
        await r["dev"].api.messages.send({"body": "a"})
        await r["dev"].api.messages.send({"body": "b"})
        up_to = await h.last_sequence(r["owner"])
        resumed: list[int] = []
        sub = r["owner"].subscribe(after=up_to - 1, on_event=lambda e: resumed.append(e["sequence"]))
        await h.wait_until(lambda: len(resumed) >= 1)
        await sub.close()
        self.assertEqual(resumed, [up_to])
        bad = self.client.room(r["room_id"], "not-a-token").subscribe()
        with self.assertRaises(CrossoverError) as caught:
            async for _ in bad:
                pass
        self.assertEqual(caught.exception.code, "UNAUTHENTICATED")

    async def test_an_expired_access_token_is_renewed_once_for_many_calls_and_on_tokens_gets_the_pair(self) -> None:
        spy = h.Spy()
        client = CrossoverClient(h.BASE_URL, http=httpx.AsyncClient(transport=spy), retry=h.fast_retry())
        r = await h.new_room(client)
        pairs: list[dict] = []
        dev = client.room(r["room_id"], r["dev_tokens"], on_tokens=pairs.append)
        await dev.api.messages.send({"body": "before"})
        h.expire_agent_tokens(r["room_id"])
        sent = await asyncio.gather(
            *[dev.api.messages.send({"body": f"after-{i}"}, idempotency_key=f"renew-{i}") for i in range(5)]
        )
        self.assertTrue(all(not s.replayed for s in sent))
        self.assertEqual(spy.counts.get("/v1/auth/refresh"), 1)
        self.assertEqual(len(pairs), 1)
        self.assertNotEqual(pairs[0]["access_token"], r["dev_tokens"]["access_token"])
        listed = await r["owner"].api.messages.list()
        self.assertEqual(
            sorted(m["body"] for m in listed.response["messages"]),
            sorted(["before", *[f"after-{i}" for i in range(5)]]),
        )
        # And again later, from the new pair's own refresh token.
        h.expire_agent_tokens(r["room_id"])
        await dev.api.messages.send({"body": "later"})
        self.assertEqual(len(pairs), 2)

    async def test_a_refresh_response_lost_on_the_way_back_is_not_retried_by_the_sdk(self) -> None:
        spy = h.Spy()
        client = CrossoverClient(h.BASE_URL, http=httpx.AsyncClient(transport=spy), retry=h.fast_retry())
        r = await h.new_room(client)
        dev = client.room(r["room_id"], r["dev_tokens"])
        h.expire_agent_tokens(r["room_id"])
        spy.lose_next = "/v1/auth/refresh|refresh_token"
        with self.assertRaises((TransportError, CrossoverError)) as caught:
            await dev.api.messages.send({"body": "one"})
        self.assertEqual(spy.counts.get("/v1/auth/refresh"), 1)  # sent once, not re-sent
        self.assertTrue(caught.exception.retryable)
        self.assertNotEqual(getattr(caught.exception, "code", None), "UNAUTHENTICATED")
        # (That the login then survives, because the server takes the spent token for a retry
        # within its grace window, is the server's change in #151 and is tested there.)

    async def test_a_callback_that_raises_does_not_take_the_stream_down(self) -> None:
        r = await h.new_room(self.client)
        seen: list[int] = []

        def bad(event: dict) -> None:
            seen.append(event["sequence"])
            raise RuntimeError("the caller's bug")

        with self.assertWarns(RuntimeWarning):
            sub = r["owner"].subscribe(SubscribeOptions(after=0, on_event=bad))
            await r["owner"].api.messages.send({"body": "x"})
            target = await h.last_sequence(r["owner"])
            await h.wait_until(lambda: sub.last_sequence >= target)
        got: list[int] = []
        async for event in sub:
            got.append(event["sequence"])
            if event["sequence"] >= target:
                break
        await sub.close()
        self.assertEqual(got, list(range(1, target + 1)))  # the iterator lost nothing either

    async def test_without_a_refresh_token_the_expiry_is_the_callers_unauthenticated(self) -> None:
        r = await h.new_room(self.client)
        plain = self.client.room(r["room_id"], r["dev_tokens"]["access_token"])  # no refresh token held
        h.expire_agent_tokens(r["room_id"])
        with self.assertRaises(CrossoverError) as caught:
            await plain.api.messages.send({"body": "x"})
        self.assertEqual(caught.exception.code, "UNAUTHENTICATED")

    async def test_a_subscription_outlives_its_access_token(self) -> None:
        spy = h.Spy()
        client = CrossoverClient(h.BASE_URL, http=httpx.AsyncClient(transport=spy), connect=self.connections)
        r = await h.new_room(client)
        pairs: list[dict] = []
        dev = client.room(r["room_id"], r["dev_tokens"], on_tokens=pairs.append)
        received: list[int] = []
        sub = dev.subscribe(
            SubscribeOptions(after=0, profile="all", reconnect_min_s=0.02, reconnect_max_s=0.06, on_event=lambda e: received.append(e["sequence"]))
        )
        await r["owner"].api.messages.send({"body": "one"})
        await h.wait_until(lambda: len(received) >= 3)
        h.expire_agent_tokens(r["room_id"])
        await self.connections.cut_latest()  # the connection goes with it
        await r["owner"].api.messages.send({"body": "two"})
        await r["owner"].api.messages.send({"body": "three"})
        target = await h.last_sequence(r["owner"])
        await h.wait_until(lambda: sub.last_sequence >= target, 15)
        await sub.close()
        self.assertEqual(received, list(range(1, target + 1)))
        self.assertEqual(spy.counts.get("/v1/auth/refresh"), 1)
        self.assertEqual(len(pairs), 1)

    async def test_a_filtered_stream_skips_sequences_without_taking_them_for_a_gap(self) -> None:
        r = await h.new_room(self.client)
        seen: list[dict] = []
        sub = r["dev"].subscribe(SubscribeOptions(after=0, types=["message.*"], on_event=seen.append))
        await h.wait_until(lambda: sub.filter is not None or len(seen) > 0, 5)
        if sub.filter is None:
            await sub.close()
            self.skipTest("this server doesn't filter subscriptions yet (T704)")
        before = len(self.connections.sockets)
        await r["owner"].api.messages.send({"body": "hello"})
        await h.wait_until(lambda: any(e["type"] == "message.sent" for e in seen))
        await sub.close()
        self.assertEqual({e["type"] for e in seen}, {"message.sent"})
        self.assertEqual(len(self.connections.sockets), before)  # no reconnect over the gaps


if __name__ == "__main__":
    unittest.main()
