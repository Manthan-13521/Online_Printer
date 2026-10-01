# D1 usage optimization report

Generated: 2026-10-01

Repository baseline: `main` at `e9d97eeb88f2b017bfe21a0fed0d373fe92e4f34`

Cloudflare D1: `printgo-production` (`81bc9e6b-6e65-4a8a-85dd-4440484482ff`)
Wrangler: `4.138.0`

## 1. Scope and evidence rules

This pass investigated and locally optimized D1 reads, writes, query executions,
and polling-driven Worker requests without deploying, applying production
migrations, mutating production data, creating real payments, deleting production
files, or physically printing.

Evidence labels used throughout:

- **MEASURED CLOUD**: read-only `wrangler d1 insights` results from the configured
  production D1 database. These are the authoritative before-values for D1 row
  accounting.
- **MEASURED LOCAL**: actual Worker handlers or SQL executed against local SQLite
  fixtures. These establish behavior, query plans, relative timing, statement
  counts, and table changes. They are not Cloudflare billing metrics.
- **SIMULATED**: local mocked Razorpay, R2, spooler, or traffic behavior.
- **MODELED**: arithmetic projection with stated assumptions.
- **NOT VERIFIED**: requires a deployment, production window, Windows host, or
  physical printer.

The dirty working tree containing the multi-file, cleanup, and branding work was
preserved. No reset, checkout, migration rewrite, or unrelated reformat was used.

Cloudflare references used:

