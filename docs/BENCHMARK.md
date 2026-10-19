# Workspace benchmark

Start local PostgreSQL with `docker compose up -d` and build with `pnpm typecheck`, then run:

```sh
pnpm --filter @crossover/workspace bench
```

The default runs 200 measured dispatcher applies for each of two repositories (40 and 10,000 files). Every apply edits 20 existing files using full contents, from a stale base after a separate head edit. The edits affect separated lines on the same paths, so every measured merge must be clean and non-fast-forward. Fixture construction and head advancement are excluded. Both database reads and the refreshed search checkout are verified afterward. A fresh test database and temporary repository are removed on exit.

`merge` is the complete public `merge()` function, including binary detection; compare its p95 to 50 ms. `total_apply` includes validation, lease/policy/idempotency handling, the committed transaction and post-commit ref/checkout refresh; compare its p95 to 500 ms (§3). Percentiles use nearest rank, and timings are wall-clock milliseconds.

Stage timers are nested: binary detection is inside merge, and materialize/merge/treeChanges are inside the transaction. `db_transaction_other` subtracts those stages from transaction time; it includes remaining SQL, commit creation, ledger/idempotency work and instrumentation overhead, rather than measuring SQL alone. `after_commit` sums the real ref and checkout callbacks. Do not sum all inclusive stage percentiles.

For a smoke run use `BENCH_ITERATIONS=2`; full reports use the default 200. Set `BENCH_OUTPUT=/tmp/workspace-benchmark.json` to save the report. The benchmark runs separately from `pnpm check`; CI runs it as a non-blocking job and uploads its JSON report. Missing latency targets are reported, not asserted. The benchmark uses Vitest spies only; production code has no timing hooks.

This workload exercises full-content modifications, not patch index rebuilding or ignore-rule preparation for introduced paths. Performance findings for those paths need additional workloads.

## Conflict-rate report

`conflict_rate_report` (T1586) measures how often ChangeSets conflict, by participant kind (human, agent, system) and file extension, to show where syntax-aware merge would pay off. The server writes one JSON line per day to stdout (`CONFLICT_REPORT_INTERVAL_MS`, `0` turns it off). To read the same report for any window from the database in `DATABASE_URL` (or `.env`):

```sh
pnpm --filter @crossover/workspace conflict-report -- --since 2026-09-20 --until 2026-10-18 --format md
```

`--since` defaults to 28 days ago, `--until` to now, `--room <id>` (repeatable) limits it to rooms, and `--format json` prints the full report. It counts only: no paths, room ids, participant ids or content. A ChangeSet is contended when a real merge ran (it conflicted, or it applied more than one revision after its base); the conflict rate is conflicted divided by contended.
