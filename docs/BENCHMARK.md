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

## Search benchmark

Search at scale (T1583, §9.5) is measured by two benchmarks that run together:

```sh
docker build -f apps/zoekt/Dockerfile -t crossover-zoekt:bench .
pnpm --filter @crossover/workspace bench:search
```

The workspace half (`packages/workspace/src/search.bench.ts`) builds one repository with `git fast-import`, seeded (`1583`): 50,000 files in all, about 1 GB: 49,990 text files of about 20 KiB plus ten single-line 1 MiB files in `big/`, `src/m<0..199>/f<0..249>.ts` with every twentieth slot a `docs/**.md`, `rare_token_<k>` in exactly three files for each k in 0..9, and `common_word` on about 1,000 lines. It is revision 1 of a room in a test database. It then:

1. Builds the whole Zoekt index (`index_build_ms`, plus `shard_bytes` and `repo_bytes`) with `ZoektIndexer` and the `crossover-zoekt:bench` image, and starts the webserver on `127.0.0.1:16070`.
2. Runs 20 queries (10 literal, 5 regex, 5 with a glob) 20 times each through `Dispatcher.dispatch("workspace.search")`, timed from dispatch to response. Mode `zoekt` uses the head backends `[zoekt, ripgrep]` and **fails if any run was served by another backend**; mode `ripgrep` uses `[ripgrep]`.
3. Applies 20 ChangeSets of 20 files each and measures the **index lag**: from the apply response until `/api/list` reports the new commit.
4. Runs mode `git_grep` last, on revision 1, which is no longer the head.

The memory half (`packages/kernel/src/modules/memory/search.bench.ts`) writes 5,000 entries (`topic<0..49>/note<0..99>`, 200 to 2,000 characters of Markdown), times `syncRoom` with the local `HashEmbeddingProvider` (256 dimensions), and runs 30 `memory.search` queries 20 times each, half of them under a `topic<n>/` prefix.

Targets, measured on the CI runner (`workflow_dispatch` of `search-benchmark` on the PR head): `workspace.search` p95 in mode `zoekt` ≤ 300 ms, full index build ≤ 300,000 ms, index lag p95 ≤ 30,000 ms, `memory.search` p95 ≤ 250 ms, `syncRoom` for 5,000 entries ≤ 60,000 ms. The reports list the targets with `*_met` flags; a miss is reported, not asserted, and ripgrep and git grep timings have no target. The JSON goes to `BENCH_OUTPUT` and `BENCH_OUTPUT_MEMORY`; CI uploads both as the artifact `search-benchmark`.

For a smoke run use `BENCH_FILES=500 BENCH_RUNS=2` (500 files, about 10 MiB, 2 runs; 5,000 memory entries stay unless `BENCH_MEMORY_ENTRIES` is set) and `ZOEKT_IMAGE=crossover-zoekt:test` if you have that image. A full run needs about 8 GiB of free disk and Docker. The job runs separately from `pnpm check`.

## Conflict-rate report

`conflict_rate_report` (T1586) measures how often ChangeSets conflict, by participant kind (human, agent, system) and file extension, to show where syntax-aware merge would pay off. The server writes one JSON line per day to stdout (`CONFLICT_REPORT_INTERVAL_MS`, `0` turns it off). To read the same report for any window from the database in `DATABASE_URL` (or `.env`):

```sh
pnpm --filter @crossover/workspace conflict-report -- --since 2026-09-20 --until 2026-10-18 --format md
```

`--since` defaults to 28 days ago, `--until` to now, `--room <id>` (repeatable) limits it to rooms, and `--format json` prints the full report. It counts only: no paths, room ids, participant ids or content. A ChangeSet is contended when a real merge ran (it conflicted, or it applied more than one revision after its base); the conflict rate is conflicted divided by contended.

### Structured-merge outcomes (T1592, `report_version` 2)

The report gains a `structured` block, read from what T1587 records on each ChangeSet: `structured_merges` on an APPLIED one (files a driver resolved) and `structured_merge_refusals` on a CONFLICT one (files a driver declined, with the reason).

- `resolved_changesets`: by participant kind, APPLIED ChangeSets with at least one file resolved by a driver. A structurally resolved ChangeSet is contended and not conflicted, so `conflict_rate` keeps its meaning.
- `resolved_files`: extension, then driver, then the number of files.
- `refusals`: by kind, then reason, one count per refused file record. `refusals_by_extension`: the same by extension.
- `saved_rate`: by kind, `resolved_changesets / (resolved_changesets + conflicted)` to four decimals; `null` when both are 0.
- `malformed`: stored values or entries not in the recorded shape. They are skipped and counted here, because the payload is history and is not trusted.

Rows from before T1587 have neither field and count as zero. Driver names and reasons come from fixed sets in the code; any other stored string is counted as `other` and never echoed. The `md` format adds a "Structured merge" table (resolved, conflicted and saved rate per kind) and a "Top refusal reasons" table (the 10 largest reason and kind pairs).
