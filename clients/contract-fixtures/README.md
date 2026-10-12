# Shared API contract fixtures

These compact JSON documents describe the public HTTP and WebSocket wire shapes used by the
cross-language clients. They are shared test data, not responses captured from a running service;
tokens and IDs are synthetic. Keep client golden tests pointed at these files so protocol changes
can be checked without a live server.

The Go CLI tests use a local `httptest` server only to exercise HTTP and WebSocket transport. The
server sends these fixture bytes and does not start or contact the Crossover service.
