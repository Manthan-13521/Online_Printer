# Agent and Cloudflare efficiency — Phase 2

Follow-up physical-observation investigation and the current runtime-cost/reliability pass: [Agent runtime reliability and cost attribution](AGENT_RUNTIME_RELIABILITY_COST_REPORT.md).

29 September 2026. Repository work only. No production deployment, real payment, Windows connection attempt or physical printing. PHYSICAL/WINDOWS VERIFICATION: PENDING. Phase 1 branding, identification content and commercial-hardening work are preserved.

## Before and after

| Metric                                      | Before |  After | Evidence                                               |
| ------------------------------------------- | -----: | -----: | ------------------------------------------------------ |
| Ready Agent HTTP/hour                       |    720 |    720 | Source + fake-clock simulation                         |
| Ready Agent HTTP/15h                        | 10,800 | 10,800 | Source + fake-clock simulation                         |
| Unchanged heartbeat table writes/hour       |     60 |     60 | Local API/SQLite                                       |
| Stable no-work SQL statements/pulse         |      3 |      1 | Local API; one extra UPDATE/minute                     |
| PowerShell launches/hour, stable printer    |    126 |     60 | Injected executor simulation; Windows unverified       |
| Stable full printer reports/15h             |      1 |      1 | Startup plus actual changes                            |
| Dashboard requests/hour while visible       |    120 |    120 | Already aggregated; hidden tabs zero                   |
| Table writes/two-step order incl. retention |     52 |     45 | Actual SQLite mutations; excludes background heartbeat |
| Returned SQLite rows/profiled order         |    141 |    142 | Not D1 rows scanned; includes the background pulse     |
| Worker handler requests/profiled order      |     16 |     16 | Includes one background pulse; direct order flow is 15 |
| Modeled indexed D1 writes/order allowance   |    250 |    221 | Envelope requiring deployed validation                 |

The 13.46% table-write reduction removes seven mutations per two-step order. Five are `orders` mutations: repeated payment quote/reservation state (two), eager lease renewal (one), unchanged inter-step state (one), and duplicate terminal order mutation within the same atomic batch (one). Unchanged attempt metadata and already-redacted upload filename remove one each. The largest removed group is redundant order-row updates (five/order).

## Write forensics and retained boundaries

The new profiler instruments actual Worker handlers using local SQLite TEMP row triggers, grouped by table, exact SQL, endpoint, state transition and background/per-order/retention category. Fixtures and migrations are excluded. Identical two-step browser-verified paid flows were measured at 1, 10, 60 and 800 orders, including cleanup. The result was consistently 52 → 45/order. See `evidence/efficiency-v2/write-breakdown-before.json`, `write-breakdown-after.json` and `writes-per-order-before.json`/`after.json`.

| Table               | Before/order | After/order |
| ------------------- | -----------: | ----------: |
| orders              |           16 |          11 |
| order_events        |           11 |          11 |
| payments            |            3 |           3 |
| uploads             |            7 |           6 |
| print_attempts      |            7 |           6 |
| print_attempt_steps |            8 |           8 |

Agents add one background write/minute in this profile; unchanged printers add zero. Admin/session tables add zero to this order flow. Admin authentication is a read-only session lookup; login/logout/password changes still write their security records. Provider webhook rows are absent from the browser-verified base profile, and webhook/replay behavior is separately exercised by the scale harness. The model includes webhook/index allowances.

All 11 order-event rows remain: meaningful payment, job-code, queue, claim, step-start, completion and privacy milestones. No routine pulse/lease event was introduced. Concurrent duplicate step starts/submission acknowledgements now gate follow-on metadata/events on the actual state change. Repeated terminal cleanup does not generate duplicate events.

Payment verification, claim creation, attempt/step creation, SUBMISSION_STARTED, durable spool ID, success/blocked/uncertain outcomes and completion remain durable. PRINTED and COMPLETED already belonged to one atomic D1 batch; one order mutation now sets both timestamps and terminal state while retaining both forensic events. No independent crash boundary was removed. No simultaneous print-step pipeline or ambiguous auto-retry was added.

## Lease, liveness and request decisions

