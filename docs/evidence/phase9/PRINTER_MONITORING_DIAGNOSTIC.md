# PrintGo Phase 8 & 9 Printer Monitoring Diagnostic Report

**Methodology:** PONYTAIL Evidence-First Verification  
**Auditor Roles:** Senior Windows Agent Engineer, Cloudflare Engineer, QA Auditor  
**Date of Audit:** October 14, 2026 (Local Time: 19:00 IST / 13:30 UTC)  
**Target Repository:** `C:\Users\MANTH\Documents\Online_Printer` (Commit `ef7e023325e133da174f2aee3a7d1c3092fc182d`)  
**Live Target System:** Windows 11 PC `BHAVESH` running PrintGo Windows Agent Service (PID: 18164)

---

## Executive Summary

| Diagnostic Domain | Source Code (`apps/agent`, `apps/api`, `apps/web`) | Installed Live Executable (`PrintGo-Agent.exe`) | Deployed Cloudflare Worker | Overall Status |
|---|---|---|---|---|
| **1. Startup Stabilization (5 Checks)** | **PASS** (60s checks, 5x threshold) | **FAIL** (Missing stabilization counter) | N/A (Client daemon responsibility) | **DISCREPANCY IDENTIFIED** |
| **2. 15-Minute Fallback (900,000 ms)** | **PASS** (Exact 900,000 ms fallback) | **FAIL** (Polls every 60s/120s continuously) | N/A (Client daemon responsibility) | **DISCREPANCY IDENTIFIED** |
| **3. Agent "Last Seen" Display (48–90s)** | **PASS** (Expected behavior explained) | **PASS** (Matches 60s agent pulse + 90s UI poll) | **PASS** (Timestamp recorded upon heartbeat) | **VERIFIED (NOT A PRINTER POLL)** |
| **4. Installed Agent vs Repo Build** | **ef7e023** (Oct 13, 2026) | **Stale binary** (Oct 10, 2026, Hash `7B9946...`) | Active Worker `printgo-api` | **OUT-OF-SYNC DEPLOYMENT** |
| **5. Print Safety & Payment Barriers** | **PASS** (Preflight, idempotency, journal) | **PASS** (Journal & preflight present) | **PASS** (Strict SQL gate requiring verified payment) | **PASS** |

**Root Cause Conclusion:**  
The repository source code contains the full and correct implementation of Phase 8/OPT-8 printer-monitoring separation (120s idle heartbeat, 5 consecutive startup health probes, 15-minute stable fallback, WMI event-driven triggers, and preflight gates). However, the **live running agent process on the Windows PC (`PID: 18164`) is executing a pre-Phase-8 binary compiled on October 10, 2026**, prior to commit `ef7e023`. Furthermore, the Admin UI's "Last seen: 48s" timestamp is purely a UI relative rendering artifact between the Agent's 60s HTTP heartbeat and the Admin Web's 90s polling interval—it does not indicate physical printer polling.

---

## Section 1: Verification of Startup Stabilization

### 1.1 Requirements
- Startup performs 5 consecutive successful printer health checks.
- Intended interval between checks is approximately 60 seconds (`printerRefreshMs`).
- Stabilization occurs *only* after 5 genuinely successful checks on production-eligible physical printers.
- Failed checks reset the consecutive-success counter to 0 and revert stability.
- Inconclusive or failing checks never mark a printer healthy.

### 1.2 Evidence & File References
- **Source File:** `apps/agent/windows/src/agent-daemon.ts`
  - Lines 85: `this.printerRefreshMs = options.printerRefreshMs ?? 60_000;`
  - Lines 312–320:
    ```ts
    const refreshEveryMs = unhealthy
      ? 120_000
      : this.isPrinterMonitoringStable
        ? 15 * 60 * 1_000
        : this.printerRefreshMs;
    const refreshPrinters =
      this.lastPrinterRefreshMs === -Infinity ||
      Date.now() - this.lastPrinterRefreshMs >= refreshEveryMs;
    ```
  - Lines 356–391:
    ```ts
    const productionPrinters = printerReports.filter(
      (p) => p.isEligibleForProductionPrint !== false && !p.isVirtual,
    );
    const printersToCheck =
      productionPrinters.length > 0 ? productionPrinters : printerReports;

    const allHealthy =
      printersToCheck.length > 0 &&
      printersToCheck.every((p) => p.status === "ONLINE");

    if (allHealthy) {
      this.consecutiveHealthyChecks++;
      if (
        this.consecutiveHealthyChecks >= 5 &&
        !this.isPrinterMonitoringStable
      ) {
        this.isPrinterMonitoringStable = true;
        this.subscribeToPrinterEvents();
        this.log(
          "PRINTER_MONITORING_STABLE: 5 consecutive healthy checks achieved. Switched to event-driven monitoring with 15-minute safety fallback.",
        );
      }
    } else {
      if (
        this.isPrinterMonitoringStable ||
        this.consecutiveHealthyChecks > 0
      ) {
        this.log(
          "Printer health check found offline or unhealthy printer(s). Resetting stability to startup mode (60s checks).",
        );
      }
      this.consecutiveHealthyChecks = 0;
      this.isPrinterMonitoringStable = false;
      this.unsubscribeFromPrinterEvents();
    }
    ```
