"""Shared by the contract tests: a live server (CROSSOVER_BASE_URL) and a hook that expires tokens."""

from __future__ import annotations

import asyncio
import os
import time
import urllib.request
import uuid
from typing import Any

import httpx
import websockets

from crossover_sdk import CrossoverClient, RetryOptions

BASE_URL = os.environ.get("CROSSOVER_BASE_URL", "")
CONTROL_URL = os.environ.get("CROSSOVER_CONTROL_URL", "")

MANIFEST = {
    "name": "Dev",
    "operator": {"name": "P", "contact": "p@example.com"},
    "vendor": "Anthropic",
    "model": "m",
    "client": "sdk-python",
    "client_version": "1",
    "description": "d",
}


def expire_agent_tokens(room_id: str) -> None:
    """Make every agent access token of the room expire now (the server side does the SQL)."""
    req = urllib.request.Request(f"{CONTROL_URL}/expire?room={room_id}", method="POST")
    with urllib.request.urlopen(req, timeout=10) as res:
        assert res.status == 200


class Spy(httpx.AsyncBaseTransport):
    """The real transport, counting requests, and able to lose one response after the server has acted."""

    def __init__(self) -> None:
        self.inner = httpx.AsyncHTTPTransport()
        self.counts: dict[str, int] = {}
        self.lose_next: str | None = None  # a path suffix + body fragment: "suffix|fragment"
        self.lost = 0

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        self.counts[path] = self.counts.get(path, 0) + 1
        response = await self.inner.handle_async_request(request)
        if self.lose_next:
            suffix, fragment = self.lose_next.split("|", 1)
            if path.endswith(suffix) and fragment in request.content.decode():
                self.lose_next = None
                self.lost += 1
                await response.aread()
                raise httpx.ReadError("the response never arrived")
        return response

    async def aclose(self) -> None:
        await self.inner.aclose()


class Connections:
    """Remembers every WebSocket the SDK opens, so a test can cut one."""

    def __init__(self) -> None:
        self.sockets: list[Any] = []

    async def __call__(self, url: str) -> Any:
        ws = await websockets.connect(url)
        self.sockets.append(ws)
        return ws

    async def cut_latest(self) -> None:
        await self.sockets[-1].close()


async def new_room(client: CrossoverClient) -> dict[str, Any]:
    tag = uuid.uuid4().hex[:10]
    session = await client.dev_login(f"py-{tag}", "Owner")
    created = await client.create_room(session["session_token"], slug=f"py-{tag}", name="Py", objective="Be called")
    room_id = created.response["room"]["id"]
    owner_session = await client.room_session(session["session_token"], room_id)
    owner = client.room(room_id, owner_session["tokens"]["access_token"])
    invite = await owner.api.room.invite({"role": "DEVELOPER"})
    joined = await client.join(room_id, token=invite.one_time["token"], manifest=MANIFEST)
    dev = client.room(room_id, joined["tokens"])
    return {"room_id": room_id, "owner": owner, "dev": dev, "dev_tokens": joined["tokens"], "participant_id": joined["participant_id"]}


async def last_sequence(room: Any) -> int:
    out = await room.api.room.events.list({"limit": 500})
    return out.response["events"][-1]["sequence"]


async def wait_until(cond: Any, seconds: float = 8.0) -> None:
    deadline = time.monotonic() + seconds
    while not cond():
        if time.monotonic() > deadline:
            raise AssertionError("timed out waiting")
        await asyncio.sleep(0.05)


def fast_retry() -> RetryOptions:
    return RetryOptions(attempts=3, base_s=0.005, max_s=0.01)
