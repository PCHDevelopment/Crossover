"""Command ids: `cmd_` plus a ULID, like the server's."""

from __future__ import annotations

import os
import time

_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def new_id(prefix: str) -> str:
    millis = int(time.time() * 1000)
    out = ""
    for _ in range(10):
        out = _ALPHABET[millis % 32] + out
        millis //= 32
    random = "".join(_ALPHABET[b % 32] for b in os.urandom(16))
    return f"{prefix}_{out}{random}"
