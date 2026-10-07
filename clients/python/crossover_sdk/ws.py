"""Commands and the event stream over a WebSocket (§16.4, §20)."""

from __future__ import annotations

import asyncio
import json
import random
import uuid
import warnings
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Awaitable, Callable, Mapping

import websockets

from ._catalog import PROTOCOL_VERSION
from ._ids import new_id
from ._types import CommandResult
from .errors import CrossoverError, TransportError

# Close codes the server uses (§16.4, application range).
CLOSE_UNAUTHENTICATED = 4401
CLOSE_NOT_FOUND = 4404
CLOSE_RESYNC_REQUIRED = 4409

#: The longest the stream waits because a server asked it to (a budget's `retry_after`).
MAX_RETRY_AFTER_S = 600.0

Connect = Callable[[str], Any]


@dataclass
class WsConfig:
    url: str
    token: str = field(repr=False)
    client: str
    client_version: str
    get_token: Callable[[], str] | None = None
    refresh: Callable[[str], Awaitable[bool]] | None = None
    connect: Connect | None = None
    hello_timeout_s: float = 10.0


def frame_error(frame: Mapping[str, Any]) -> CrossoverError:
    error = frame.get("error")
    error = error if isinstance(error, dict) else {}
    details = error.get("details")
    return CrossoverError(
        str(error.get("code", "VALIDATION")),
        str(error.get("message", "Error")),
        retryable=error.get("retryable") is True,
        details=details if isinstance(details, dict) else None,
    )


def _retry_after(error: CrossoverError) -> float | None:
    try:
        seconds = float(error.details.get("retry_after") or 0)
    except (TypeError, ValueError):
        return None
    return min(seconds, MAX_RETRY_AFTER_S) if seconds > 0 else None


class WsSession:
    """One connected, greeted socket."""

    def __init__(self, ws: Any) -> None:
        self._ws = ws
        self._frame_handler: Callable[[dict[str, Any]], None] | None = None
        self._close_handler: Callable[[int, str], None] | None = None
        self._closed = False
        self._reader: asyncio.Task[None] | None = None
        self._hello: asyncio.Future[None] = asyncio.get_running_loop().create_future()

    @classmethod
    async def open(cls, config: WsConfig) -> "WsSession":
        connect = config.connect or (lambda url: websockets.connect(url, max_size=16 * 1024 * 1024))
        try:
            ws = await asyncio.wait_for(connect(config.url), config.hello_timeout_s)
        except (OSError, asyncio.TimeoutError, websockets.WebSocketException) as error:
            raise TransportError("Couldn't open the WebSocket", retryable=True) from error
        session = cls(ws)
        session._reader = asyncio.ensure_future(session._read())
        token = config.get_token() if config.get_token else config.token
        await ws.send(
            json.dumps(
                {
                    "type": "hello",
                    "protocol_version": PROTOCOL_VERSION,
                    "client": config.client,
                    "client_version": config.client_version,
                    "token": token,
                }
            )
        )
        try:
            await asyncio.wait_for(asyncio.shield(session._hello), config.hello_timeout_s)
        except asyncio.TimeoutError:
            await session.close()
            raise TransportError("The server didn't answer hello", retryable=True) from None
        except BaseException:
            await session.close()
            raise
        return session

    async def _read(self) -> None:
        greeted = False
        try:
            async for raw in self._ws:
                try:
                    frame = json.loads(raw)
                except ValueError:
                    continue
                if not isinstance(frame, dict):
                    continue
                if not greeted:
                    if frame.get("type") == "hello_ok":
                        greeted = True
                        self._hello.set_result(None)
                    elif frame.get("type") == "error" and not self._hello.done():
                        self._hello.set_exception(frame_error(frame))
                    continue
                if self._frame_handler:
                    self._frame_handler(frame)
        except websockets.WebSocketException:
            pass
        finally:
            self._closed = True
            code = getattr(self._ws, "close_code", None) or 1006
            reason = getattr(self._ws, "close_reason", None) or ""
            if not self._hello.done():
                self._hello.set_exception(
                    TransportError(f"The connection closed ({code})", retryable=code not in (CLOSE_UNAUTHENTICATED, CLOSE_NOT_FOUND))
                )
            if self._close_handler:
                self._close_handler(code, reason)

    def on_frame(self, handler: Callable[[dict[str, Any]], None]) -> None:
        self._frame_handler = handler

    def on_close(self, handler: Callable[[int, str], None]) -> None:
        self._close_handler = handler
        if self._closed:
            handler(getattr(self._ws, "close_code", None) or 1006, "")

    async def send(self, frame: Mapping[str, Any]) -> None:
        await self._ws.send(json.dumps(frame))

    async def close(self) -> None:
        try:
            await self._ws.close()
        except Exception:  # already closing
            pass


