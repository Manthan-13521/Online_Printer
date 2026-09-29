# Cloudflare runtime budget

Phase 2 reviewed 29 September 2026. One installation, one shop, one Worker, one D1 database, one private R2 bucket. No paid infrastructure or central licensing was added. No production deployment was performed.

## Official limits checked

| Resource        | Free allowance                                                         | Official source                                                              |
| --------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Worker requests | 100,000/day                                                            | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Worker CPU      | 10 ms/invocation, including Free cron invocations                      | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| D1 read rows    | 5,000,000/day                                                          | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)         |
| D1 written rows | 100,000/day; indexes add writes                                        | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)         |
| D1 storage      | 500 MB per Free database; 5 GB/account                                 | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)           |
| D1 queries      | 50/Worker invocation                                                   | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)           |
| R2 Standard     | 1 million Class A/month; 10 million Class B/month; 10 GB-month storage | [R2 pricing](https://developers.cloudflare.com/r2/pricing/)                  |

Allowances are shared with other work in the shop's Cloudflare account. Free infrastructure is not an unlimited resource guarantee.

## Measured code paths

The evidence directory contains real local handler/SQLite observations with mocked payment provider, R2 and spooler operations. Returned SQLite rows are **not** D1 billable rows scanned. Changed table rows are **not** D1 billable writes including index maintenance. Mac CPU and HTTP wall latency are **not** Worker CPU.

| Subsystem                | Runtime path and call cost                                                                                                                                                                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent idle               | One outbound request/5 seconds. An unchanged pulse uses one authenticated query with indexed command/work EXISTS probes; liveness UPDATE only when 60 seconds old.                                                                                                                 |
| Agent printer refresh    | Ready health every 60 seconds (30 seconds when unavailable); inventory/capabilities share a five-minute reconciliation. Fresh pre-submit health runs inside the existing submission process. Full cloud reports remain startup/change only.                                        |
| Agent printing           | Durable start → durable spool identity → result remain separate; local spooler polling/1 second in bounded 15-second observation windows. Confirmed success schedules the next work request immediately.                                                                           |
| Paused/unavailable Agent | 30-second cloud interval; network errors use jittered exponential backoff capped at 30 seconds; successful reconnection returns to fast polling.                                                                                                                                   |
| Admin Dashboard          | One aggregated endpoint/30 seconds while visible. Settings, agents, printer selection and indexed counts are returned together. No customer PII in dashboard response.                                                                                                             |
| Admin Live Orders        | 20 seconds while visible, 40 seconds after repeated unchanged responses; immediate refresh on focus and after owner actions.                                                                                                                                                       |
| Admin Printer page       | 30 seconds while visible; diagnostic commands alone use the existing two-second status observation while active and visible.                                                                                                                                                       |
| Customer browsing        | Existing public config loaded once per app mount; HTTP cache 30 seconds plus up to 60 seconds stale revalidation. Branding reused across routes.                                                                                                                                   |
| Upload                   | Draft includes direct signed PUT. Complete verifies R2 HEAD and bounded range GET. Customer PDF upload never passes through Worker memory.                                                                                                                                         |
| Quote/payment            | Server pricing and authenticated payment/readiness verification remain authoritative. Provider is mocked only in the test harness. Payment create adds a HEAD.                                                                                                                     |
| Tracking                 | 15 seconds initially, 30 seconds after two minutes; hidden tabs pause. Terminal status or invalid/expired private tracking stops requests.                                                                                                                                         |
| Branding                 | Admin upload up to 256 KiB; MIME and binary signature checked. UUID keys under private `branding/`. Only current selected logo is publicly addressable; five-minute image cache, ETag/304 avoids R2 GET.                                                                           |
| Retention                | Existing five-minute cron. At most five PDFs and five PII rows per pass: <=37 D1 queries and five R2 deletes. Five-minute deletion claims and 5–60 minute failed-delete backoff preserve the original access-expiry deadline. Idempotent finalization avoids repeat events/writes. |

The retention cap prevents the former 50/100-item pass from exhausting the per-invocation query allowance. Capacity is 1,440 PDF deletions/day and 1,440 PII purges/day under continuously available cron. Bursts/outages can delay physical deletion beyond a deadline; logical expiry still blocks access. Do not promise exact physical deletion time from a cron model.

## Query plans and migration

`evidence/efficiency-v2/query-plans.txt` and `query-plans-{800,1000}.json` contain `EXPLAIN QUERY PLAN` for the SQL actually exercised. No new database service or ORM was introduced.

Migration `database/migrations/0010_efficiency_and_branding.sql` adds:

- `installation.logo_key`: reuses the existing installation and shop name.
- `orders_agent_status_idx`: active/recovery lookups by Agent and state.
- `print_attempt_steps_order_status_idx`: avoids a full step-history scan when excluding already successful retry steps.
- `orders_status_completed_idx`: today's completion count.
- A repair for completed uploads still carrying the unresolved-payment retention deadline.

The latest test-command lookup now seeks the most recent command per printer instead of grouping all command history. Remaining `SCAN o` in Live Orders scans the bounded 100-row CTE, not the orders table. Small configuration/printer tables and JSON capability arrays retain small scans. Live Orders can still read many matching attention-state rows if unresolved history is allowed to accumulate; the model explicitly assumes at most 100 such rows.

Migration `0011_retention_retry_schedule.sql` adds `uploads.next_cleanup_attempt_at_ms` and indexes on provider-event related payment/order IDs after EXPLAIN exposed history-wide FK probes. It does not extend privacy deadlines. Payment lookup now uses the existing `(provider, provider_order_id)` unique index by explicitly including the only supported provider. No paid service was introduced.

## Daily model assumptions

Run `node scripts/efficiency-budget.mjs` or `node scripts/calculate-free-tier-capacity.mjs`. The latter retains its old exported calculation function only for historical stress comparisons; its CLI now prints the current scenarios.

- 15-hour shop day, 30 operating days/month, one Agent.
- Four visits per completed order; 5% additional failed payments; average PDF 2 MiB.
- Dashboard and Live Orders both visible all day (conservative); Live Orders modeled at its fastest interval.
- Eight tracking reads/order; two print steps; retries, webhook and preflight allowance included.
- Standardized two-step paid orders plus retention measure 52 table mutations before and 45 after. The model retains the previous index/variation factor: ceil(250 × 45/52) = 217, plus four writes/order for two provider-event indexes across insert/update, for 221 modeled D1 writes/order. Three modeled writes per persisted heartbeat and existing failure/background allowances remain. These are assumptions, **not measured upper bounds**; production index-write counters remain pending.
- Padded read estimates include current queue/index visits, daily completion counts and all 288 cron runs. No history-wide scan is treated as a constant-cost lookup.
- Normal R2 occupancy includes completed-file retention, failed uploads and 1% unresolved paid failures. An outage/backlog case is reported separately.

See `evidence/efficiency-v2/capacity-model.json` for formulas, inputs and complete results. The summary tables are in the efficiency report.

## Phase 2 daily scenarios

| Orders/day | Worker requests |  D1 reads | D1 writes | D1 write quota used |
| ---------- | --------------: | --------: | --------: | ------------------: |
| 60         |          18,585 |   641,400 |    16,700 |              16.70% |
| 800        |          42,450 | 2,518,040 |   183,200 |             183.20% |
| 1,000      |          48,900 | 3,025,240 |   228,200 |             228.20% |

Reads and requests retain the prior conservative envelopes; reducing SQL statements is not automatically reducing billed rows. For 800/day, the modeled monthly D1 load is 75,541,200 reads and 5,496,000 writes. These are below Workers Paid's included 25 billion reads/50 million writes monthly, as published in [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/). A paid plan and other account/storage/Worker costs still apply; no account upgrade was performed. The same application code serves either allowance.

## Gates that remain

D1 `meta.rows_read`/`rows_written`, Worker CPU and deployed traffic must be measured on the intended shop installation before release. Local SQL latency cannot prove the 10 ms CPU allowance. The 800/1,000-order software tests pass locally, but the conservative write model exceeds the Free daily write quota at those volumes.

Order/payment/audit history remains retained. At a modeled 8 KiB/order, a 500 MB database is finite (roughly 1,000 days at 60/day before existing storage/overhead). Indefinite free storage cannot be claimed; a separately designed archival policy is needed before the limit. No financial history was silently deleted.
