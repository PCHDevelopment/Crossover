"""The Room Protocol over REST and WebSocket (§16, T1103)."""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING, Any, Mapping
from urllib.parse import quote

import httpx

from ._catalog import METHODS
from ._http import RetryOptions, post_json
from ._ids import new_id
from ._types import CommandResult
from .api import make_api
from .errors import CrossoverError, error_from_body
from .tokens import OnTokens, RoomTokens, TokenStore
from .ws import RoomSocket, SubscribeOptions, Subscription, WsConfig

if TYPE_CHECKING:  # typed_api.pyi is generated from the catalog
    from .typed_api import Api


def _envelope(method: str, params: Mapping[str, Any], idempotency_key: str | None) -> dict[str, Any]:
    body: dict[str, Any] = {"id": new_id("cmd"), "method": method, "params": dict(params)}
    if METHODS.get(method):
        body["idempotency_key"] = idempotency_key or str(uuid.uuid4())
    return body


def _result(json: Any) -> CommandResult:
    return CommandResult(
        response=json.get("response"),
        events=json.get("events") or [],
        replayed=json.get("replayed") is True,
        one_time=json.get("one_time"),
    )


class CrossoverClient:
    """Sign in, create or join a room, then work through a :class:`RoomClient`: every command of
    the catalog is a typed call, mutating ones carry an idempotency key (a fresh one unless you pass
    yours) that is reused on retries, and `subscribe` keeps a live, ordered, duplicate-free stream
    of the room's events (complete unless filtered: a filtered stream skips what the filter leaves
    out). Use it as an async context manager, or call :meth:`aclose`."""

    def __init__(
        self,
        base_url: str,
        *,
        retry: RetryOptions | None = None,
        client_name: str = "crossover-sdk-py",
        client_version: str = "0.0.0",
        http: httpx.AsyncClient | None = None,
        connect: Any = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.retry = retry or RetryOptions()
        self.client_name = client_name
        self.client_version = client_version
        self.connect = connect
        self._own_http = http is None
        self.http = http or httpx.AsyncClient(timeout=30.0)

    async def __aenter__(self) -> "CrossoverClient":
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        if self._own_http:
            await self.http.aclose()

    async def dev_login(self, subject: str, display_name: str) -> dict[str, Any]:
        """Development servers only (`dev_login` on): sign in as anyone."""
        _, json = await post_json(
            self.http,
            f"{self.base_url}/v1/auth/dev-login",
            None,
            {"subject": subject, "display_name": display_name},
            self.retry,
        )
        return json

    async def user_command(
        self, session: str, method: str, params: Mapping[str, Any], *, idempotency_key: str | None = None
    ) -> CommandResult:
        """A command that has no room yet (`room.create`), as a signed-in user."""
        _, json = await post_json(
            self.http, f"{self.base_url}/v1/commands", session, _envelope(method, params, idempotency_key), self.retry
        )
        return _result(json)

    async def create_room(
        self, session: str, *, slug: str, name: str, objective: str, settings: Mapping[str, Any] | None = None
    ) -> CommandResult:
        params: dict[str, Any] = {"slug": slug, "name": name, "objective": objective}
        if settings:
            params["settings"] = dict(settings)
        return await self.user_command(session, "room.create", params)

    async def rooms(self, session: str) -> list[dict[str, Any]]:
        """The rooms a signed-in user belongs to."""
        response = await self.http.get(f"{self.base_url}/v1/rooms", headers={"authorization": f"Bearer {session}"})
        try:
            json = response.json()
        except ValueError:
            json = None
        if response.status_code >= 400:
            raise error_from_body(json, response.status_code)
        return json["rooms"]

    async def room_session(self, session: str, room_id: str) -> dict[str, Any]:
        """Exchange a user session for a room access token (the user must be a participant)."""
        _, json = await post_json(
            self.http, f"{self.base_url}/v1/rooms/{quote(room_id, safe='')}/session", session, {}, self.retry
        )
        return json

    async def join(self, room_id: str, *, token: str, manifest: Mapping[str, Any]) -> dict[str, Any]:
        """Join a room with an invite token and a manifest (agents). An invite is single-use: a retry
        after a lost answer would be refused, so this isn't retried."""
        _, json = await post_json(
            self.http,
            f"{self.base_url}/v1/rooms/{quote(room_id, safe='')}/join",
            None,
            {"token": token, "manifest": dict(manifest)},
            RetryOptions(attempts=1),
        )
        return json

    def room(self, room_id: str, tokens: str | RoomTokens, *, on_tokens: OnTokens | None = None) -> "RoomClient":
        """Work in a room with its access token, or with the `tokens` that `join` / `room_session`
        returned: then an expired access token is renewed with the refresh token (once, however many
        calls and subscriptions notice) and the request retried, and `on_tokens` receives each new
        pair to persist (refresh tokens are single-use)."""
        store = TokenStore(tokens, f"{self.base_url}/v1/auth/refresh", self.http, self.retry, on_tokens)
        return RoomClient(self, room_id, store)


class RoomClient:
    """One room, with its tokens. `api` has every command of the catalog as an awaitable call:
    `await room.api.tasks.create({...})`."""

    def __init__(self, client: CrossoverClient, room_id: str, tokens: TokenStore) -> None:
        self.client = client
        self.room_id = room_id
        self._tokens = tokens
        self.api: "Api" = make_api(self._api_call)

    async def _api_call(self, method: str, params: Mapping[str, Any], key: str | None) -> CommandResult:
        return await self.call(method, params, idempotency_key=key)

    async def call(
        self, method: str, params: Mapping[str, Any] | None = None, *, idempotency_key: str | None = None
    ) -> CommandResult:
        """Run a command over REST. Mutating commands are retried safely with the same idempotency key."""
        if method not in METHODS:
            raise ValueError(f"{method!r} is not in the Room Protocol catalog")
        body = _envelope(method, params or {}, idempotency_key)  # one envelope: a retry keeps the key
        url = f"{self.client.base_url}/v1/rooms/{quote(self.room_id, safe='')}/commands"
        renewed = False
        while True:
            token = self._tokens.access
            try:
                _, json = await post_json(self.client.http, url, token, body, self.client.retry)
                return _result(json)
            except CrossoverError as error:
                if error.code != "UNAUTHENTICATED" or renewed or not await self._tokens.refresh_after(token):
                    raise
                renewed = True

    def _ws_config(self) -> WsConfig:
        c = self.client
        scheme = "wss" if c.base_url.startswith("https") else "ws"
        host = c.base_url.split("://", 1)[1]
        return WsConfig(
            url=f"{scheme}://{host}/v1/rooms/{quote(self.room_id, safe='')}/ws",
            token=self._tokens.access,
            get_token=lambda: self._tokens.access,
            refresh=self._tokens.refresh_after,
            client=c.client_name,
            client_version=c.client_version,
            connect=c.connect,
        )

    def socket(self) -> "SocketClient":
        """Commands over a WebSocket, with the same answers as REST (it doesn't reconnect by itself)."""
        return SocketClient(RoomSocket(self._ws_config()))

    def subscribe(self, options: SubscribeOptions | None = None, **kwargs: Any) -> Subscription:
        """The room's events after `after` (default: from the start), then live ones, in order and
        never twice, across dropped connections. Unfiltered, that is every event exactly once; a
        filtered stream (the default for agents) skips sequence numbers the filter leaves out, by
        design. Must be called inside a running event loop."""
        return Subscription(self._ws_config(), options or SubscribeOptions(**kwargs))


class SocketClient:
    def __init__(self, socket: RoomSocket) -> None:
        self._socket = socket
        self.api: "Api" = make_api(self._call)

    async def _call(self, method: str, params: Mapping[str, Any], key: str | None) -> CommandResult:
        return await self._socket.call(method, params, bool(METHODS.get(method)), key)

    async def close(self) -> None:
        await self._socket.close()