class RoomSocket:
    """Commands over one WebSocket, with the same answers as REST, matched by command id. It
    doesn't reconnect: when the socket closes, pending calls fail and the next call opens a new one."""

    def __init__(self, config: WsConfig) -> None:
        self._config = config
        self._session: asyncio.Future[WsSession] | None = None
        self._pending: dict[str, asyncio.Future[CommandResult]] = {}

    def _connect(self) -> "asyncio.Future[WsSession]":
        if self._session is None:
            self._session = asyncio.ensure_future(self._open())
        return self._session

    async def _open(self) -> WsSession:
        try:
            session = await WsSession.open(self._config)
        except BaseException:
            self._session = None
            raise
        session.on_frame(self._on_frame)
        session.on_close(self._on_close)
        return session

    def _on_frame(self, frame: dict[str, Any]) -> None:
        frame_id = frame.get("id")
        future = self._pending.pop(frame_id, None) if isinstance(frame_id, str) else None
        if future is None or future.done():
            return
        if frame.get("type") == "result":
            future.set_result(
                CommandResult(
                    response=frame.get("response"),
                    events=frame.get("events") or [],
                    replayed=frame.get("replayed") is True,
                    one_time=frame.get("one_time"),
                )
            )
        elif frame.get("type") == "error":
            future.set_exception(frame_error(frame))

    def _on_close(self, _code: int, _reason: str) -> None:
        self._session = None
        for key, future in list(self._pending.items()):
            self._pending.pop(key, None)
            if not future.done():
                future.set_exception(TransportError("The connection closed", retryable=True))

    async def call(
        self, method: str, params: Mapping[str, Any], mutating: bool, idempotency_key: str | None = None
    ) -> CommandResult:
        used = self._config.get_token() if self._config.get_token else self._config.token
        try:
            session = await self._connect()
        except CrossoverError as error:
            # An expired access token: renew it and connect once more.
            if error.code != "UNAUTHENTICATED" or not self._config.refresh:
                raise
            if not await self._config.refresh(used):
                raise
            session = await self._connect()
        command_id = new_id("cmd")
        future: asyncio.Future[CommandResult] = asyncio.get_running_loop().create_future()
        self._pending[command_id] = future
        frame: dict[str, Any] = {"type": "command", "id": command_id, "method": method, "params": dict(params)}
        if mutating:
            frame["idempotency_key"] = idempotency_key or str(uuid.uuid4())
        await session.send(frame)
        return await future

    async def close(self) -> None:
        if self._session is not None:
            try:
                await (await self._session).close()
            except Exception:
                pass


_END = object()


@dataclass
class SubscribeOptions:
    #: Deliver events with a sequence greater than this (the last one you have).
    after: int = 0
    on_event: Callable[[dict[str, Any]], None] | None = None
    #: A problem that ended the subscription (the token stopped working, the room is gone).
    on_error: Callable[[BaseException], None] | None = None
    #: `connecting` -> `live`, `reconnecting` after a drop, `closed` at the end.
    on_state: Callable[[str], None] | None = None
    #: Which events to receive (§17.1): `relevant`, `all` or `custom` (with `types` and `scopes`).
    profile: str | None = None
    types: list[str] | None = None
    scopes: Mapping[str, Any] | None = None
    #: Reconnect waits in seconds: first `reconnect_min_s`, doubling with jitter up to `reconnect_max_s`.
    reconnect_min_s: float = 0.1
    reconnect_max_s: float = 5.0


