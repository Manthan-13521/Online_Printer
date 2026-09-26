# Printer Adapter, Test Printing & Windows Spooler Foundation

Phase 8 introduces the printer adapter interface, local diagnostic PDF generation, Windows print spooler integration, deterministic print settings enforcement, and end-to-end test printing from the Admin PWA.

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
    Engine["SumatraPrintEngine (SumatraPDF.exe)"]
    SpoolMon["spool-monitor.ts"]
    Spooler["Windows Print Spooler (Win32_PrintJob)"]
  end

  AdminUI -->|"POST /api/admin/printers/:id/test-print"| WorkerRoutes
  WorkerRoutes -->|"createTestPrintCommand (5m TTL)"| D1
  Daemon -->|"POST /api/agent/heartbeat"| WorkerRoutes
  WorkerRoutes -->|"nextCommand: TEST_PRINT"| Daemon
  Daemon -->|"Generate diagnostic page"| GenPdf
  Daemon -->|"submitPdfJob (Settings & Caps)"| Adapter
  Adapter -->|"Deterministic CLI invocation"| Engine
  Engine -->|"Direct Spool Submission"| Spooler
  Daemon -->|"POST /api/agent/commands/:id/report (SUBMITTED)"| WorkerRoutes
  SpoolMon -->|"Poll Win32_PrintJob (bounded 15s)"| Spooler
  SpoolMon -->|"Completed / Blocked / Failed"| Daemon
  Daemon -->|"POST /api/agent/commands/:id/report (RESULT)"| WorkerRoutes
  WorkerRoutes -->|"Update status & finished_at"| D1
  AdminUI -->|"Poll GET /api/admin/printers/:id/test-print"| WorkerRoutes
```

---

## 2. Windows PDF Printing Mechanism Audit

### Legacy `Start-Process -Verb PrintTo` Assessment

Prior to this remediation, Windows print submission used the Windows ShellExecute verb:

```powershell
Start-Process -FilePath $pdf -Verb PrintTo -ArgumentList "`"$printer`""
```

#### Fatal Flaws of `PrintTo` in Commercial / Unattended Environments:

1. **File Association Dependency**: `PrintTo` queries Windows Registry (`HKCR\.pdf\shell\printto\command`). It depends entirely on whichever PDF reader owns `.pdf` on the shop PC. On default Windows installations, Microsoft Edge owns `.pdf` and does not reliably implement unattended `PrintTo`. If Adobe Acrobat Reader is installed, it may show splash screens, update dialogs, or stay hung in memory. If no reader is registered, `PrintTo` errors immediately.
2. **Interactive / Session 0 Incompatibility**: `PrintTo` is a GUI ShellExecute verb. When PrintGo runs as a Windows background service or startup scheduled task (Session 0), ShellExecute calls fail or hang indefinitely.
3. **No Direct Support for Print Settings**: `PrintTo` syntax across Windows provides no programmatic switches for:
   - Paper Size (A4 vs. A3)
   - Color Mode (Monochrome vs. Color)
   - Duplex (Single-sided vs. Double-sided)
   - Copies (e.g., 3 copies)
   - Page Range (e.g., pages 2–7)
     It prints using whatever default profile was left in the GUI viewer or Windows driver preferences.
4. **No Page-Range Enforcement**: A 50-page PDF with an authorized page range of pages 2–7 prints all 50 pages under `PrintTo`, creating a severe cost and security hazard.

---

## 3. Final Deterministic Windows Printing Mechanism

### SumatraPDF CLI Integration

PrintGo isolates and replaces `PrintTo` with a deterministic, headless CLI print engine using **SumatraPDF**:

```powershell
SumatraPDF.exe -print-to "<exact_printer>" -print-settings "<copies>x,paper=<paperSize>,<colorMode>,<duplex>,<pageRange>,fit" -silent "<pdfPath>"
```

### Third-Party Component Specification

| Property                 | Details                                                                                                                                                                                                                                                                 |
| :----------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Name**                 | SumatraPDF (Portable Command-Line PDF Engine)                                                                                                                                                                                                                           |
| **Version Strategy**     | Pinned 64-bit release (e.g., v3.5.2 portable single binary)                                                                                                                                                                                                             |
| **License**              | GPLv3 (with Apache 2.0 / MuPDF components)                                                                                                                                                                                                                              |
| **Redistribution Terms** | Redistributable alongside PrintGo as an independent external binary (CLI execution qualifies as mere aggregation under GPL FAQ, preserving proprietary boundaries of PrintGo). Source code is open on GitHub.                                                           |
| **Binary Size**          | ~14.5 MB single portable executable (zero DLLs, zero registry writes, zero installation)                                                                                                                                                                                |
| **Why Needed**           | Only zero-dependency Windows utility that supports comprehensive programmatic headless print setting overrides (paper size, duplex, color mode, copies, page range, scaling) without interactive UI, COM dependencies, or Adobe Acrobat.                                |
| **How Bundled**          | Placed in `apps/agent/windows/vendor/SumatraPDF.exe` via the Windows installer. Resolved dynamically in order: (1) `PRINTGO_SUMATRA_PATH` environment variable, (2) bundled application vendor path, (3) standard Program Files / AppData locations, (4) system `PATH`. |

