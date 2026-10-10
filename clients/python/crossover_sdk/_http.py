"""POST JSON with the same retry rules as the TypeScript SDK."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any, Mapping

import httpx

from .errors import TransportError, error_from_body


@dataclass(frozen=True)
class RetryOptions:
    #: Total tries for a request, the first included.
    attempts: int = 4
    #: First wait in seconds, doubled each time and capped at `max_s`.
    base_s: float = 0.2
    max_s: float = 5.0


def _retryable_status(status: int) -> bool:
    return status in (429, 502, 503, 504)


async def post_json(
    http: httpx.AsyncClient,
    url: str,
    token: str | None,
    body: Mapping[str, Any],
    retry: RetryOptions = RetryOptions(),
) -> tuple[int, Any]:
    """POST JSON and parse the answer. The same body goes out on every try, so a mutating
    command's idempotency key makes a retry safe: a lost response, a dropped connection, a 429
    with `Retry-After` or a 503 is retried; anything else is final."""
    payload = json.dumps(body)
    headers = {"content-type": "application/json"}
    if token:
        headers["authorization"] = f"Bearer {token}"
    attempt = 0
    while True:
        attempt += 1
        response: httpx.Response | None = None
        failure: Exception | None = None
        try:
            response = await http.post(url, content=payload, headers=headers)
        except httpx.HTTPError as error:
            failure = error
        if response is not None:
            try:
                parsed: Any = response.json() if response.content else None
            except ValueError:
                parsed = None
            errored = response.status_code >= 400 or (isinstance(parsed, dict) and "error" in parsed)
            if not errored:
                return response.status_code, parsed
            if _retryable_status(response.status_code) and attempt < retry.attempts:
                asked: float | None = None
                try:
                    value = float(response.headers.get("retry-after", ""))
                    asked = value if value > 0 else None
                except ValueError:
                    asked = None
                # A server that says "come back in an hour" isn't waited for: the caller gets the
                # error (its details carry `retry_after`) and decides.
                if asked is not None and asked > retry.max_s:
                    raise error_from_body(parsed, response.status_code)
                await asyncio.sleep(asked if asked is not None else min(retry.max_s, retry.base_s * 2 ** (attempt - 1)))
                continue
            raise error_from_body(parsed, response.status_code)
        if attempt >= retry.attempts:
            raise TransportError("Couldn't reach the server", retryable=True) from failure
        await asyncio.sleep(min(retry.max_s, retry.base_s * 2 ** (attempt - 1)))
