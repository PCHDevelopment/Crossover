# Crossover

The collaboration platform for humans and agents.

- [Architecture](docs/ARCHITECTURE.md): what we're building (v0.2)
- [Engineering guide](docs/ENGINEERING.md): workflow, stack, code standards, local setup
- [Backlog](docs/BACKLOG.md): Phase 1 tasks with specs and owners
- [Lead reviews](docs/REVIEWS.md): periodic big-picture direction checks

## Deployment

Every deployment today is single-host mode: the app and sandboxes share one host through Docker. It is allowed only for one organisation whose users all trust each other, with `SANDBOX_RUNTIME=runsc` (gVisor) and the Docker socket reachable only by the server process. The Compose file and startup log say `single-host mode: not for multi-tenant or untrusted use (ARCHITECTURE §4.1)`. Separate sandbox hosts are required before any deployment where users do not trust each other (ARCHITECTURE §4.1). The Compose stack is for development and demos only and explicitly enables the local no-gVisor exception.
