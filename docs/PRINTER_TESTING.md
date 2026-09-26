# Printer Adapter, Test Printing & Windows Spooler Foundation

Phase 8 introduces the printer adapter interface, local diagnostic PDF generation, Windows print spooler integration, and end-to-end test printing from the Admin PWA.

This phase establishes printer hardware communication **without touching customer PDFs, downloading from R2, or leasing customer jobs**.

---

## 1. Test Printing Architecture

```mermaid
flowchart TD
  subgraph Admin PWA
    AdminUI["/admin/printers [Test Print]"]
  end

  subgraph Cloudflare Worker API
    WorkerRoutes["Admin / Agent Routes"]
    AgentService["AgentService"]
    D1["D1 (printer_test_commands, audit_logs)"]
  end

  subgraph Windows Agent (Shop PC)
    Daemon["AgentDaemon"]
    GenPdf["diagnostic-pdf.ts"]
    Adapter["WindowsPrinterAdapter"]
    SpoolMon["spool-monitor.ts"]
    Spooler["Windows Print Spooler (Win32_PrintJob)"]
  end

  AdminUI -->|"POST /api/admin/printers/:id/test-print"| WorkerRoutes
  WorkerRoutes -->|"createTestPrintCommand (5m TTL)"| D1
  Daemon -->|"POST /api/agent/heartbeat"| WorkerRoutes
  WorkerRoutes -->|"nextCommand: TEST_PRINT"| Daemon
  Daemon -->|"Generate diagnostic page"| GenPdf
  Daemon -->|"submitPdfJob (PrintTo)"| Adapter
  Adapter -->|"Submit & Get Job ID"| Spooler
  Daemon -->|"POST /api/agent/commands/:id/report (SUBMITTED)"| WorkerRoutes
  SpoolMon -->|"Poll Win32_PrintJob (bounded 15s)"| Spooler
  SpoolMon -->|"Completed / Blocked / Failed"| Daemon
  Daemon -->|"POST /api/agent/commands/:id/report (RESULT)"| WorkerRoutes
  WorkerRoutes -->|"Update status & finished_at"| D1
  AdminUI -->|"Poll GET /api/admin/printers/:id/test-print"| WorkerRoutes
```

---

## 2. End-to-End Test Print Flow

### Step 1: Admin Triggers Test Print

1. Admin navigates to `/admin/printers` and clicks **[Test Print]** on an enabled printer.
2. Browser issues `POST /api/admin/printers/:printerId/test-print`.
3. Worker validates:
   - Printer exists and is `enabled === 1`.
   - Agent is active and online (`nowMs - lastHeartbeatAtMs <= 90_000`).
4. Worker inserts row into `printer_test_commands`:
   - `status`: `PENDING`
   - `expires_at_ms`: `nowMs + 300_000` (5 minutes)
   - Writes `TEST_PRINT_REQUESTED` audit log.
5. Returns `201 Created` with command details.

### Step 2: Agent Receives Command via Heartbeat

1. Windows Agent sends routine heartbeat `POST /api/agent/heartbeat`.
2. Worker finds oldest valid `PENDING` command for this `agent_id` where `expires_at_ms > nowMs`.
3. Worker atomically claims the command:
   ```sql
   UPDATE printer_test_commands
   SET status = 'CLAIMED', claimed_at_ms = ?
   WHERE id = ? AND status = 'PENDING'
   ```
4. Heartbeat response includes `nextCommand`:
   ```json
   {
     "acknowledged": true,
     "serverTimeMs": 1740000000000,
     "nextCommand": {
       "commandId": "b8a5b281-...",
       "type": "TEST_PRINT",
       "printerId": "printer_123",
       "windowsPrinterName": "Canon MF4700 Series",
       "expiresAtMs": 1740000300000
     }
   }
   ```

### Step 3: Diagnostic PDF Generation

1. The Agent generates a local single-page A4 PDF using `generateDiagnosticPdf`:
   - Pure TypeScript raw PDF generation without third-party binaries or network calls.
   - Distinct header: `PRINTGO TEST PAGE` and `NOT A CUSTOMER ORDER`.
   - Diagnostic metadata: Timestamp, Target Printer, Agent Name, Command ID, and Printer Test Pattern.
2. Written to a temporary file on the local filesystem (`temp-test-print-{commandId}.pdf`).

### Step 4: Submission to Windows Spooler