The current source uses a **five-minute lease** (`PRINT_CLAIM_LEASE_MS`), not the older two-minute description. Existing ownership is read-only until at most 100 seconds remain, then renewal extends it to five minutes. A conditional update and authoritative re-read handle concurrent renewal/completion. Fast-job, slow-job, blocked spool identity, short interruption, crash/expiry and concurrent-request regressions pass. Expired submitted work stays uncertain with its spool ID; only wholly unsubmitted claims can recover under the existing rule.

Heartbeat persistence stays at 60 seconds because readiness expires after 90 seconds. Printer deltas still persist immediately. One authoritative liveness field remains. Idle authentication also obtains indexed pending-command and work EXISTS flags, reducing statements without caching credentials or skipping authorization. A queued job arriving after that read is discovered on the next normal five-second pulse. Full job eligibility and exact Agent ownership are still checked on claim.

The five-second ready pulse is retained. A confirmed completed step already schedules the next request with zero timer delay. A reconnect response already processes returned work. A temporary two-second interval would raise ready traffic from 720 to 1,800 requests/hour without improving those immediate transitions, so it was not added. Paused/unavailable mode remains 30 seconds; network backoff retains jitter and a 30-second cap. See `agent-request-model.json`.

## Windows process model

Inventory, classification and capabilities share one invocation every five minutes; lighter all-queue health runs each minute in between. Thus stable idle is 12 full + 48 health invocations/hour instead of 120 discovery + 6 capability calls. Name/driver/port changes force reconciliation; missing/error results discard stale caches; operator diagnostics force refresh. Unavailable-printer checks stay at 30 seconds. Unknown health is not reported as ONLINE. Low-paper/low-toner warnings remain usable; offline/service-required states block readiness, using the [Microsoft CIM definitions](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-printer).

Before launching SumatraPDF, the existing submission PowerShell process performs a fresh Win32_Printer readiness check. A five-minute inventory cache is never used as permission to physically submit. Ready idle health can take up to 60 seconds to observe a change; this is an explicit tradeoff from the previous 30-second discovery, and is separate from fresh submission readiness. Actual payment readiness continues to require the authoritative Agent/printer checks on the Worker; no health response is cached in customer checkout.

Active spool observation, journal recovery, diagnostic printing and DPAPI operations are separate from the idle launch model. No Electron, persistent shell service, native dependency, inbound server or independent Control Center cloud poll was added. `powershell-call-model.json` records each category and source. Windows CPU/RAM and real CIM/driver behavior remain unverified.

Accelerated 15-hour Agent: 10,800 calls, 1 full report, 900 mocked PowerShell launches. Mac test-process measurements are in `agent-idle.json`; they are not a real 15-hour Windows soak.

## Queries, retention and existing UI

`query-plans.txt` contains actual EXPLAIN output. The stable no-work query uses indexed searches for credentials, installation, commands and order state, with no table scan. Payment lookup now includes `provider = 'RAZORPAY'` so its existing composite unique index is usable. Migration 0011 adds two foreign-key indexes after EXPLAIN exposed history-wide `payment_provider_events` probes. Small rate/configuration tables and JSON capability arrays remain intentionally bounded scans.

Retention selects indexed expired rows in batches of five. `next_cleanup_attempt_at_ms` is separate from the unchanged privacy deadline: a five-minute pending-delete lease prevents overlapping cron claims, and failures retry after 5/10/20/40/60 minutes (capped). No HEAD/LIST is added. Successful deletion and PII purge are idempotent, and an already-redacted filename is not rewritten. Logical expiry is unchanged; failed physical deletion can of course remain pending. The 37-query invocation cap still holds.

Dashboard already uses one aggregate request and indexed queue/today counts; no giant replacement endpoint was needed. Customer configuration remains one shared mount fetch with its existing cache headers; payment, private tracking and authoritative checkout readiness stay uncached. Branding, optional logo, full-phone physical sheet, ON/OFF and FIRST/LAST settings and pricing were not redesigned.

## Daily resource models

MODELED, not production billing. Same 15-hour/60-order product target, visible Admin assumptions, traffic and read padding as Phase 1. The write allowance scales the prior 250 by measured 45/52 (rounded to 217), then adds four writes/order for two new provider-event indexes across insert/update: **221/order**. This is an explicit assumption, not a proven bound or a measurement of D1 index maintenance. Returned local rows are not billable scanned rows. Worker request and read estimates are deliberately not reduced merely because SQL statements were consolidated.