- [D1 metrics and Query Insights](https://developers.cloudflare.com/d1/observability/metrics-analytics/)
- [D1 pricing and row accounting](https://developers.cloudflare.com/d1/platform/pricing/)
- [D1 index, partial-index, and query-plan guidance](https://developers.cloudflare.com/d1/best-practices/use-indexes/)
- [`PRAGMA optimize`](https://developers.cloudflare.com/d1/sql-api/sql-statements/#pragma-optimize)
- [D1 prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/)

## 2. Executive result

### Excessive reads

The five-second Agent pulse was **not** the primary read source. In the captured
one-day Query Insights window:

- The Agent credential/work probe averaged **6 rows read** and ran 825 times,
  totaling **5,653 rows read**.
- The two scheduled cleanup preview queries totaled **239,150 rows read**:
  - expired unpaid preview: 146,217 total / 622 average / 235 executions;
  - completed-due preview: 92,933 total / 352 average / 264 executions.
- Those two previews were 75.89% of the rows represented by the top-30 read
  result set. This percentage is not a percentage of all account usage.

The previews ran before the deduplication check. Therefore an already open
`PENDING`, `RUNNING`, or `PARTIAL` cleanup run did not prevent the five-minute
cron from rescanning and recounting the same due rows.

Local `EXPLAIN QUERY PLAN` found three temporary B-trees and sixteen correlated
subquery nodes in each preview shape. The repeated active-print and active-payment
checks were multiplied through four aggregate expressions.

### Excessive writes

The captured top write contributors were:

1. Printer transitions to `OFFLINE`: 2,256 rows written across 752 executions.
2. Cleanup-run failure updates: 2,166 rows across 1,083 executions.
3. Cleanup-run-item upserts: 2,136 rows across 1,060 executions.
4. Cleanup-item failure updates: 2,056 rows across 1,028 executions.
5. Order cleanup claims: 1,058 rows across 1,058 executions.

Cleanup operations accounted for 57.55% of the rows represented by the top-30
write result set. A failed cleanup item remained `FAILED`, was selected again on
the next five-minute cron, and rewrote both the item and parent run on every
failure. There was no retry schedule.

Printer `OFFLINE` writes are real but their cause is not fully attributable from
D1 alone. They indicate reported printer inventory/state changes or overlapping
reports. Suppressing those transitions could make readiness unsafe, so this pass
adds only a database no-op guard. Windows logs are required before changing the
state model.

## 3. End-to-end D1 flow

| Stage                        | Primary D1 work                                               | Frequency                              | Safety role                            |
| ---------------------------- | ------------------------------------------------------------- | -------------------------------------- | -------------------------------------- |
| Customer config              | Installation, rates, size bands                               | Page/session                           | Server pricing and limits              |
| Draft                        | Order, legacy upload, first `order_files` row                 | Per order                              | Draft ownership and retention          |
| Direct upload                | No PDF through Worker; completion checks R2 and updates D1    | Per file                               | Private R2 integrity                   |
| Quote                        | File list, pricing configuration, order/file totals           | Per quote                              | Server-authoritative price             |
| Payment creation             | Draft/readiness, payment attempt, event                       | Per attempt                            | Provider/order binding                 |
| Payment verification/webhook | Provider event, payment, order, tracking, queue events        | Per delivery/retry                     | HMAC, idempotency, capture proof       |
| Agent pulse                  | Credential, installation flag, pending command/work existence | Every five seconds                     | Auth and low-latency discovery         |
| Claim                        | Eligibility, lease, attempt, steps, forensic event            | Per file/attempt                       | Fencing and duplicate-print prevention |
| Print execution              | Start, spool ID, result, order/file/attempt events            | Per step                               | At-most-once physical boundary         |
| Customer tracking            | Credentialed order plus safe timeline                         | 15–30 seconds while active             | Private status visibility              |
| Admin                        | Session, dashboard, printers, Live Orders                     | Visible pages only                     | Shop operations                        |
| Retention                    | Bounded upload and PII candidate selection                    | Five-minute cron                       | Privacy lifecycle                      |
| Disposable cleanup           | Scheduled/admin run, claims, retained payment records         | Five-minute scheduler / explicit admin | Safe R2+D1 reclamation                 |

## 4. Static D1 inventory

The source audit found approximately 236 static `.prepare()` call sites. Dynamic
statements created inside bounded file/cleanup loops are counted once here.

| Area                 | Static prepare sites | Idle/per-order behavior                                  | Main existing indexes                                                |
| -------------------- | -------------------: | -------------------------------------------------------- | -------------------------------------------------------------------- |
| Agent repository     |                   40 | Pulse, minute liveness, printer delta, diagnostics       | credential unique index; command agent/status; printer agent/enabled |
| Admin authentication |                    8 | One indexed session lookup per Admin request             | session token unique; admin/expiry                                   |
| Branding             |                    4 | Public/admin logo reads and updates                      | installation PK                                                      |
| Cleanup              |  29 before this pass | Five-minute scheduled probes; per-order purge            | cleanup due indexes; run status; run item PK                         |
| Dashboard            |      3 count queries | Visible every 30 seconds                                 | order status/updated and status/completed                            |
| Configuration        |                    7 | Dashboard/customer/settings changes                      | small bounded configuration tables                                   |
| Customer orders      |                   29 | Draft, file, quote, upload lifecycle                     | token, order/file position, upload order                             |
| Payment readiness    |                    3 | Checkout/payment gate                                    | agent/printer/order state indexes                                    |
| Payment repository   |                   30 | Attempt, verify, webhook, queue                          | provider IDs; order/status; idempotency keys                         |
| Printing repository  |                   65 | Pulse claim/recovery and per-step writes                 | agent/status, attempt/order, step/order/status                       |
| Retention            |                   14 | Five-minute bounded candidates; writes only for due work | partial upload due and PII due indexes                               |
| Tracking             |                    4 | Active customer polling                                  | job code/token and order event timeline                              |

Repository routes instantiate these repositories but do not contain hidden schema
creation. No request-path `CREATE INDEX` was found.

## 5. Cloud Query Insights: top contributors

Raw read-only captures are stored under
`docs/evidence/d1-usage-optimization/cloud/`. Query parameters are omitted by
Cloudflare.

### Top 10 by total rows read

| Rank | Query family                    | Total rows read | Average | Executions |
| ---: | ------------------------------- | --------------: | ------: | ---------: |
|    1 | Expired-unpaid cleanup preview  |         146,217 |     622 |        235 |
|    2 | Completed-due cleanup preview   |          92,933 |     352 |        264 |
|    3 | Claim cleanup order             |           6,348 |       6 |      1,058 |
|    4 | Upsert cleanup run item         |           6,328 |       5 |      1,060 |
|    5 | Agent authentication/work probe |           5,653 |       6 |        825 |
|    6 | Multi-file print eligibility    |           5,200 |      36 |        141 |
|    7 | Fetch claimed cleanup files     |           4,680 |      20 |        234 |
|    8 | Legacy print eligibility        |           3,546 |      18 |        197 |
|    9 | Admin printer inventory         |           3,402 |      18 |        189 |
|   10 | Admin session lookup            |           3,018 |       2 |      1,509 |

### Top 10 by total rows written

| Rank | Query family                              | Total rows written | Average | Executions |
| ---: | ----------------------------------------- | -----------------: | ------: | ---------: |
|    1 | Mark missing printer OFFLINE              |              2,256 |       3 |        752 |
|    2 | Record cleanup run failure                |              2,166 |       2 |      1,083 |
|    3 | Upsert cleanup run item                   |              2,136 |       2 |      1,060 |
|    4 | Record cleanup item failure               |              2,056 |       2 |      1,028 |
|    5 | Claim cleanup order                       |              1,058 |       1 |      1,058 |
|    6 | Older unconditional Agent liveness update |                352 |       2 |        176 |
|    7 | Insert provider event                     |                308 |       5 |         52 |
|    8 | Mark cleanup run running                  |                304 |       2 |        152 |
|    9 | Move print attempt to submitting          |                268 |       4 |         67 |
|   10 | Insert payment attempt                    |                231 |       7 |         33 |

The capture includes query shapes from more than one deployed build. The current
source uses a conditional one-minute Agent liveness write; the older unconditional
heartbeat query is not reintroduced.

### Top 10 by execution count

| Rank | Query family                    | Executions | Average rows read/written |
| ---: | ------------------------------- | ---------: | ------------------------: |
|    1 | Admin session lookup            |      1,509 |                     2 / 0 |
|    2 | Latest diagnostic command       |      1,160 |                     1 / 0 |
|    3 | Record cleanup run failure      |      1,083 |                     2 / 2 |
|    4 | Upsert cleanup run item         |      1,060 |                     5 / 2 |
|    5 | Claim cleanup order             |      1,058 |                     6 / 1 |
|    6 | Record cleanup item failure     |      1,028 |                     2 / 2 |
|    7 | Printer-by-ID lookup            |        885 |                     1 / 0 |
|    8 | Agent authentication/work probe |        825 |                     6 / 0 |
|    9 | Mark missing printer OFFLINE    |        752 |                     2 / 3 |
|   10 | Default-printer lookup          |        476 |                     1 / 0 |

## 6. Changes implemented locally

### 6.1 Scheduled cleanup gates

Before calculating a full scheduled preview, cleanup now:

1. checks for an already open scheduled run;
2. returns immediately if one exists;
3. otherwise performs an indexed `SELECT 1 ... LIMIT 1` candidate probe;
4. calculates the full preview only if a run can actually be created.

This preserves the full Admin preview and the run's selected-order/file/byte
counts while removing repeated scheduled recounts.

### 6.2 Failure retry backoff

`cleanup_run_items` now records `attempt_count` and `next_attempt_at_ms`.
Failed external cleanup is retried after 5, 10, 20, 40, and 60 minutes, then at
most hourly. The item is never silently abandoned.

The parent run is no longer updated to `RUNNING` before a due candidate exists.
Therefore cron ticks during backoff are read-only.

Scheduler ordering gives pending items and due retries priority over an older
partial run whose only failures are still backing off. This prevents retry
backoff from starving a newer cleanup run.

### 6.3 Partial index

Migration `0013_d1_usage_optimization.sql` adds:

```sql
CREATE INDEX cleanup_runs_open_scope_idx
  ON cleanup_runs(scope, source, created_at_ms)
  WHERE status IN ('PENDING','RUNNING','PARTIAL');
```

Only open runs are indexed. Completed historical runs do not grow the index.
`PRAGMA optimize` is included after the schema/index changes, following current
Cloudflare guidance.

### 6.4 Printer no-op guard

The missing-printer update now includes `AND status <> 'OFFLINE'`. The existing
in-memory comparison remains. This prevents a stale or overlapping write from
rewriting an already-offline row without suppressing real ONLINE→OFFLINE safety
transitions.

### 6.5 Measurement harness compatibility

The synthetic workload now uses the current multi-file quote and upload-complete
contracts when `fileId` is present. This fixes the audit harness without changing
customer production behavior.

## 7. Before/after evidence

| Operation                        | Before                                                                                   | After local implementation                                                                 | Cloud after      |
| -------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------- |
| Expired cleanup with open run    | 622 average cloud rows read; local preview 1.23 ms; 3 temp B-trees + 16 correlated nodes | `SEARCH cleanup_runs USING INDEX cleanup_runs_open_scope_idx`; 0.00698 ms local average    | **NOT VERIFIED** |
| Completed cleanup with open run  | 352 average cloud rows read; local preview 1.42 ms; 3 temp B-trees + 16 correlated nodes | Same indexed open-run gate; 0.00658 ms local average                                       | **NOT VERIFIED** |
| Empty expired candidate probe    | Full aggregate preview                                                                   | `SEARCH ... orders_unpaid_cleanup_due_idx (draft_expires_at_ms<?)` after `PRAGMA optimize` | **NOT VERIFIED** |
| Empty completed candidate probe  | Full aggregate preview                                                                   | `SEARCH ... orders_completed_cleanup_due_idx (purge_at_ms...)` after `PRAGMA optimize`     | **NOT VERIFIED** |
| Failed cleanup before next retry | Rewrites item and run every five minutes                                                 | Local regression: zero changed rows before `next_attempt_at_ms`                            | **NOT VERIFIED** |
| Missing printer already OFFLINE  | Source comparison only                                                                   | Source comparison plus database predicate                                                  | **NOT VERIFIED** |

The local benchmark used 600 orders and 600 file rows: 200 expired unpaid, 200
completed due, and 200 active queued. Timings are relative SQLite evidence and
must not be interpreted as D1 billing savings.

A point model in which each open-run gate costs one D1 row would replace the
captured 239,150 preview rows with roughly 499 gate rows in that same query-count
window. This is **MODELED**, not an after measurement, and is not used as a
production claim.

## 8. Polling and heartbeat analysis

### Agent

- Five-second discovery is retained.
- Cloud before: the combined credential/config/test/work probe averaged six rows
  and zero writes.
- Local 10-minute idle: 120 Agent requests, 134 SQL statements, 120 returned
  rows, and 10 changed Agent rows.
- Eleven of every twelve normal pulses cause zero table writes; the deliberate
  liveness interval writes once per minute.
- A 15-hour local simulation produced 10,800 requests, 12,060 statements,
  10,800 returned rows, and 900 changed liveness rows.

No job-state cache, wider poll interval, or event-driven architecture was added.

### Admin

The shared poller already enforces one in-flight request, hidden-tab suspension,
cleanup on unmount, and immediate visible refresh.

Empty-shop local samples:

| Page request | Statements | Returned rows | Changed rows |
| ------------ | ---------: | ------------: | -----------: |
| Dashboard    |         10 |            17 |            0 |
| Printers     |          6 |            13 |            0 |
| Live Orders  |          2 |             1 |            0 |

Live Orders averaged only 11 cloud rows per call, so its correlated latest-attempt
lookup was not rewritten. Dashboard count queries were not top Query Insights
contributors; consolidating them could replace selective indexed counts with a
broader scan. Both remain measurement-backed non-changes.

### Customer tracking

Tracking already uses one in-flight request, stops while hidden, backs off from
15 to 30 seconds, and permanently stops after terminal order states. No change
was justified.

## 9. Payment, webhook, and print safety

No durable transition was removed. The following remain intact:

- HMAC/provider verification and webhook event idempotency;
- payment-attempt and verified-capture state;
- queue and claim fencing;
- `SUBMISSION_STARTED` before the Windows side effect;
- exact spool ID persistence;
- blocked/failed/uncertain distinction;
- attempt, step, order, file, and forensic events;
- no blind resubmission of ambiguous physical work.

The controlled local one-order and ten-order runs completed all orders with zero
duplicate attempts. They measured 38 changed table rows per normal one-file
order. The profile shows these rows are upload, quote, payment, tracking, claim,
step, spool, completion, retention, and forensic boundaries. They were retained.

## 10. Controlled usage tests

| Test                                     | Result                                                                                                                                                                                                | Evidence                                   |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| A: Agent off, Admin closed, 10 minutes   | No local invocations means zero local D1 work. A controlled cloud window was not executed because stopping external clients was outside this pass.                                                    | LOCAL / cloud **NOT VERIFIED**             |
| B: Agent on, no orders/Admin, 10 minutes | 120 HTTP; 134 statements; 120 returned rows; 10 changed liveness rows                                                                                                                                 | **MEASURED LOCAL**                         |
| C: Agent plus Dashboard visible          | Individual Agent and Dashboard handlers measured. A 10-minute additive projection is 140 HTTP, 334 statements, 460 returned rows, and 10 changed rows; browser timing was not replayed against cloud. | **MODELED from MEASURED LOCAL components** |
| D: One controlled order                  | 11 HTTP; 106 statements; 125 returned rows; 38 changed rows; R2 A=1, B-like local operations=4; completed=1; duplicate attempts=0                                                                     | **MEASURED LOCAL**                         |
| E: Ten controlled orders                 | 110 HTTP; 1,060 statements; 1,250 returned rows; 380 changed rows; R2 A=10, B-like local operations=40; completed=10; duplicate attempts=0                                                            | **MEASURED LOCAL**                         |

Tests D/E used SQLite, in-memory R2, mocked Razorpay, and synthetic spool IDs.
They are not payment-provider, Windows, physical-print, or D1 billing evidence.

## 11. Usage projections and headroom

The existing conservative capacity model remains intentionally unchanged because
the new code has not been deployed and its D1 after-metadata is unavailable.

| Scenario           |       Worker requests |                                                         D1 reads |                                                 D1 writes | Free headroom: requests / reads / writes |
| ------------------ | --------------------: | ---------------------------------------------------------------: | --------------------------------------------------------: | ---------------------------------------- |
| 15-hour Agent idle | 10,800 Agent requests | Existing conservative model includes 131,220 Agent+cleanup reads | Existing conservative model includes 2,700 indexed writes | **MODELED**                              |
| 50 orders/day      |                18,263 |                                                          616,040 |                                                    14,450 | 81.74% / 87.68% / 85.55%                 |
| 100 orders/day     |                19,875 |                                                          742,840 |                                                    25,700 | 80.13% / 85.14% / 74.30%                 |

These values use the repository's padded `efficiencyBudget` assumptions,
including 221 modeled indexed D1 writes per order. The controlled local workload
measured 38 changed table rows per one-file order, not 221 D1 rows written. No
conversion between those values is claimed.

The observed cleanup incident is not subtracted from the model. Once migration
and Worker changes are separately deployed, repeat Tests A–E and replace these
projections with deployed `rows_read`/`rows_written` deltas.

## 12. Index decisions

### Added

- `cleanup_runs_open_scope_idx`: justified by five-minute open-run checks and
  excludes terminal history.

### Intentionally not added

- Another Agent work index: the hot probe averaged six reads and existing status
  indexes are in use.
- Live Orders replacement index: average cost was 11 rows/read execution.
- Dashboard-count index: current status/completed indexes already match the
  filters; the counts were not material Query Insights contributors.
- Extra cleanup-item retry index: the existing `(run_id,status,updated_at_ms)`
  index narrows the small open run; another index would add writes on every item
  transition without proven read benefit.
- Full-history active-order index: existing partial due indexes become selected
  after planner statistics are refreshed.

No existing index was removed.

## 13. Risks and remaining verification

1. **Cloud after-values are NOT VERIFIED.** Nothing was deployed and migration
   `0013` was not applied remotely.
2. **Printer OFFLINE flapping is NOT VERIFIED.** Query Insights proves the writes,
   not whether Windows discovery, real unplugging, multiple Agent binaries, or
   overlapping reports caused them. Windows Agent logs and binary identity are
   required before changing readiness semantics.
3. Cleanup retry backoff can leave an already-failed external deletion pending
   for up to one hour after repeated failures. It does not extend the logical
   privacy/access deadline and follows the existing retention retry cap.
4. New cleanup candidates arriving after an open run's cutoff wait for that run
   to drain, then are picked up by a later cron. This preserves deterministic run
   membership.
5. The new partial index adds maintenance only while cleanup runs are open. Its
   deployed write cost is not yet measured.
6. Native Windows packaging, CIM behavior, SumatraPDF, spool observation,
   physical output, and restart recovery remain **PHYSICAL/WINDOWS VERIFICATION:
   PENDING**.

## 14. Optional future architecture

Durable Objects with hibernating WebSockets are not recommended for this pass.
The measured Agent probe is small, while scheduled cleanup was the dominant read
source. Reconsider push notification only if deployed after-measurements show
optimized polling still dominates Worker requests or D1 rows and a compatible
old/new Agent rollout plus offline recovery design is available.

## 15. Reproduction commands

Read-only cloud capture:

```bash
pnpm --filter @printgo/worker exec wrangler whoami
WRANGLER_SEND_METRICS=false WRANGLER_HIDE_BANNER=true \
  pnpm --filter @printgo/worker exec wrangler d1 list --json
node scripts/capture-d1-insights.mjs
```

Local evidence:

```bash
node scripts/d1-usage-audit.mjs
node scripts/runtime-cost-audit.mjs
node scripts/d1-controlled-usage.mjs
```

Validation:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm db:validate
pnpm build
pnpm build:agent:windows
node scripts/calculate-free-tier-capacity.mjs
```

Completed validation on 2026-10-01:

- `pnpm test`: 72 test files passed; 554 tests passed and 1 skipped.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed with zero warnings.
- `pnpm format:check`: passed.
- `pnpm db:validate`: passed with all 23 tables present.
- `pnpm build`: passed; the customer build retained its existing bundle-size
  warning.
- `pnpm build:agent:windows`: Mac-side bundle and SEA preparation passed; a
  native Windows executable and physical printing were not verified.
- `node scripts/calculate-free-tier-capacity.mjs`: passed and produced the
  modeled projections reported above.

## 16. Evidence files

- `docs/evidence/d1-usage-optimization/cloud/metadata.json`
- `docs/evidence/d1-usage-optimization/cloud/reads.json`
- `docs/evidence/d1-usage-optimization/cloud/writes.json`
- `docs/evidence/d1-usage-optimization/cloud/count.json`
- `docs/evidence/d1-usage-optimization/local/query-plan-and-gate-benchmark.json`
- `docs/evidence/d1-usage-optimization/local/controlled-orders.json`
- `docs/evidence/runtime-cost/runtime-cost.json`

## 17. Concise answers

1. **Excessive reads:** scheduled cleanup previews repeatedly scanned and
   recounted due history even while an existing cleanup run was already open.
2. **Excessive writes:** repeated failed cleanup retries and printer OFFLINE
   transitions dominated the captured writes. The exact printer cause requires
   Windows evidence.
3. **Changed:** open-run/candidate gates, partial open-run index, cleanup retry
   schedule, no-work no-write behavior, database OFFLINE no-op guard, current
   audit harnesses, and this report.
4. **Before versus after:** cloud before is measured; local query plans/timings
   and no-write backoff are measured; cloud after is not verified.
5. **Expected 15-hour idle:** 10,800 Agent requests and 900 local liveness row
   changes; conservative D1 model remains 131,220 reads / 2,700 writes.
6. **Expected 50 orders/day:** modeled 616,040 reads / 14,450 writes.
7. **Expected 100 orders/day:** modeled 742,840 reads / 25,700 writes.
8. **Free-tier headroom at 100/day:** modeled 85.14% reads and 74.30% writes.
9. **Still not verified:** deployed after-usage, exact printer-flapping cause,
   Windows/native packaging, physical printing, and live payment/provider flow.