---

## 4. Print Settings Contract & Fail-Closed Protection

The adapter contract strictly enforces print settings before submitting to the spooler:

```ts
export interface PrintSettings {
  printerName?: string;
  paperSize: "A4" | "A3";
  colorMode: "COLOUR" | "BLACK_AND_WHITE";
  sides: "ONE_SIDED" | "TWO_SIDED_LONG" | "TWO_SIDED_SHORT";
  copies: number;
  pageRange?: string;
}
```

### Silent Downgrade Prevention (Fail Closed)

PrintGo **never silently downgrades** customer settings:

- **A3 on A4 Printer**: If a printer does not support A3, submission throws `UnsupportedPrintSettingError`. Downgrading to A4 is prohibited.
- **COLOUR on Monochrome Printer**: If a printer does not support color (`colour === false`), submission throws `UnsupportedPrintSettingError`. Downgrading to black & white is prohibited.
- **DUPLEX on Simplex Printer**: If a printer does not support duplex (`duplex === false`), submission throws `UnsupportedPrintSettingError`. Downgrading to single-sided is prohibited.
- **Copies**: Must be an integer >= 1 and <= 100. Values <= 0 throw `InvalidPrintSettingError`.
- **Page Range**: Parsed and validated via `parsePageRange()`. Malformed ranges throw `InvalidPrintSettingError`.
- **Missing SumatraPDF Guard**: If SumatraPDF is missing from the host machine and any non-default option is requested (A3, color, duplex, page range, or copies > 1), submission immediately fails closed with an informative error rather than executing an unverified fallback.

---

## 5. Spooler Correlation & Job Isolation

PrintGo implements multi-factor correlation to guarantee that the Agent tracks **only its own print jobs** and never claims an unrelated document printed by another application:

1. **Pre-Submission Job ID Snapshot**:
   Before launching the print engine, the Agent records all active job IDs for the specific printer:
   `$beforeIds = @(Get-CimInstance Win32_PrintJob | Where-Object { $_.Name -like "$printer,*" } | ForEach-Object { [int]$_.JobId })`
2. **Unique Document Identifier**:
   The diagnostic or order PDF filename includes an unpredictable unique token (e.g., `printgo-test-<commandId>`).
3. **Correlation Query**:
   The Agent polls `Win32_PrintJob` requiring:
   - Target printer queue match: `$_.Name -like "$printer,*"`
   - Exclusion of pre-existing jobs: `$beforeIds -notcontains [int]$_.JobId`
   - Document title match: `$_.Document -like "*$docIdentifier*"`
4. **Isolation Guarantee**:
   If another application (Chrome, Microsoft Word, Windows Update) submits a print job to the shop printer during the same second, its job ID will not match `$docIdentifier` and will **never be claimed or monitored by PrintGo**.

### Documented Spooler Limitations

- Certain specialized or legacy printer drivers replace the document title with a static string (e.g., `"RAW"` or `"Document"`). In such rare environments, the correlation engine uses printer-scoped temporal exclusion (`$beforeIds`) as a secondary safeguard.
- On ultra-fast RAM-spooled local printers, small documents may despool and be removed within 200ms before `Get-CimInstance` polls. The monitor handles this gracefully via `COMPLETED_OR_REMOVED`.

---

## 6. Background / Windows Service Compatibility

The deterministic printing architecture is designed for headless, unattended background execution:

- **Process Flags**: `UseShellExecute = $false`, `CreateNoWindow = $true`, `WindowStyle = Hidden`.
- **CLI Flags**: `-silent` flag prevents splash screens, print progress bars, and modal error dialogs.
- **Session 0 Safe**: Does not depend on the interactive user desktop, desktop shells, or user file associations.

---

## 7. Spool Monitoring & `BLOCKED != FAILED`

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

---

## 8. Real Windows Testing Status (Rule 44 Disclosure)

> [!NOTE]
> **Real Windows printer execution remains unverified.**
> Development and automated test verification occurred on macOS using mock executors and architecture contract suites. Physical spooling of paper on real Windows hardware must be verified on an actual Windows PC.
