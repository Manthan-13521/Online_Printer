# Phase 7 — local cost and performance checkpoint

Scope: commit `54219a5` to this checkpoint. No deployment, production data,
provider billing telemetry, Windows Agent process, physical printer, or real
payment was used. `returnedRows` and `changedRows` below are SQLite harness
proxies, **not** Cloudflare D1 billed `rows_read`/`rows_written`.

## 1. Biggest measured sources

- Idle Agent `/pulse`: 720 HTTP calls/hour/shop and 804 local SQL statements
  including 12 scheduled cleanup invocations. This dominates repeat traffic.
- Empty-shop Admin samples: dashboard 10 SQL statements, printer page 6, live
  orders 2 per visible poll; hidden tabs already make no calls. History already
  uses keyset pagination. Customer config is fetched once at boot, and tracking
  already stops on terminal/expired state and pauses while hidden.
- Controlled 10-paid-order workload: 110 HTTP calls, 1,300 local statements,
  390 changed table rows, R2 10 PUT / 20 HEAD / 20 GET / 0 DELETE before
  retention. These represent required payment/print boundaries, not idle noise.

## 2. Changes

- Agent idle cadence progressively backs off from 5 to 10, 20, then 30 seconds
  after no-work polls. Work/command response or printer recovery returns it to
  the responsive 5-second cadence; communication failures retain bounded retry.
- Blocked/unhealthy printer discovery and local health probe run every two
  minutes while `/pulse` continues every 30 seconds, safely inside the
  90-second server liveness threshold. The existing combined `/pulse` work and
  liveness API remains one request; no extra endpoint or service was added.
- Manual Admin orders now use 50-row keyset pages with one batched add-on
  snapshot lookup per page. The list still never fetches PDFs.
- The existing local efficiency audit had a stale 256-KiB oversize fixture;
  it now tests the current 1-MiB logo limit, without changing branding logic.

## 3. D1 plans and indexes

`scripts/phase7-query-plan-audit.mjs` records reproducible local SQLite plans in
`docs/evidence/phase7/query-plans.json`. Migration 0019 restores three access
paths lost when Phase 4 rebuilt `orders`, plus a partial manual-queue index:

| Access path         | Before                         | After                                                |
| ------------------- | ------------------------------ | ---------------------------------------------------- |
| Draft token         | Active-order index scan        | `orders_draft_token_lookup_idx` keyed search         |
| Unpaid due probe    | Status-index search            | `orders_unpaid_cleanup_due_idx` time-range search    |
| Completed due probe | Status-index search            | `orders_completed_cleanup_due_idx` time-range search |
| Manual queue        | Status search + temporary sort | Partial `orders_manual_queue_idx`, capped at 51 rows |

The two due scopes explicitly select their corresponding indexes for existence,
preview, claim, and remaining-work probes. Priority/next-job candidate and
retry paths use existing status indexes; pickup uses a unique pickup-code
index; active and retained history use created-time keyset indexes; daily
cleanup walks the active-order covering index in bounded batches. No new broad
index was added for priority/retry sorting because the local plans do not
justify the extra write/storage cost. Manual queue is a narrow index scan,
bounded by its page limit; daily cleanup likewise scans only its active-order
index and takes a bounded batch, not a full table or bucket listing.

## 4. Before versus after (local/modeled)

`scripts/runtime-cost-audit.mjs` executes the actual Worker handlers against
SQLite under fixed and adaptive **modeled Agent schedules**. Agent timing is
also verified with fake-timer tests; these are not production request counts.

| Idle window/shop | Agent requests before → after | SQL statements before → after | Changed rows before → after | Cron invocations |
| ---------------- | ----------------------------: | ----------------------------: | --------------------------: | ---------------: |
| 10 minutes       |                      120 → 22 |                      134 → 35 |                      10 → 9 |                2 |
| 1 hour           |                     720 → 122 |                     804 → 205 |                     60 → 59 |               12 |
| 15 hours         |                10,800 → 1,802 |                12,060 → 3,061 |                   900 → 899 |              180 |

Steady idle HTTP requests fall about 83%; local SQL statements about 75%.
The one-minute liveness write is intentionally preserved. With no due work,
each 5-minute scheduled cleanup contributes two indexed probes, zero table
writes, and zero R2 operations. Controlled 10-paid-order request and R2 counts
remain unchanged after the code change: 110 requests, 10 PUT / 20 HEAD /
20 GET / 0 DELETE before retention. In the existing completed-order local
stress workload, retention performs one R2 DELETE per PDF object key and no
bucket listing; 800 completed single-file orders yielded 800 DELETE operations.

For a defensible _linear workload model only_, one always-idle Agent/shop
means about 7,200 → 1,220 requests/hour across 10 shops, or 72,000 → 12,200
across 100 shops. This does not include real work, additional Agents, customer
traffic, Admin tabs, retries, or Cloudflare account/billing behavior. One
installation remains one shop; no multi-tenant architecture was introduced.

## 5. Verification and remaining gates

- Focused Agent, cleanup, and manual-order pagination tests passed; full test
  suite: 77 files, 649 passed, 1 skipped.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm db:validate`, and
  `pnpm build` passed after the local fixture and formatting corrections.
- Local runtime-cost, D1 controlled-usage, query-plan, and efficiency scripts
  were rerun; efficiency stress fixtures passed at 60, 800, and 1,000 orders.
- **NOT VERIFIED:** Cloudflare D1 billed rows/latency, actual request volume,
  Free-Tier headroom, R2 network/storage costs, Windows process scheduling,
  real-printer behavior, or provider behavior. Phase 8 regression/security and
  the separate Windows/printer acceptance pass remain future work.
- **Final hardware-test checklist:** explicitly force the race where Windows
  accepts a print job but the Agent loses its connection before the spooler
  job ID/state is safely persisted. Mocks cannot prove safe recovery from that
  window; inspect durable state and confirm there is no blind duplicate print.
