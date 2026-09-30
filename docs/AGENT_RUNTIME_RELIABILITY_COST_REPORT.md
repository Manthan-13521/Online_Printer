# Agent runtime reliability and cost attribution

Date: 2026-09-29. Scope: repository and local disposable SQLite only. No deployment, production query, Windows connection, physical print, real payment, or production data mutation. **WINDOWS/PHYSICAL VERIFICATION: PENDING.**

## 1. Root cause of the high observed usage

The reported 12–13 minute delta is **not attributable to the current single-Agent idle path**.

- Observed: 817 Worker requests, about 14,190 D1 reads and about 2,090 D1 writes.
- SIMULATED current source over 13 minutes: 156 Agent HTTP requests, 13 changed table rows, 169 Agent SQL statements, plus four empty-cleanup statements from two scheduled runs.
- MEASURED local complete test print: four requests beyond the normal Agent poll, 20 SQL statements total including that poll and one Admin status read, 13 returned rows, five changed table rows, and zero R2 operations.
- Cloudflare counts index maintenance in `rows_written`; the existing capacity model therefore conservatively budgets three billed writes per persisted heartbeat rather than one changed table row. Even that gives about 39 modeled idle D1 writes in 13 minutes. A test print can add index writes, but it still cannot plausibly bridge the gap to 2,090 without other traffic, delayed metrics, another build, or another database client.

One source-supported contributor to the request/read spike was real: while a test command remained `CLAIMED` or `SUBMITTED`, the Admin page polled its status every two seconds indefinitely. If the Agent disappeared, that was 1,800 read-only requests/hour. The new poll is single-flight, hidden-tab aware, backs off to five seconds, and treats an active diagnostic past its five-minute deadline as terminal. Polling never creates a command; another diagnostic requires a fresh explicit Admin action.

