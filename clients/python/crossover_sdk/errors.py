"""Errors, the same two families as the TypeScript SDK."""

from __future__ import annotations

from typing import Any, Mapping


class CrossoverError(Exception):
    """An error the server answered with (the §16.3 body): `code`, `retryable`, `details`."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        retryable: bool = False,
        details: Mapping[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable
        self.details: dict[str, Any] = dict(details or {})

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"CrossoverError({self.code!r}, {self.message!r}, retryable={self.retryable})"


class TransportError(Exception):
    """The server couldn't be reached, or answered with something that isn't the protocol."""

    def __init__(self, message: str, *, retryable: bool, status: int | None = None) -> None:
        super().__init__(message)
        self.retryable = retryable
        self.status = status


def error_from_body(body: Any, status: int) -> CrossoverError | TransportError:
    """The error a §16.3 body describes."""
    error = body.get("error") if isinstance(body, dict) else None
    if isinstance(error, dict) and isinstance(error.get("code"), str) and isinstance(error.get("message"), str):
        details = error.get("details")
        return CrossoverError(
            error["code"],
            error["message"],
            retryable=error.get("retryable") is True,
            details=details if isinstance(details, dict) else None,
        )
    return TransportError(f"Unexpected response (HTTP {status})", retryable=status >= 500, status=status)