1. Agent invokes `PrinterAdapter.submitPdfJob`:
   ```powershell
   Start-Process -FilePath $pdfPath -Verb PrintTo -ArgumentList "`"$printerName`"" -PassThru
   ```
2. Agent queries `Get-CimInstance Win32_PrintJob` scoped to this printer and detects the newly assigned Windows spooler job ID.
3. Agent immediately reports `SUBMITTED` with `spoolerJobId` back to the Worker API (`POST /api/agent/commands/:commandId/report`).
4. Temporary diagnostic PDF is securely deleted in a `finally` block.

### Step 5: Bounded Spool Monitoring & `BLOCKED != FAILED`

1. `monitorSpoolJob` polls `getJobStatus` up to a bounded deadline (default: 15 seconds, 1-second intervals).
2. Spooler status bitmask mapping (`Win32_PrintJob.JobStatus` & `Win32_PrintJob.StatusMask`):
   - **`COMPLETED_OR_REMOVED`**: Job was successfully spooled and handed off to physical printer hardware. Marked `SUCCEEDED`.
   - **`BLOCKED`**: The spooler reported a recoverable physical condition:
     - `PAPER_OUT` (`JobStatus` contains "PaperOut", bit `0x40`)
     - `PAPER_JAM` (`JobStatus` contains "Jam", "PaperJam")
     - `DOOR_OPEN` (`JobStatus` contains "Door", "Cover")
     - `OFFLINE` (`JobStatus` contains "Offline", bit `0x20`)
     - `USER_INTERVENTION` (bit `0x400`)
     - **CRITICAL RULE**: The job remains in the spooler and is **NEVER automatically resubmitted**. Reloading paper or closing the door causes the printer to resume printing from the spooler automatically; resubmitting would cause duplicate printing.
   - **`FAILED`**: The spooler reported a fatal, unrecoverable error (`Status == "Error"`, bit `0x02`).
   - **`PRINTING` / Timeout**: If the spooler is still actively spooling or printing when the 15-second wait deadline expires, the job was accepted by the spooler and is reported as `SUCCEEDED` (or left in progress).

### Step 6: Agent Reports Result

Agent issues `POST /api/agent/commands/:commandId/report`:

```json
{
  "status": "SUCCEEDED",
  "spoolerJobId": "42"
}
```

Worker updates `printer_test_commands`, sets `finished_at_ms = nowMs`, and logs the corresponding audit event.

### Step 7: Admin UI Progression & Feedback

The Admin PWA at `/admin/printers` reflects the real-time lifecycle:

- `Sending test page…` (immediate UI feedback upon click)
- `Waiting for Agent…` (`PENDING`)
- `Agent claimed command…` (`CLAIMED`)
- `Submitted to printer…` (`SUBMITTED`)
- `✓ Test page submitted successfully.` (`SUCCEEDED`)
- `⚠ Printer needs attention: [reason]` (`BLOCKED`)
- `✕ Test print failed: [reason]` (`FAILED`)
- `✕ Test print timed out waiting for Agent.` (`EXPIRED`)
- `[Try Test Print Again]` button when finished.

Polling runs every 2 seconds while any test print is active, and the latest status is preserved across page refreshes.

---

## 3. Security & Negative Scope Enforcements

1. **No Customer PDFs**:
   - Customer PDFs in R2 are not downloaded, accessed, or printed in Phase 8.
   - Diagnostic PDF is strictly generated on the local agent host and marked "NOT A CUSTOMER ORDER".
2. **No Customer Job Claiming**:
   - Customer orders remain in database queues without agent leasing.
   - Phase 9 identification sheets and Phase 10 order queues are not started.
3. **No Credential Exposure**:
   - Agent reports require `Bearer <agentSecret>` authentication.
   - Admin test print endpoints require active session authentication with CSRF/origin checks.
4. **Command Lifetime & Expiry**:
   - Commands expire after 5 minutes (`TEST_PRINT_COMMAND_LIFETIME_MS = 300_000`).
   - Stale commands are expired lazily or on heartbeat.

---

## 4. Platform Testing Disclosure

Development and automated testing for Phase 8 were conducted on macOS using mock adapters and architecture tests.

- `WindowsPrinterAdapter` contains full production PowerShell and CIM queries for Windows, guarded by runtime OS checks that throw in production if executed on a non-Windows OS.
- In development/test environments, `DevelopmentPrinterAdapter` simulates spooler behavior, including success, `BLOCKED` (paper out, offline), and `FAILED` states.
- **Real Windows spooler integration on an actual Windows machine was not exercised on this development host.** Full physical validation will take place when the agent is deployed to the shop PC.