| Orders/day | Worker requests/day | D1 reads/day | D1 writes/day | R2 A/month | R2 B/month | Free fit      |
| ---------- | ------------------: | -----------: | ------------: | ---------: | ---------: | ------------- |
| 60         |              18,585 |      641,400 |        16,700 |      1,920 |     14,670 | YES (modeled) |
| 800        |              42,450 |    2,518,040 |       183,200 |     25,230 |    195,600 | NO: D1 writes |
| 1000       |              48,900 |    3,025,240 |       228,200 |     31,530 |    244,500 | NO: D1 writes |

At 60/day, Workers use 18.58%, D1 reads 12.83%, and D1 writes 16.70% of daily Free quotas. 800/1,000 remain outside the modeled Free D1 write quota; no safety write was removed to force a fit. At 800/day the modeled monthly D1 usage is 75,541,200 reads and 5,496,000 writes, within the currently published Workers Paid D1 included row allowances; plan charges/other account usage still apply. Same code, no product fork or paid infrastructure provisioned.

Current official limits and storage/CPU caveats: [runtime budget](CLOUDFLARE_RUNTIME_BUDGET.md). Actual Cloudflare billing counters and Worker CPU remain pending. Financial history still accumulates; no indefinite free-storage claim is made.

## Software stress and validation

| Synthetic orders | Result | Duplicate attempts | Lost jobs | Incorrect states | Sampled peak RSS MiB | Local overall API p95 ms |
| ---------------- | ------ | -----------------: | --------: | ---------------: | -------------------: | -----------------------: |
| 800              | PASS   |                  0 |         0 |                0 |               141.52 |                     71.7 |
| 1000             | PASS   |                  0 |         0 |                0 |               190.81 |                     73.3 |

Both runs include bursts of 10/25/50, same-Agent contention plus separate cross-Agent ownership regressions, webhook replay, ID settings/price invariance and bounded retention. Predeclared per-route p95 <250 ms and sampled RSS <512 MiB thresholds were not relaxed. One repeat run while builds/tests ran concurrently exceeded a latency threshold; its failure is retained in `parallel-benchmark-failure.txt`. A subsequent isolated run passed; this does not establish deployed latency or physical throughput.

See [validation](evidence/efficiency-v2/validation.md) and raw JSON for exact evidence. Baseline Phase 1 evidence remains under `evidence/efficiency/`. To reproduce Phase 2, run the full repository verification pipeline plus `node scripts/profile-write-amplification.mjs after`, `node scripts/efficiency-audit.mjs`, and `node scripts/efficiency-budget.mjs`. The profiler refuses to overwrite the captured before baseline.

## Next hardware session checklist

PHYSICAL/WINDOWS VERIFICATION: PENDING. BHAVESH remains unavailable; no rescan/SSH attempts are required for this pass.

1. Actual Windows EXE/installer, fresh install, DPAPI, Control Center, startup, restart, upgrade/uninstall. Mac bundle/SEA preparation remains PARTIAL/NOT VERIFIED.
2. Real 15-hour Windows idle CPU/RSS, 60/hour stable process count, multiple printers, driver/port/default/capability changes, removal/re-add, explicit diagnostic refresh and reconnect.
3. Paper-out/jam/offline transitions: bounded health visibility and fresh pre-submit rejection, with no unintended spool submission. Resume blocked work only by its original spool identity.
4. Authorized physical paid order, 10 copies and ID OFF/FIRST/LAST; verify shop name/full phone/no logo, unchanged quote and physical settings. No real payment was made here.
5. Capture T1–T8 and Event 307 with exact spool IDs; measure physical inter-sheet latency. No early pipeline or inferred physical completion.
6. Crash/network loss before/after SUBMISSION_STARTED, spool identity save, acknowledgement, between steps and across five-minute lease expiry; confirm no duplicate physical submission.
7. Review/apply migrations 0010/0011 in a separately authorized release, then collect actual D1 rows_read/rows_written, Worker CPU and retry/backlog behavior on the intended shop account before calling it production-ready.

Commercial findings preserved: no central licensing/superadmin; shop Cloudflare deployment is the control boundary; third-party-license compliance remains unresolved. No production deployment performed.