- **Test Evidence:** `apps/agent/windows/src/agent-daemon.test.ts` lines 638–735:
  - Verifies checks 1, 2, 3, 4 remain `isPrinterStable() === false`.
  - Verifies check 5 sets `isPrinterStable() === true` and calls `subscribePrinterEvents()`.
  - Verifies triggering an `OFFLINE` or `JAM` fault immediately resets `isPrinterStable() === false` and `consecutiveHealthyChecks === 0`.
- **Installed Executable Evidence:**
  Inspection of `C:\PrintGo\agent\bundle.cjs` (lines 2412–2442) and string extraction on `PrintGo-Agent.exe` shows:
  - `this.consecutiveHealthyChecks` is **absent**.
  - `isPrinterMonitoringStable` is **absent**.
  - String `PRINTER_MONITORING_STABLE` is **absent**.

### 1.3 Findings & Status
- **Source Code:** **PASS**. The source code strictly adheres to the 5 consecutive check startup gate, resets on failure, and ignores virtual/ineligible printers.
- **Installed Executable:** **FAIL**. The installed executable runs an older loop where every pulse checks whether `Date.now() - lastPrinterRefreshMs >= 60_000` without stabilization.
- **Physical Device Condition on Machine `BHAVESH`:**
  In `agent-status.json`, `Xprinter XP-TT426B` is `OFFLINE` ("Printer is set to work offline", `isEligible: true`). Even in the new source code, because `Xprinter` is flagged `isEligible: true`, `allHealthy` evaluates to `false`. To achieve stabilization once updated, either `Xprinter` must be brought online, or marked `isEligibleForProductionPrint: false` in configuration.

---

## Section 2: Verification of the 15-Minute Fallback

### 2.1 Requirements
- Full physical printer health check operates on a 15-minute fallback (900,000 ms), NOT 45 minutes or 60 seconds.
- Distinguish physical printer query from HTTP heartbeat, WebSocket keepalive, or UI poll.
- Verify whether older configs or timers override the interval.
- Verify event-driven checks and pre-print readiness operate independently of the fallback timer.

### 2.2 Evidence & File References
- **Source File:** `apps/agent/windows/src/agent-daemon.ts`
  - Lines 315–317:
    ```ts
    const refreshEveryMs = unhealthy
      ? 120_000
      : this.isPrinterMonitoringStable
        ? 15 * 60 * 1_000 // EXACTLY 900,000 ms (15 minutes)
        : this.printerRefreshMs;
    ```
  - **Physical query separation:**
    The Agent pulse timer (`nextDelayMs`) fires every 120s (idle) or 6s (printing). However, `this.printerAdapter.listPrinters()`, `getCapabilities()`, and `getStatus()` are gated inside `if (refreshPrinters)` (line 321). Thus, during stable idle, the daemon posts HTTP heartbeats every 120 seconds while skipping physical printer Win32/WMI queries for 15 minutes.
  - **Independence from Pre-print and Event-Driven Checks:**
    - Event-driven checks (`agent-daemon.ts#L881-L904`): WMI status changes directly trigger `markPrinterFault(pName, eType)`, which immediately forces `lastPrinterRefreshMs = -Infinity`, `nextDelayMs = 0`, and calls `reschedulePulse()`.
    - Pre-print check (`paid-print-executor.ts#L119-L135`): Calls `this.printer.getStatus(job.windowsPrinterName)` immediately before submitting a job, completely independent of `lastPrinterRefreshMs`.
- **Test Evidence:** `apps/agent/windows/src/efficiency.test.ts#L78-L79`:
  - 15-hour simulation proves physical discovery launches dropped from 900 launches down to 64 launches (5 startup probes + 59 fallback probes over 15 hours).
- **Installed Executable Evidence:**
  - `C:\PrintGo\agent\bundle.cjs#L2413`:
    `const refreshEveryMs = unhealthy ? 12e4 : this.printerRefreshMs;`
    (Fallback is 60 seconds, or 120 seconds if unhealthy. The 15-minute fallback is absent in the deployed bundle).

### 2.3 Findings & Status
- **Source Code:** **PASS**. Exact 15 minutes (`15 * 60 * 1_000 = 900,000 ms`). No 45-minute timer exists.
- **Installed Executable:** **FAIL**. Lacks the 15-minute fallback logic.
- **Independence:** **PASS**. Preflight and event hooks operate completely independently.

