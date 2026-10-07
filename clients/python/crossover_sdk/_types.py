from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class CommandResult:
    """What a command gives back (§16.2)."""

    response: Any
    events: list[dict[str, Any]] = field(default_factory=list)
    #: True when an idempotent duplicate returned the stored result and nothing ran again.
    replayed: bool = False
    #: A secret handed over exactly once (an invite token, a join's tokens).
    one_time: Any = field(default=None, repr=False)