class Subscription:
    """A stream of a room's events that survives dropped connections: every event after `after`
    once and in order. After a drop, a server `resync_required` or a gap, it reconnects and asks
    for everything after the last sequence it delivered. Read it with `async for`, with `on_event`,
    or both. A problem that reconnecting can't fix ends it with `on_error`. A filtered stream (the
    default for agents) skips sequence numbers by design; that is not a gap."""

    def __init__(self, config: WsConfig, options: SubscribeOptions) -> None:
        self._config = config
        self._options = options
        self.last_sequence = options.after
        #: The filter the server resolved for this subscription (`None` before the first `subscribed`).
        self.filter: dict[str, Any] | None = None
        self._queue: asyncio.Queue[Any] = asyncio.Queue()
        self._done = False
        self._failure: BaseException | None = None
        self._session: WsSession | None = None
        self._retry_after: float | None = None
        self._task = asyncio.ensure_future(self._run())
        self._sleeper: asyncio.Future[None] | None = None

    async def close(self) -> None:
        if self._done:
            return
        await self._finish(None)
        self._task.cancel()
        try:
            await self._task
        except (asyncio.CancelledError, Exception):
            pass

    async def _finish(self, error: BaseException | None) -> None:
        if self._done:
            return
        self._done = True
        self._failure = error
        if self._session:
            await self._session.close()
        self._state("closed")
        if error is not None:
            self._callback(self._options.on_error, error)
        self._queue.put_nowait(_END)

    def _state(self, state: str) -> None:
        self._callback(self._options.on_state, state)

    @staticmethod
    def _callback(fn: Callable[[Any], None] | None, value: Any) -> None:
        """A caller's callback that raises must not take the stream down with it."""
        if fn is None:
            return
        try:
            fn(value)
        except Exception as error:  # noqa: BLE001 - the caller's bug, not the stream's
            warnings.warn(f"crossover_sdk: a callback raised {error!r}", RuntimeWarning, stacklevel=2)

    def _deliver(self, event: dict[str, Any]) -> None:
        self.last_sequence = int(event["sequence"])
        self._queue.put_nowait(event)  # in the iterator first: a bad callback loses nothing
        self._callback(self._options.on_event, event)

    async def _renew(self, used: str) -> str:
        """"renewed", "refused" (the token can't be renewed), or "later" (the refresh itself failed
        in a way that may pass: the server busy, the network): wait and connect again."""
        if not self._config.refresh:
            return "refused"
        try:
            return "renewed" if await self._config.refresh(used) else "refused"
        except CrossoverError as error:
            self._retry_after = _retry_after(error)
            return "later"
        except Exception:
            return "later"

    async def _run(self) -> None:
        o = self._options
        attempt = 0
        first = True
        renewed = False  # one renewal per refusal: a token refused again right after ends it
        filtered = False
        while not self._done:
            self._state("connecting" if first else "reconnecting")
            first = False
            end = "dropped"
            used = self._config.get_token() if self._config.get_token else self._config.token
            try:
                session = await WsSession.open(self._config)
                if self._done:
                    await session.close()
                    return
                self._session = session
                finished: asyncio.Future[str] = asyncio.get_running_loop().create_future()

                def settle(value: str) -> None:
                    if not finished.done():
                        finished.set_result(value)

                def on_frame(frame: dict[str, Any]) -> None:
                    nonlocal attempt, renewed, filtered
                    kind = frame.get("type")
                    if kind == "subscribed":
                        attempt = 0
                        renewed = False
                        self.filter = frame.get("filter")
                        profile = (frame.get("filter") or {}).get("profile")
                        filtered = profile is not None and profile != "all"
                        self._state("live")
                    elif kind == "event":
                        event = frame["event"]
                        sequence = int(event["sequence"])
                        if sequence <= self.last_sequence:
                            return  # already delivered
                        if not filtered and sequence != self.last_sequence + 1:
                            # Something was skipped: start over from what we have rather than skip it.
                            asyncio.ensure_future(session.close())
                            return
                        self._deliver(event)
                    elif kind == "resync_required":
                        asyncio.ensure_future(session.close())
                    elif kind == "error":
                        error = frame_error(frame)
                        if error.code == "UNAUTHENTICATED":
                            settle("expired")
                            asyncio.ensure_future(session.close())
                        elif error.retryable:
                            self._retry_after = _retry_after(error)
                            asyncio.ensure_future(session.close())
                        else:
                            self._failure = error
                            settle("fatal")

                def on_close(code: int, _reason: str) -> None:
                    settle("expired" if code == CLOSE_UNAUTHENTICATED else "fatal" if code == CLOSE_NOT_FOUND else "dropped")

                session.on_frame(on_frame)
                session.on_close(on_close)
                subscribe: dict[str, Any] = {"type": "subscribe", "after": self.last_sequence}
                if o.profile:
                    subscribe["profile"] = o.profile
                if o.types:
                    subscribe["types"] = list(o.types)
                if o.scopes:
                    subscribe["scopes"] = dict(o.scopes)
                await session.send(subscribe)
                end = await finished
                if end == "fatal" and self._failure is not None:
                    await self._finish(self._failure)
                    return
            except CrossoverError as error:
                if error.retryable:
                    self._retry_after = _retry_after(error)
                elif error.code == "UNAUTHENTICATED":
                    # The access token expired: renew it and connect again at once.
                    outcome = "refused" if renewed else await self._renew(used)
                    if outcome == "renewed":
                        renewed = True
                        continue
                    if outcome == "refused":
                        await self._finish(error)
                        return
                    end = "dropped"  # "later": back off below
                else:
                    await self._finish(error)
                    return
            except TransportError as error:
                if not error.retryable:
                    await self._finish(error)
                    return
            except (OSError, websockets.WebSocketException):
                pass
            self._session = None
            if self._done:
                return
            if end == "expired" and not renewed:
                outcome = await self._renew(used)
                if outcome == "renewed":
                    renewed = True
                    continue
                if outcome == "later":
                    end = "dropped"
            if end in ("fatal", "expired"):
                await self._finish(CrossoverError("UNAUTHENTICATED", "The subscription can't continue"))
                return
            attempt += 1
            wait = min(o.reconnect_max_s, o.reconnect_min_s * 2 ** (attempt - 1))
            asked, self._retry_after = self._retry_after, None
            await asyncio.sleep(asked if asked is not None else wait / 2 + random.random() * (wait / 2))

    def __aiter__(self) -> AsyncIterator[dict[str, Any]]:
        return self._iterate()

    async def _iterate(self) -> AsyncIterator[dict[str, Any]]:
        while True:
            item = await self._queue.get()
            if item is _END:
                self._queue.put_nowait(_END)  # stays ended for another reader
                if self._failure is not None:
                    raise self._failure
                return
            yield item