---

## Section 3: Investigation of Agent "Last Seen" (48–90s)

### 3.1 Problem Statement
The Admin UI displays Agent "Last seen: 48 seconds ago" or varying between 48–90 seconds during completely idle operation.

### 3.2 Root Cause Analysis
1. **Admin UI Polling Interval:**
   In `apps/web/admin/src/PrinterPage.tsx#L328`:
   ```tsx
   useEffect(() => {
     return startVisiblePolling(loadPrinters, 90_000);
   }, []);
   ```
   The Admin Web interface queries `GET /api/admin/printers` every **90 seconds** while the page is visible.
2. **Relative UI Formatting:**
   In `apps/web/admin/src/PrinterPage.tsx#L17-L25` & `#L1680`:
   ```tsx
   function formatRelativeTime(dateString: string | null): string {
     ...
     const diffSeconds = Math.round((now.getTime() - date.getTime()) / 1000);
     if (diffSeconds < 60) return `${diffSeconds}s ago`;
     const diffMinutes = Math.floor(diffSeconds / 60);
     return `${diffMinutes}m ago`;
   }
   // Render: Last seen: {formatRelativeTime(activeAgent.lastHeartbeatAt)}
   ```
   `diffSeconds` calculates the delta between `new Date()` in the browser and `lastHeartbeatAt` returned by the server. Because the browser page polls every 90 seconds, the age of the last heartbeat at the time the browser renders will naturally vary anywhere from `0s ago` to `90s ago`.
3. **Agent Heartbeat Interval in Installed Binary:**
   In `C:\PrintGo\agent\bundle.cjs#L2498`:
   `this.nextDelayMs = 6e4;`
   The installed Agent transmits an HTTP heartbeat to `/api/agent/heartbeat` every **60 seconds**.
   Combining a 60-second Agent transmission cycle with a 90-second Admin browser poll guarantees that the browser screen will regularly show `Last seen: 48s ago`, `60s ago`, or `80s ago`.
4. **Server-Side Timestamp Updating:**
   In `apps/api/worker/src/agent/service.ts#L156-L166`:
   ```ts
   if (
     reportPrinters ||
     agent.lastHeartbeatAtMs === null ||
     nowMs - agent.lastHeartbeatAtMs >= 65_000
   ) {
     await this.repository.updateHeartbeat({
       agentId: agent.id,
       nowMs,
       ...(reportPrinters ? { printers: input.printers } : {}),
     });
   }
   ```
   The Cloudflare Worker updates `last_heartbeat_at_ms` in SQLite D1 upon receiving the Agent's heartbeat.
5. **WebSocket Keepalives vs Heartbeats:**
   - In `apps/api/worker/src/agent/agent-room.ts#L1-L45`: The Cloudflare Durable Object `AgentRoom` WebSocket connection is used **strictly for push wake-up** (`{ type: "WAKE_UP" }`).
   - No application heartbeat or printer status data travels over WebSocket.
   - Heartbeats are pure HTTP `POST` requests to `/api/agent/heartbeat`.

### 3.3 Findings & Status
- **Classification:** **CONFIRMED & EXPLAINED**.
- "Last seen" reflects the age of the HTTP Agent-to-Worker lease renewal, formatted by a 90-second client-side polling hook.
- **It does not represent physical printer querying.**

---

## Section 4: Comparison of Installed Agent vs Repository Build

### 4.1 Artifact Identification

| Target | Location | File Size (Bytes) | Last Modified | SHA-256 Hash |
|---|---|---|---|---|
| **Live Running Process (PID 18164)** | `C:\Users\MANTH\AppData\Local\Programs\PrintGo\PrintGo-Agent.exe` | 87,261,184 | 2026-10-10 18:12:00 | `7B9946119FF27A4804A6A0312D99E8F383D2BFAD6A2BCC0526178EAD83D75309` |
| **Staging Executable** | `C:\PrintGo\staging\PrintGo-Agent.exe` | 87,261,184 | 2026-10-10 18:12:00 | `7B9946119FF27A4804A6A0312D99E8F383D2BFAD6A2BCC0526178EAD83D75309` |
| **Agent Folder Executable** | `C:\PrintGo\agent\PrintGo-Agent.exe` | 87,271,424 | 2026-10-11 21:33:00 | `1677BDC0915244C7904E4FFBD1E6B675A1D9838F577A32EEC62833C4B2B0B88D` |
| **Agent Folder Bundle** | `C:\PrintGo\agent\bundle.cjs` | 155,727 | 2026-10-11 21:32:42 | `4DDA2BD93DC8D2BC82C741553FE0E15F18E897924D7FEF2EBC29B4430B704197` |
| **Source Repository HEAD** | `C:\Users\MANTH\Documents\Online_Printer` | Git tree commit `ef7e023` | 2026-10-13 00:58:09 | Source TS files uncompiled to executable |

