"""Python SDK for the Crossover Room Protocol (REST and WebSocket)."""

from ._catalog import METHODS, PROTOCOL_VERSION
from ._http import RetryOptions
from ._types import CommandResult
from .client import CrossoverClient, RoomClient, SocketClient
from .errors import CrossoverError, TransportError
from .tokens import RoomTokens
from .ws import RoomSocket, SubscribeOptions, Subscription

__all__ = [
    "METHODS",
    "PROTOCOL_VERSION",
    "CommandResult",
    "CrossoverClient",
    "CrossoverError",
    "RetryOptions",
    "RoomClient",
    "RoomSocket",
    "RoomTokens",
    "SocketClient",
    "SubscribeOptions",
    "Subscription",
    "TransportError",
]