The remaining write delta is **NOT VERIFIED**. The next hardware session must capture exact UTC boundaries, deployed Worker version, Agent binary hash/version, D1 database identity, per-query `meta.rows_read`/`meta.rows_written` or GraphQL row metrics, visible browser tabs, and Agent logs. Cloudflare documents that returned rows are not billable rows scanned and that index maintenance adds writes; local SQLite `changes` cannot replace deployed D1 metadata: [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 index guidance](https://developers.cloudflare.com/d1/best-practices/use-indexes/).

## 2. Strongest code-supported explanation of the Agent exit

The exact physical exit is **NOT VERIFIED**. Current source has no successful-test-print shutdown path. Normal submit failure, printer error, spool observation, acknowledgement failure, network failure, and temporary-file cleanup are caught. Intended shutdown is limited to explicit signals or rejected/revoked Agent credentials.

The lifecycle weakness found in source was at the scheduled-iteration boundary: a callback or unexpected error escaping `pulse()` could leave the timer promise rejected and unhandled. That boundary now catches and logs unexpected iteration errors, safely contains throwing status/error callbacks, and always schedules the next iteration while the daemon remains authorized. Printer refresh was also moved inside the per-test boundary. Individual paid and diagnostic operations cannot terminate the daemon.

Plausible remaining causes are a 401/revocation, external signal/process termination, stale or different Windows binary, or a Windows-only child/runtime failure not reproducible on macOS. The added daemon error log should distinguish these on the next run. No one should claim the physical cause until the exact binary, exit code, log tail, and process ID are captured.

## 3. Files changed

Implementation and regression coverage:

- `apps/agent/windows/src/agent-client.test.ts`
- `apps/agent/windows/src/agent-daemon.ts`
- `apps/agent/windows/src/agent-daemon.test.ts`
- `apps/agent/windows/src/printing/diagnostic-pdf.ts`
- `apps/agent/windows/src/printing/diagnostic-pdf.test.ts`
- `apps/api/worker/src/agent/repository.ts`
- `apps/api/worker/src/agent/repository.test.ts`
- `apps/api/worker/src/agent/service.test.ts`
- `apps/api/worker/src/retention/admin-routes.ts`
- `apps/api/worker/src/retention/service.ts`
- `apps/api/worker/src/retention/service.test.ts`
- `apps/web/admin/src/PrinterPage.tsx`
- `packages/api-contract/src/index.ts`
- `scripts/efficiency-audit.mjs`
- `scripts/runtime-cost-audit.mjs`
- `scripts/windows-agent-test/README-WINDOWS-TEST.txt`

Reports and regenerated local evidence:

- `docs/AGENT_RUNTIME_RELIABILITY_COST_REPORT.md`
- `docs/AGENT_CLOUDFLARE_EFFICIENCY_REPORT.md`
- `docs/evidence/runtime-cost/runtime-cost.json`
- `docs/evidence/efficiency-v2/idle-api.json`
- `docs/evidence/efficiency-v2/query-plans-60.json`
- `docs/evidence/efficiency-v2/query-plans-800.json`
- `docs/evidence/efficiency-v2/query-plans-1000.json`
- `docs/evidence/efficiency-v2/query-plans-after.json`
- `docs/evidence/efficiency-v2/scale-results.json`
- `docs/evidence/efficiency-v2/write-breakdown-after.json`
- `docs/evidence/efficiency-v2/writes-per-order-after.json`

The following files already had user-owned edits at task start and remain modified; they were preserved rather than reverted: `apps/agent/windows/src/index.ts`, `apps/api/worker/src/payments/readiness.test.ts`, and `docs/evidence/efficiency-v2/agent-idle.json`. The Agent client/daemon test files and daemon source were also already dirty; this pass integrated its changes into those files.

### Runtime operation table

Local returned rows are shown because they are measurable here. They are **not D1 billed rows scanned**.

| Operation                      |                         Frequency |               HTTP/hour | SQL statements/hour | Local rows returned/hour |      Changed table rows/hour | Necessary                                      | Current optimization                                                         |
| ------------------------------ | --------------------------------: | ----------------------: | ------------------: | -----------------------: | ---------------------------: | ---------------------------------------------- | ---------------------------------------------------------------------------- |
| Agent job poll                 |                         every 5 s |                     720 |                 780 |                      720 |                           60 | Yes, bounds new-job latency                    | One indexed credential/work query; liveness update only once/minute          |
| Persistent liveness            |           once/minute inside poll |                 0 extra |      included above |                 included |                           60 | Yes, payment readiness fails closed after 90 s | No write on the other 11 polls/minute                                        |
| Full printer state sync        | startup or actual snapshot change |           change-driven |             4/event |                  2/event | 1/event when liveness is due | Yes                                            | Stable refreshes omit printers and use `/pulse`                              |
| Local printer availability     |          once/minute when healthy |                       0 |                   0 |                        0 |                            0 | Yes                                            | One local PowerShell health query for all queues                             |
| Claim/lease renewal            |         no idle work; active only |                  0 idle |              0 idle |                   0 idle |                       0 idle | Yes                                            | Existing ownership stays read-only until lease has at most 100 s left        |
| Test status, stuck active      |           initially 2 s, then 5 s |          720 steady max |               2,160 |                    2,160 |                            0 | Temporarily                                    | Was 1,800/hour forever; now hidden-tab zero and terminal by five minutes     |
| Admin dashboard, visible       |                        every 30 s |                     120 |               1,200 |  2,040 empty-shop sample |                            0 | Operator page only                             | Hidden-tab zero; aggregate endpoint                                          |
| Admin printer page, visible    |                        every 30 s |                     120 |                 720 |  1,560 empty-shop sample |                            0 | Operator page only                             | Hidden-tab zero                                                              |
| Live Orders, visible unchanged |                 every 40 s steady |                      90 |                 180 |     90 empty-shop sample |                            0 | Operator page only                             | Hidden-tab zero; indexed bounded query                                       |
| Customer tracking              |         15 s for 2 min, then 30 s |          124 first hour |     event-dependent |          event-dependent |                            0 | Active customer only                           | Stops at terminal state and while hidden                                     |
| Retention cleanup              |                       every 5 min | 0 inbound; 12 scheduled |       24 empty-shop |             0 empty-shop |                 0 empty-shop | Yes                                            | Normal run reduced from seven statements to two; Admin stats remain separate |
| Audit/observability            |                      event-driven |             0 recurring |         0 recurring |              0 recurring |                  0 recurring | Yes where consequential                        | Test command row is authoritative; duplicate transition audit rows removed   |

Only one Admin SPA page is normally active at once. Multiple visible tabs add their own polling. CORS preflights, Cloudflare health/monitoring, deployment traffic, Wrangler/dashboard queries, other Agents, and delayed telemetry are outside these local counts.

## 4. Before versus after

| Area                     | Before this pass                                                                      | After this pass                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Stable printer reporting | Worktree change forced empty full heartbeats, which could mark known printers offline | Read-mostly `/pulse`; full inventory only at startup/change                                  |
| Scheduled Agent failure  | Escaped callback/iteration rejection could be unhandled                               | Last-resort scheduler boundary logs, contains, and reschedules                               |
| Test-print failure       | Printer refresh was outside the command boundary                                      | Discovery, PDF, child process, printer, spool, API acknowledgement and cleanup are contained |
| Stale test command       | `CLAIMED`/`SUBMITTED` could poll forever                                              | UI becomes terminal at five minutes; only a new explicit Admin action can request another    |
| Test status polling      | 2 s forever while active                                                              | 2 s initially, then 5 s; one in flight; hidden tabs zero                                     |
| Test page                | Large diagnostic/audit page                                                           | Only shop name, printer name, `TEST PRINT CONFIRMED`                                         |
| Test DB audit            | Command row plus request audit plus transition audit duplicates                       | Command row plus initiating-admin audit; no duplicate transition audit rows                  |
| Empty retention run      | 7 SQL statements/run                                                                  | 2 indexed candidate statements/run                                                           |

## 5–8. Requests, reads, writes, and test-print cost

| Metric                                          |                        Before |                         After | Evidence class                                                                            |
| ----------------------------------------------- | ----------------------------: | ----------------------------: | ----------------------------------------------------------------------------------------- |
| Agent HTTP requests/hour                        |                           720 |                           720 | SIMULATED actual handlers; intentionally retained for job latency                         |
| Stuck active test-status requests/hour          |                         1,800 |  720 steady, bounded to 5 min | SOURCE-DERIVED                                                                            |
| Empty-shop SQL statements/hour, Agent + cleanup |                           864 |                           804 | SIMULATED actual handlers                                                                 |
| Local rows returned/hour, Agent + cleanup       |                           780 |                           720 | SIMULATED; not D1 billing                                                                 |
| Modeled D1 rows read/hour                       |                         9,000 |                         8,748 | MODELED: 12/pulse plus cleanup allowance scaled 30 to 9/run; production metadata required |
| Changed table rows/hour                         |                            60 |                            60 | SIMULATED actual handlers                                                                 |
| Modeled indexed D1 rows written/hour            |                           180 |                           180 | MODELED conservative factor already used by capacity model                                |
| Complete test-print HTTP                        | 5 including normal claim poll | 5 including normal claim poll | MEASURED local handlers; four incremental requests                                        |
| Complete test-print SQL                         |                            22 |                            20 | MEASURED local after; before adds two removed audit inserts                               |
| Complete test-print changed table rows          |                             7 |                             5 | MEASURED local after; source-derived before                                               |
| Complete test-print local returned rows         |                            13 |                            13 | MEASURED local; not D1 billing                                                            |
| Complete test-print R2 operations               |                             0 |                             0 | MEASURED local                                                                            |
| Complete test-print D1 billed rows              |                  NOT VERIFIED |                  NOT VERIFIED | Requires deployed `meta.rows_read`/`meta.rows_written`, including indexes                 |

Query-plan evidence remains indexed for the hot Agent credential/work lookup, pending test command, expired upload selection, PII selection, and live-order candidate selection. The only retained `SCAN` entries in the broader profile are bounded configuration tables, JSON capability arrays, or constant rows—not the recurring Agent/order/retention hot paths.

## 9. Fifteen-hour idle projection

| Metric                          |  Before |   After | Evidence class                        |
| ------------------------------- | ------: | ------: | ------------------------------------- |
| Agent HTTP requests             |  10,800 |  10,800 | SIMULATED                             |
| Scheduled cleanup invocations   |     180 |     180 | SOURCE-DERIVED                        |
| SQL statements                  |  12,960 |  12,060 | SIMULATED after; deterministic before |
| Local rows returned             |  11,700 |  10,800 | SIMULATED after; deterministic before |
| Changed table rows              |     900 |     900 | SIMULATED                             |
| Modeled D1 rows read            | 135,000 | 131,220 | MODELED                               |
| Modeled indexed D1 rows written |   2,700 |   2,700 | MODELED                               |
| R2 operations                   |       0 |       0 | SIMULATED                             |

The 180 scheduled events are listed separately from inbound HTTP. Whether a dashboard groups them with Worker invocations must be checked against the intended account analytics; no production claim is made.

## 10–12. Daily order projections including 15 operating hours

These remain deliberately conservative and include Agent pulses, visible Dashboard and Live Orders assumptions, customer visits/tracking, preflights, retention, failure allowance, and indexed-write allowance.

| Orders/day | Worker requests |  D1 reads | D1 writes | R2 A/month | R2 B/month | Free-tier model                     |
| ---------: | --------------: | --------: | --------: | ---------: | ---------: | ----------------------------------- |
|         60 |          18,585 |   641,400 |    16,700 |      1,920 |     14,670 | YES, modeled with headroom          |
|        800 |          42,450 | 2,518,040 |   183,200 |     25,230 |    195,600 | NO: D1 writes exceed Free allowance |
|      1,000 |          48,900 | 3,025,240 |   228,200 |     31,530 |    244,500 | NO: D1 writes exceed Free allowance |

The software architecture remains the same at 800/1,000 orders, but paid Cloudflare resources are required by this model. No durable payment, claim, spool, recovery, or forensic boundary was removed to force a Free-tier result.

## 13. Safety invariants

- Atomic claim ownership, five-minute lease, bounded renewal, payment and webhook verification, durable `SUBMISSION_STARTED`, exact spool identity, blocked/uncertain handling, no ambiguous auto-retry, restart journal, outbound-only Agent, private R2, and retention deadlines are unchanged.
- All 11 paid-order forensic events remain. The only removed events were redundant test-diagnostic transition audit rows; the authoritative diagnostic command retains printer, Agent, timestamps, status, failure, and spool identity, and the request audit retains the initiating Admin.
- Stale diagnostics are terminal and are never resubmitted by polling. A new test print requires an explicit Admin action.
- The full-heartbeat fallback that could falsely report zero printers was not retained.

## 14. Test results

Raw cost evidence: `docs/evidence/runtime-cost/runtime-cost.json`.

- Focused Agent/API/retention tests: 56 passed across six files.
- Full test suite: 533 passed and one Windows-only test was skipped across 70 files.
- Synthetic 60, 800 and 1,000-order runs: PASS locally, with zero duplicate attempts, zero lost jobs and zero incorrect states. Peak process RSS was 109.45 MiB, 139.48 MiB and 169.13 MiB respectively. These use mocked provider/spooler behavior and local SQLite.
- Write profiler at 1/10/60/800 orders: 45 changed table rows/two-step order, with all 11 order events and eight durable step mutations retained.
- Typecheck, lint, format check, local D1 migration validation, monorepo build, non-native Windows Agent packaging preparation and the Free-tier capacity model all passed. The Windows packaging command did not produce a native `.exe` on macOS; that remains a Windows or GitHub Actions step.

## 15. Windows and physical items still pending

Agent process survival, BAT/Control Center behavior, native DPAPI, PowerShell/CIM, Sumatra exit behavior, printer driver/spooler, one-hour CPU/RAM/process stability, physical page content, paid print, identification-sheet ordering, disconnect/reconnect, network loss, restart recovery, no duplicate pages, and actual Cloudflare counters are **NOT VERIFIED**.

## 16. Next Windows session command and checklist

From the reviewed checkout on the Windows technician machine:

```powershell
pnpm windows:verify --build
Get-Content "$env:LOCALAPPDATA\PrintGo\daemon.log" -Wait
```

In a second PowerShell window, after starting the reviewed Agent and recording its PID:

```powershell
$before = (Get-Process PrintGo-Agent -ErrorAction Stop).Id
powershell.exe -NoProfile -File .\scripts\windows-hardware-acceptance.ps1 -ObserveSeconds 3600
$after = (Get-Process PrintGo-Agent -ErrorAction Stop).Id
if ($before -ne $after) { throw "PrintGo Agent restarted or exited during acceptance." }
```

During that one-hour observation, the authorized operator must: run one Admin test print; confirm the three-line page; confirm the same Agent PID remains; run one authorized paid print and verify identification-sheet order; disconnect/reconnect the printer; briefly interrupt/restore network; restart only after reconciling all spool identities; count physical pages and confirm no duplicates; and capture Cloudflare before/after counters with exact UTC timestamps. Record any missing evidence as **NOT VERIFIED**.