### 4.2 Discrepancy Evidence
1. The currently running process (PID 18164) is executing the **October 10, 2026** build (`7B9946...`).
2. The latest local executable in `C:\PrintGo\agent` was built on **October 11, 2026** (`1677BD...`), which also predates commit `ef7e023` (October 13, 2026).
3. The stabilization and 15-minute fallback features were committed to Git on October 13 in commit `ef7e023`, but have not yet been packaged into a production executable binary.

---

## Section 5: Verification of Print Safety

### 5.1 Pre-Submission Readiness & Capabilities
- **Location:** `apps/agent/windows/src/paid-print-executor.ts#L119-L135`
- **Behavior:** The executor performs `await this.printer.getStatus(job.windowsPrinterName)`.
- If the printer availability is `OFFLINE` or `BLOCKED`, the agent does not attempt to send the file to SumatraPDF or the Windows Spooler.
- It immediately reports preflight failure to the server (`this.client.reportPreflightFailure`), which evaluates fallback options or releases the lease.

### 5.2 Queue Unstarvation & Safe Holding
- **Location:** `apps/agent/windows/src/paid-print-executor.ts#L154-L168`
- If no fallback printer is eligible, the Worker returns `BLOCKED_RELEASED`. The Agent clears the execution journal for that order, logs `"No fallback available for order ... Lease released to unstarve queue. Retry scheduled."`, and sets `nextDelayMs = 6_000` to process any other orders intended for healthy devices. The paid job is held safely in `PRINT_BLOCKED` or `RETRY_PENDING` without dropping or canceling.

### 5.3 Payment Verification Barrier
- **Location:** `apps/api/worker/src/printing/repository.ts#L639-L642`
- The SQL query that claims jobs for printing enforces:
  ```sql
  AND EXISTS (
    SELECT 1 FROM payments
    WHERE order_id = orders.id
      AND status = 'PAID'
      AND provider_payment_id IS NOT NULL
      AND verified_at_ms IS NOT NULL
  )
  ```
- **Online Orders:** `verified_at_ms` is set only upon cryptographic webhook verification in `apps/api/worker/src/payments/webhook.ts#L40-L75`.
- **Cash Orders:** `verified_at_ms` is populated only when an authenticated administrator submits `POST /api/admin/orders/:id/confirm-cash` (`apps/api/worker/src/payments/repository.ts#L1082-L1099`).
- Unverified orders (`PAYMENT_PENDING`, `CREATED`) cannot be claimed or dispatched under any circumstances.

### 5.4 Duplicate Prevention (Spooler Tracking & Journaling)
- **Location:** `apps/agent/windows/src/paid-print-executor.ts#L47-L104` & `storage/execution-journal.ts`
- Before submission, the step is recorded in local `execution-journal.json`.
- If the agent crashes or restarts during `SUBMISSION_STARTED`:
  - If a `spoolerJobId` was recorded, the agent observes the existing spool job rather than resubmitting.
  - If `spoolerJobId` is missing, the agent reports `status: "UNCERTAIN"` with `failureCode: "UNKNOWN"`, safely stopping execution to prevent duplicate printing.
- Command idempotency (`agent-daemon.ts#L590-L596`): Test print and clear spooler commands track executed IDs in `executedCommandIds` to prevent double-execution.

### 5.5 Findings & Status
- **Status:** **PASS**. All print safety invariants, payment barriers, and duplicate prevention mechanisms are fully implemented and verified.

---

## Section 6: Specific Corrective Action Plan

To bring the live deployment into full alignment with the Phase 8/9 design without disrupting production:

1. **Keep Live Production Intact (No Action Needed Right Now):**
   The running Agent (PID 18164) is stable, safe, and guarding print jobs correctly.
2. **Rebuild Agent Binary When Scheduled:**
   Build the executable from the current repository source (`C:\Users\MANTH\Documents\Online_Printer\apps\agent\windows`) using the existing Node SEA / Inno Setup build pipeline.
   This will package:
   - 120s idle heartbeat when WebSocket is connected.
   - 5 consecutive checks startup stabilization counter.
   - 15-minute physical health check safety fallback.
   - WMI status event hooks.
3. **Configure Physical Printers in Windows / Admin:**
   Before stabilization can engage on machine `BHAVESH`, address `Xprinter XP-TT426B`:
   - Either turn on and unpause the Xprinter, OR
   - In Admin printer settings, toggle the Xprinter to disabled / non-production eligible so that the HP printer is evaluated as 100% healthy by `productionPrinters.every(p => p.status === 'ONLINE')`.
