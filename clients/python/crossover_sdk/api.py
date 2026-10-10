"""The catalog as nested namespaces: `room.api.tasks.create({...})`."""

from __future__ import annotations

import keyword
from typing import Any, Awaitable, Callable, Mapping

from ._catalog import METHODS
from ._types import CommandResult

Caller = Callable[[str, Mapping[str, Any], "str | None"], Awaitable[CommandResult]]

_PREFIXES = {".".join(name.split(".")[:i]) for name in METHODS for i in range(1, len(name.split(".")))}


class _Node:
    __slots__ = ("_path", "_call")

    def __init__(self, path: str, call: Caller) -> None:
        self._path = path
        self._call = call

    def __getattr__(self, key: str) -> Any:
        if key.startswith("_"):
            raise AttributeError(key)
        # A catalog name that is a Python keyword is spelled with a trailing underscore: `git.import_`.
        if key.endswith("_") and keyword.iskeyword(key[:-1]):
            key = key[:-1]
        nxt = f"{self._path}.{key}" if self._path else key
        if nxt in METHODS and nxt in _PREFIXES:
            return _CallableNode(nxt, self._call)  # a command that is also a namespace
        if nxt in METHODS:
            call = self._call

            def method(
                params: Mapping[str, Any] | None = None, *, idempotency_key: str | None = None
            ) -> Awaitable[CommandResult]:
                return call(nxt, params or {}, idempotency_key)

            method.__name__ = key
            return method
        if nxt in _PREFIXES:
            return _Node(nxt, self._call)
        raise AttributeError(f"{nxt!r} is not in the Room Protocol catalog")

    def __dir__(self) -> list[str]:
        prefix = f"{self._path}." if self._path else ""
        return sorted({n[len(prefix):].split(".")[0] for n in [*METHODS, *_PREFIXES] if n.startswith(prefix)})


class _CallableNode(_Node):
    """`sandbox.exec(...)` runs the command; `sandbox.exec.cancel(...)` is another one under it."""

    __slots__ = ()

    def __call__(self, params: Mapping[str, Any] | None = None, *, idempotency_key: str | None = None) -> Awaitable[CommandResult]:
        return self._call(self._path, params or {}, idempotency_key)


def make_api(call: Caller) -> Any:
    """Every Room Protocol method of the catalog as an awaitable call. Only methods of the catalog
    exist: anything else is an `AttributeError`, like a misspelled attribute."""
    return _Node("", call)
