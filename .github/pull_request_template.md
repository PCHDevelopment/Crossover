<!-- Title: [Txxx] Short description -->

## Acceptance criteria → tests

<!-- One line per acceptance criterion in docs/BACKLOG.md, naming the test that proves it. A criterion without a test is not done. -->

-

## Sabotage checks

<!-- For each guard you added: what you broke on purpose, and which test failed. -->

-

## Validation

- [ ] `GIT_CONFIG_GLOBAL=/dev/null pnpm check` passes locally (test count: )
- [ ] CI run on the final head is green (link or run ID: ). Docker-dependent tests only run in CI.
- [ ] New command modules are registered in `apps/server/src/compose.ts`, with an end-to-end test under `apps/server/src/e2e/`
- [ ] Every new read or stream surface applies the participant view (`redactEventFor` or per-path redaction, ARCHITECTURE §34.5)

## Not in this PR

<!-- Anything deliberately left to a later task. -->
