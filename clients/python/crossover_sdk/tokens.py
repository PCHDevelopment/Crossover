"""Room tokens and how they renew (T1106)."""

from __future__ import annotations

import asyncio
import inspect
from typing import Any, Awaitable, Callable, Mapping, Union

import httpx

from ._http import RetryOptions, post_json
from .errors import CrossoverError

RoomTokens = dict[str, Any]
OnTokens = Callable[[RoomTokens], Union[None, Awaitable[None]]]


class TokenStore:
    """The tokens one room client works with. When the server answers `UNAUTHENTICATED` (the
    access token expired) and a refresh token is held, **one** refresh runs however many calls and
    subscriptions noticed at once, and the others use its result. A refresh that fails, or a
    client holding no refresh token, leaves the original error."""

    def __init__(
        self,
        tokens: str | Mapping[str, Any],
        refresh_url: str,
        http: httpx.AsyncClient,
        retry: RetryOptions,
        on_tokens: OnTokens | None = None,
    ) -> None:
        self._tokens: RoomTokens = {"access_token": tokens} if isinstance(tokens, str) else dict(tokens)
        self._refresh_url = refresh_url
        self._http = http
        self._retry = retry
        self._on_tokens = on_tokens
        self._inflight: asyncio.Future[None] | None = None

    @property
    def access(self) -> str:
        return str(self._tokens["access_token"])

    @property
    def can_refresh(self) -> bool:
        token = self._tokens.get("refresh_token")
        return isinstance(token, str) and token != ""

    async def refresh_after(self, failed: str) -> bool:
        """Renew after `failed` (the access token that was refused) stopped working. True when a
        newer token is now held (this call's or another's refresh), False when it can't be renewed."""
        if self.access != failed:
            return True
        if not self.can_refresh:
            return False
        if self._inflight is None:
            self._inflight = asyncio.ensure_future(self._do_refresh())
            self._inflight.add_done_callback(self._clear)
        try:
            await asyncio.shield(self._inflight)
            return True
        except CrossoverError as error:
            if error.code == "UNAUTHENTICATED":
                return False
            raise

    def _clear(self, _future: Any) -> None:
        self._inflight = None

    async def _do_refresh(self) -> None:
        _, pair = await post_json(
            self._http, self._refresh_url, None, {"refresh_token": self._tokens["refresh_token"]}, self._retry
        )
        self._tokens = dict(pair)
        if self._on_tokens is not None:
            result = self._on_tokens(dict(pair))
            if inspect.isawaitable(result):
                await result
