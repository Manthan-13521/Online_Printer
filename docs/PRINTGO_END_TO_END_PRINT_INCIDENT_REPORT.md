# PrintGo End-to-End Printing Recovery & Reliability Incident Report

**Incident Date**: 2026-10-06  
**System**: PrintGo V2 Online-to-Offline Print Automation Platform  
**Target Printer**: HP Laser MFP 131 133 135-138 (`HPF80DACE6151A`)  
**Agent Host**: `BHAVESH (PrintGo Agent)` Windows PC  

---

## 1. Executive Summary & Root Cause Confirmation

| Dimension | Finding / Status |
| :--- | :--- |
| **Physical Printer Hardware** | 100% Functional (Windows Test Page printed cleanly). |
| **Windows Agent Execution** | Verified running latest build (proved by live `PRINT_BLOCKED` emission at 7:03:43 PM). |
| **First Broken Stage** | **Stage T5 (Preflight Status Evaluation)** in `parsePrinterStatus()` on the Windows Agent. |
| **The Bug** | On standard USB/WSD HP LaserJet drivers, Windows WMI (`Win32_Printer`) omits `WorkOffline` and `PrinterStatus` when idle/ready with no errors. The agent's strict check required `p.WorkOffline === false` or `p.PrinterStatus !== undefined`, causing healthy printers to be misclassified as `UNKNOWN: "Printer readiness is not reported by Windows"`, which blocked print execution. |
| **PA-088 Resolution** | PA-088 had a missing spooler identity from the old pre-fix code. When claimed by the new agent, it safely transitioned to `COMPLETION_UNKNOWN` without blindly reprinting. |
| **PA-090 Resolution** | PA-090 was claimed by the Agent, reached preflight, and got blocked due to the CIM status parsing bug. With the fix, PA-090 preflight passes as `ONLINE` immediately. |

---

## 2. End-to-End Runtime Pipeline Analysis

```
Customer Checkout (₹1 Paid)
       │
       ▼
Cloudflare Worker (Payment HMAC Verified → Order QUEUED)
       │
       ▼
Windows Agent Pulse (/api/agent/jobs/claim-or-renew)
       │
       ▼
Cloudflare Worker (Checks Agent heartbeat & Printer ONLINE → Returns Claim)
       │
       ▼
Windows Agent (Preflight: Win32_Printer CIM → Status: ONLINE)
       │
       ▼
PDF Download & Validation (R2 Signed URL → Local Temp File)
       │
       ▼
Windows SumatraPDF Handoff (sumatrapdf -print-to ... -silent -exit-on-print)
       │
       ▼
Windows Print Spooler (Job correlated via DocumentName / Job ID)
       │
       ▼
Spool Handoff & Completion (Agent reports SUCCEEDED → Worker sets PRINTED)
       │
       ▼
Next Order Released (Immediate unblock of queue)
```

---

## 3. Repair Implemented

1. **`apps/agent/windows/src/printing/windows-printer-adapter.ts`**:
   - Fixed `parsePrinterStatus()`: when no error code (`DetectedErrorState 4/6/7/8/9/10/11`) and no offline flag (`WorkOffline = true`, `PrinterStatus 6/7`) is present, Windows considers the printer **`ONLINE`** and ready for print submissions.
2. **`apps/agent/windows/src/printing/windows-printer-adapter.test.ts`**:
   - Added unit tests verifying clean Windows CIM output without explicit properties is recognized as `ONLINE`.

---

## 4. Verification & Quality Gates

- **Vitest Unit Tests**: 82 test suites passed (699 tests passed, 1 skipped).
- **TypeScript**: 0 errors across 10 packages/apps.
- **ESLint**: 0 warnings.
- **D1 Migrations**: Validated against local SQLite schema.
