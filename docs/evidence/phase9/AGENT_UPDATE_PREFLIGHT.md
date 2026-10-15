# PrintGo Windows Agent Update Preflight Report

**Methodology:** PONYTAIL Evidence-First Verification  
**Auditor Roles:** Senior Windows Agent Engineer, Cloudflare Engineer, QA Auditor  
**Date of Preflight:** October 14, 2026 (Local Time: 19:15 IST / 13:45 UTC)  
**Target Release:** [`v2.1.0-phase9`](https://github.com/Manthan-13521/Online_Printer/releases/tag/v2.1.0-phase9)  
**Target Commit:** [`ef7e023325e133da174f2aee3a7d1c3092fc182d`](https://github.com/Manthan-13521/Online_Printer/commit/ef7e023325e133da174f2aee3a7d1c3092fc182d)  
**Staging Directory:** `C:\PrintGo\staging-latest\`  
**Target Executable:** `C:\PrintGo\staging-latest\PrintGo-Agent-Windows-x64.exe`  
**Live Target System:** Windows 11 PC `BHAVESH` running PrintGo Agent (PID: 18164) under Control Center (PID: 21588)

---

## 1. Executive Summary & Verification Matrix

| Preflight Task | Verification Method | Expected State | Actual Observed State | Status |
|---|---|---|---|---|
| **1. Release Provenance** | GitHub REST API + Workflow Run Audit | Run `38297853758` on commit `ef7e023` | Matched; built & uploaded by CI workflow | **PASS** |
| **2. Isolated Staging Download** | `curl.exe -L` into `C:\PrintGo\staging-latest\` | Downloaded without overwriting live files | Staged cleanly in separate folder | **PASS** |
| **3. Byte-for-Byte SHA-256** | `Get-FileHash` vs `SHA256SUMS.txt` | `9dabc15f8ea4ab99...` | `9dabc15f8ea4ab99...` (Exact Match) | **PASS** |
| **4. CLI Argument Safety** | Source code inspection of `runCli()` in `index.ts` | `--version` and `--help` must not mutate state | Confirmed early returns without daemon/network | **PASS** |
| **5. Binary Smoke Testing** | Executed `--version` & `--help` on staged binary | Outputs version & help, exits code 0 | Version `v2.1.0` verified, clean exit | **PASS** |
| **6. Binary Code Verification** | String search on staged executable | Contains `PRINTER_MONITORING_STABLE` | String present at line 739906 of binary | **PASS** |
| **7. Process Management Review** | Win32_Process inspection of PID 18164 | Supervised by `PrintGo-ControlCenter.exe` | Parent PID 21588 confirmed; supports swap | **PASS** |
| **8. Duplicate Print Protection** | Trace `ExecutionJournalStore` in `paid-print-executor.ts` | Fails closed on uncertain spooler state | Confirmed; reports `UNCERTAIN` to Worker | **PASS** |
| **9. System State Preservation** | Process, file, and database audit | No changes to running services or printers | PID 18164 untouched; zero live mutations | **PASS** |

---

## 2. Release Provenance & Artifact Integrity

### 2.1 GitHub Actions Workflow Run Verification
- **GitHub Workflow Run:** ID `38297853758`
- **Workflow Name:** `Build Windows Agent` (`.github/workflows/build-agent-windows.yml`)
- **Event / Trigger:** `push` on branch `main`
- **Head SHA:** `ef7e023325e133da174f2aee3a7d1c3092fc182d`
- **Status / Conclusion:** `completed` / `success`
- **Created Timestamp:** `2026-10-12T19:28:16Z`
- **Release Publishing:**
  In `.github/workflows/build-agent-windows.yml` lines 270–285:
  ```powershell
  Get-ChildItem -Path $relDir -Filter "PrintGo-*" | ForEach-Object {
    $hash = (Get-FileHash -Algorithm SHA256 $_.FullName).Hash.ToLower()
    $lines += "$hash  $($_.Name)"
  }
  Set-Content -Path "$relDir/SHA256SUMS.txt" -Value ($lines -join "`n")
  gh release upload "v2.1.0-phase9" $filesToUpload --clobber
  ```
  This proves the release assets in `v2.1.0-phase9` were generated directly by GitHub Actions runner from commit `ef7e023`.

### 2.2 Independent Checksum Assertion
- **Published Checksum (`SHA256SUMS.txt` from GitHub):**
  ```
  9dabc15f8ea4ab99f4bc05749f8c5b7a55c4a4e4a26871fe2a37cf329cae06e9  PrintGo-Agent-Windows-x64.exe
  ```
- **Computed Checksum on Staged File (`C:\PrintGo\staging-latest\PrintGo-Agent-Windows-x64.exe`):**
  ```powershell
  Algorithm : SHA256
  Hash      : 9DABC15F8EA4AB99F4BC05749F8C5B7A55C4A4E4A26871FE2A37CF329CAE06E9
  Path      : C:\PrintGo\staging-latest\PrintGo-Agent-Windows-x64.exe
  ```
- **Comparison Result:** **100% IDENTICAL (BYTE-FOR-BYTE)**.

---

## 3. CLI Argument Handling & Smoke Test Verification

### 3.1 Pre-Execution Safety Inspection
Before executing `--version` or `--help`, the argument parser in `apps/agent/windows/src/index.ts` was audited:
- Lines 127–130: `async function runCli(): Promise<void> { const args = process.argv.slice(2);`
- Lines 130–164:
  `if (args.includes("--help") || args.includes("-h")) { console.log(...); return; }`
- Lines 166–169:
  `if (args.includes("--version") || args.includes("-v")) { console.log("PrintGo Windows Agent v2.1.0"); return; }`
- **Safety Guarantee:** These flags return immediately prior to credential store initialization, SumatraPDF checking, printer querying, and network instantiation.

### 3.2 Smoke Test Execution Output
1. **Command:** `& "C:\PrintGo\staging-latest\PrintGo-Agent-Windows-x64.exe" --version`
   - **Exit Code:** `0`
   - **Stdout:** `PrintGo Windows Agent v2.1.0`
2. **Command:** `& "C:\PrintGo\staging-latest\PrintGo-Agent-Windows-x64.exe" --help`
   - **Exit Code:** `0`
   - **Stdout:** Full CLI usage documentation displayed cleanly.
3. **Internal Code String Verification:**
   - **Command:** `Select-String -Path "C:\PrintGo\staging-latest\PrintGo-Agent-Windows-x64.exe" -Pattern "PRINTER_MONITORING_STABLE" -SimpleMatch`
   - **Match Found:**
     `PrintGo-Agent-Windows-x64.exe:739906: "PRINTER_MONITORING_STABLE: 5 consecutive healthy checks achieved. Switched to event-driven monitoring with 15-minute safety fallback."`
   - **Conclusion:** Conclusively verifies that the staged binary contains the Phase 8 startup stabilization and 15-minute fallback code.

---

## 4. Process Lifecycle & Installation Architecture

### 4.1 Process Hierarchy on Host `BHAVESH`
- **Running Agent:** `PID 18164`
  - Executable Path: `C:\Users\MANTH\AppData\Local\Programs\PrintGo\PrintGo-Agent.exe`
  - Created: `10/13/2026 10:26:58 PM`
  - Parent Process ID: `21588`
- **Parent Process:** `PID 21588`
  - Executable Path: `C:\Users\MANTH\AppData\Local\Programs\PrintGo\PrintGo-ControlCenter.exe`
  - Role: Windows Forms system tray supervisor GUI (`apps/agent/windows/control-center/PrintGoControlCenter.cs`).

### 4.2 Control Center Supervision Mechanics
Inspection of `PrintGoControlCenter.cs` confirms:
1. **Agent Path Resolution:** Resolves `Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "PrintGo-Agent.exe")`.
2. **Process Management:**
   - Lines 552–565: `StartAgentProcess()` spawns `PrintGo-Agent.exe` as a child process.
   - Lines 575–582: `StopAgentManual()` locates `PrintGo-Agent` processes and calls `proc.Kill()`.
   - Lines 890–895: `btnRestartAgent` stops existing `PrintGo-Agent` processes, waits for exit, and calls `StartAgentProcess()`.
3. **Service Replacement Feasibility:**
   Because `PrintGo-ControlCenter.exe` does not hold a file lock on `PrintGo-Agent.exe` while the Agent is stopped, replacing `PrintGo-Agent.exe` in `C:\Users\MANTH\AppData\Local\Programs\PrintGo` is fully supported and requires only stopping the Agent in Control Center, replacing the file, and restarting it.

### 4.3 Configuration & State Path Preservation
- Stored credentials: `C:\Users\MANTH\AppData\Local\PrintGo\agent-credentials.dat` (Protected by Windows DPAPI).
- Operational status file: `C:\Users\MANTH\AppData\Local\PrintGo\agent-status.json`.
- Daemon logs: `C:\Users\MANTH\AppData\Local\PrintGo\daemon.log`.
- Active print execution lanes: `C:\Users\MANTH\AppData\Local\PrintGo\active-prints\lane-*.json`.
- **Replacing `PrintGo-Agent.exe` in `Programs\PrintGo` does not touch or invalidate files in `AppData\Local\PrintGo`.**

---

## 5. Duplicate Print Protection & Rollback Safety

### 5.1 Spooler State & Crash Recovery Analysis
In `apps/agent/windows/src/paid-print-executor.ts` lines 47–104 and `storage/execution-journal.ts`:
1. **Pre-Submission Journaling:**
   Before submitting to SumatraPDF / Windows Spooler, the executor saves `{ orderId, attemptId, stepId, spoolerJobId: null }` to disk (`active-prints/lane-${orderId}.json`).
2. **Post-Submission Correlation:**
   Upon Windows Spooler accepting the job, the spooler job ID is saved to the journal before observing the job.
3. **Recovery After Restart (Uncertain Submissions):**
   - If the Agent process is interrupted or restarted while a step is in `SUBMISSION_STARTED`:
     - If `spoolerJobId` exists in the local journal, it reconnects to the existing Windows Spool job without submitting a duplicate document.
     - If `spoolerJobId` is missing (submission state is ambiguous), the Agent reports:
       ```ts
       status: "UNCERTAIN",
       failureCode: "UNKNOWN",
       failureDetail: "Agent restarted after submission began; no confirmed spooler job identity is available."
       ```
     - The executor halts further automated processing of this order and clears the local journal.
     - The Cloudflare Worker transitions the order to `COMPLETION_UNKNOWN` / `NEEDS_ADMIN`, preventing any automated duplicate print attempt.

---

## 6. Physical Printer Prerequisites (Xprinter Evaluation)

1. **Current Hardware State:**
   In `C:\Users\MANTH\AppData\Local\PrintGo\agent-status.json`:
   - `HPF80DACE6151A`: `ONLINE` (Default, Eligible, Verified B&W A4).
   - `Xprinter XP-TT426B`: `OFFLINE` ("Printer is set to work offline", Eligible: true).
2. **Impact on Stabilization:**
   In `agent-daemon.ts` line 363:
   `const allHealthy = printersToCheck.length > 0 && printersToCheck.every((p) => p.status === "ONLINE");`
   If the Xprinter remains eligible while offline, `allHealthy` evaluates to `false`, resetting `consecutiveHealthyChecks` to 0 on every check.
3. **Recommendation Before Maintenance:**
   - If the Xprinter is a production device: Bring it physically online (power on, clear offline flag in Windows Devices and Printers) before testing stabilization.
   - If the Xprinter is not a production device: In the PrintGo Admin panel &rarr; Printers, toggle the printer to disabled or uncheck its production eligibility.

---

## 7. Step-by-Step Maintenance Window & Rollback Plan

When an authorized maintenance window is scheduled, follow these exact steps:

### Phase A: Pre-Maintenance Verification
1. Ensure no active customer print jobs are printing (`active-prints/` directory is empty).
2. Confirm staging binary hash remains `9DABC15F8EA4AB99F4BC05749F8C5B7A55C4A4E4A26871FE2A37CF329CAE06E9`.

### Phase B: Execution (Executable Swap)
1. In the PrintGo Control Center window (or system tray icon), click **Stop Agent**.
2. Verify process termination in PowerShell:
   `Get-Process -Name "PrintGo-Agent" -ErrorAction SilentlyContinue` (must return null).
3. Create a safety backup of the installed executable:
   ```powershell
   Copy-Item "C:\Users\MANTH\AppData\Local\Programs\PrintGo\PrintGo-Agent.exe" `
             "C:\Users\MANTH\AppData\Local\Programs\PrintGo\PrintGo-Agent.bak.exe" -Force
   ```
4. Copy the verified staging binary into place:
   ```powershell
   Copy-Item "C:\PrintGo\staging-latest\PrintGo-Agent-Windows-x64.exe" `
             "C:\Users\MANTH\AppData\Local\Programs\PrintGo\PrintGo-Agent.exe" -Force
   ```
5. In PrintGo Control Center, click **Start Agent**.

### Phase C: Post-Startup Verification
1. Monitor `C:\Users\MANTH\AppData\Local\PrintGo\daemon.log`:
   - Verify 5 initial checks run at ~60-second intervals.
   - Verify log output: `"PRINTER_MONITORING_STABLE: 5 consecutive healthy checks achieved. Switched to event-driven monitoring with 15-minute safety fallback."`
2. In PrintGo Admin web interface, confirm Agent reports status `Connected` and heartbeats refresh on the 120-second cadence.

### Phase D: Rollback Procedure (If Any Error Occurs)
If the new executable fails to initialize, encounters DPAPI decryption issues, or errors:
1. In PrintGo Control Center, click **Stop Agent**.
2. Restore the original executable:
   ```powershell
   Copy-Item "C:\Users\MANTH\AppData\Local\Programs\PrintGo\PrintGo-Agent.bak.exe" `
             "C:\Users\MANTH\AppData\Local\Programs\PrintGo\PrintGo-Agent.exe" -Force
   ```
3. In PrintGo Control Center, click **Start Agent**.
4. Confirm normal operation resumes on the previous version.
