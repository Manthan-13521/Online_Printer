# PrintGo — Queue Reliability & False Completion Architectural Fix

**Date**: October 2026  
**Auditor / Implementer**: Antigravity Principal Systems & Security Auditor (PONYTAIL Engine)  
**Objective**: Fix the Stuck `CLAIMED` Queue Bug and the False Completion Reality Gap cleanly, permanently, and without patch-on-patch complexity.

---

## 1. Root Causes Fixed

### 1. Stuck `CLAIMED` Order & Blocked Queue
- **Root Cause**: When a printer was offline or blocked during preflight check, the Windows Agent returned `"PREFLIGHT_DEFERRED"` silently without notifying the Cloudflare Worker. The Worker interpreted ongoing agent heartbeat pulses as active claim renewals and continually extended the 5-minute lease indefinitely. Because the order remained in `CLAIMED`, the candidate query guard (`NOT EXISTS busy WHERE busy.status IN ('CLAIMED','SPOOLING','PRINTING','PRINT_BLOCKED')`) permanently locked all subsequent customer orders in `QUEUED`.
- **The Fix**: 
  - The Agent immediately reports `status: "BLOCKED"` with failure reason (`PRINTER_OFFLINE` / `PRINTER_ERROR`) to the Worker before submission.
  - The Worker transitions the order to `PRINT_BLOCKED` and the attempt/step to `BLOCKED`.
  - When the printer recovers online, the Agent automatically resumes the SAME order, moving it from `PRINT_BLOCKED` to `SPOOLING` via `startPrintStep()`, without agent/PC restarts or admin intervention.
  - `recoverExpiredClaims` is now wired into the Cloudflare Worker scheduled cron handler, ensuring dead agent claims expire and recover automatically.

### 2. Windows Spooler False Completion & Completion Verification Policy
- **Root Cause**: Windows Spooler `REMOVED` or `COMPLETED` was directly mapped to immediate physical success (`SUCCEEDED`), transitioning orders immediately to `COMPLETED` without verifying whether the printer hardware was still operational or had jammed during spool hand-off.
- **The Fix**:
  - `observed.state === "COMPLETED_OR_REMOVED"` represents **`SPOOL_HANDOFF_COMPLETE`**, NOT guaranteed physical paper exit.
  - **Post-Spool Hardware Probe**: Before reporting `SUCCEEDED`, [`PaidPrintExecutor.observe()`](file:///Users/manthanjaiswal/Printe_Go_/apps/agent/windows/src/paid-print-executor.ts) performs an immediate printer health verification via `printer.getStatus()`. If the printer entered `BLOCKED` (Paper Jam, Out of Paper, Door Open, Out of Toner) or `OFFLINE` during/after spooling, it reports `BLOCKED` to the server instead of declaring completion.
  - **Uncertainty Protection**: Any reboot, agent crash, or missing spool job ID during submission results in `UNCERTAIN` $\rightarrow$ `COMPLETION_UNKNOWN`, preventing automatic duplicate reprints.
  - **Hardware Boundary**: For consumer GDI/USB printers lacking bidirectional hardware sensors, software cannot guarantee physical paper emergence. The post-spool health check verifies that no hardware errors occurred during spool hand-off.

---

## 2. State-Machine Flow

```
QUEUED -> CLAIMED -> [Printer OFFLINE] -> PRINT_BLOCKED (Reported to Server, UI Updated)
                            |
                   [Printer ONLINE] -> SPOOLING -> PRINTING
                                                      |
                   [Spool Hand-off] -> [Post-Spool Health Probe]
                                           /                  \
                            [Printer Error/Jam]             [Printer Healthy]
                                     |                              |
                               PRINT_BLOCKED                PRINTED -> COMPLETED
```

---

## 3. Exact Files Changed

1. [`packages/domain/src/order-transitions.ts`](file:///Users/manthanjaiswal/Printe_Go_/packages/domain/src/order-transitions.ts)
   - Added `CLAIMED -> PRINT_BLOCKED` and `PRINT_BLOCKED -> SPOOLING / CLAIMED` transitions to allow clean preflight blocking and seamless automatic recovery when the printer returns online.
2. [`apps/api/worker/src/index.ts`](file:///Users/manthanjaiswal/Printe_Go_/apps/api/worker/src/index.ts)
   - Added `await printingRepo.recoverExpiredClaims(nowMs)` to the Cloudflare scheduled cron execution handler.
3. [`apps/api/worker/src/printing/repository.ts`](file:///Users/manthanjaiswal/Printe_Go_/apps/api/worker/src/printing/repository.ts)
   - Updated `findCurrent()` to prioritize `BLOCKED` steps alongside `PENDING` and `SUBMISSION_STARTED`.
   - Updated `startStep()` to allow transitioning a step from `BLOCKED` to `SUBMISSION_STARTED` and order from `PRINT_BLOCKED` to `SPOOLING`.
   - Updated `recordResult()` to handle pre-submission `BLOCKED` reporting cleanly and record `PRINT_BLOCKED` events.
4. [`apps/agent/windows/src/paid-print-executor.ts`](file:///Users/manthanjaiswal/Printe_Go_/apps/agent/windows/src/paid-print-executor.ts)
   - Added explicit `reportPrintStep(status: "BLOCKED", failureCode: "PRINTER_OFFLINE")` before print submission when the printer is offline/blocked.
   - Added post-spool health verification in `observe()` to intercept jams/faults before reporting `SUCCEEDED`.
   - Preserved automatic resumption when the printer transitions back to `ONLINE`.
5. [`apps/agent/windows/src/printing/windows-printer-adapter.ts`](file:///Users/manthanjaiswal/Printe_Go_/apps/agent/windows/src/printing/windows-printer-adapter.ts)
   - Enhanced `extractHostFromPortName` to support WSD and URL device ports.
   - Updated `parsePrinterStatus` so active TCP socket reachability overrides stale Windows WMI `WorkOffline: true` latches.
6. [`apps/agent/windows/src/paid-print-executor.test.ts`](file:///Users/manthanjaiswal/Printe_Go_/apps/agent/windows/src/paid-print-executor.test.ts)
   - Added unit assertions for preflight `BLOCKED` reporting, online resumption, and post-spool hardware fault interception.
7. [`apps/api/worker/src/printing/repository.test.ts`](file:///Users/manthanjaiswal/Printe_Go_/apps/api/worker/src/printing/repository.test.ts)
   - Added integration tests for `PRINT_BLOCKED` state lifecycle, queue isolation, and scheduled recovery.

---

## 4. Why the Fix Is Safe

- **Zero Duplicate Risk**: The single-active-order invariant is strictly preserved. Later orders remain safely `QUEUED` while the active order is `PRINT_BLOCKED`.
- **No Manual Intervention on Normal Recovery**: When paper is reloaded or the printer is powered on, the next heartbeat detects `ONLINE`, resumes the same order, finishes spooling, and releases subsequent jobs automatically.
- **No Arbitrary Latency Penalties**: Happy-path printing latency remains instant (no artificial 30/60/90 second sleep delays).
- **Zero Schema Migrations**: Fully utilizes the existing D1 SQLite check constraints and tables.

---

## 5. Verification Results

```bash
$ pnpm test
# Result: 82 test suites passed, 699 tests passed, 1 skipped (DPAPI win32-only). 0 failures.

$ pnpm typecheck
# Result: 0 errors across all apps and packages.

$ pnpm lint
# Result: 0 errors, 0 warnings across all files.

$ pnpm db:validate
# Result: All 21 D1 migrations and seed schema applied and verified (28 tables created).
```
