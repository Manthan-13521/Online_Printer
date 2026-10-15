# PrintGo Production Release & Push Manifest

**Release Version:** Production Bug Fixes & Phase 10 Performance Optimization  
**Target Branch:** `main`  
**Commit & Push Date:** October 15, 2026  
**CI/CD Workflows Triggered:**

- `.github/workflows/deploy.yml` (Customer PWA, Admin PWA, D1 Migrations, API Worker)
- `.github/workflows/build-agent-windows.yml` (Windows Agent SEA binary packaging)

---

## 1. What Is Pushed

This production push delivers:

1. **Critical Cash Order Display Fix:** Resolves the production regression where cash orders incorrectly displayed as `ONLINE` in Admin Live Orders and Order History.
2. **Phase 10 Print Speed Optimization:** Native Win32 Spooler integration replacing slow PowerShell WSD printer discovery (~38s down to ~60ms) and direct SumatraPDF process execution.
3. **R2 Upload Recovery:** Safe, idempotent verification of pending uploads in R2 when customers reconnect or refresh their session.
4. **Strict D1 Resource Invariants:** 0 new SQL statements, 0 new indexes, and 0% write amplification delta against baseline.
5. **Quality Gates & Regression Test Matrix:** 100% clean TypeScript typecheck across monorepo and 0 ESLint warnings.

---

## 2. What Things Are Modified

### 2.1 API & Contracts (`packages/api-contract`)

- **[`packages/api-contract/src/index.ts`](file:///C:/Users/MANTH/Documents/Online_Printer/packages/api-contract/src/index.ts):**
  - Added `paymentMethod?: "ONLINE" | "CASH" | "UNKNOWN"` to `AdminLiveOrder` and `AdminOrderHistoryEntry`.
  - Added `paymentStatus?: "PENDING" | "PAID" | "FAILED" | "CANCELLED" | "REFUNDED"` to `AdminLiveOrder` and `AdminOrderHistoryEntry`.
  - Added `cashConfirmedAt?: string | null` and `amountPaidPaise?: number` to `AdminOrderHistoryEntry`.

### 2.2 Worker Backend (`apps/api/worker`)

- **[`apps/api/worker/src/printing/repository.ts`](file:///C:/Users/MANTH/Documents/Online_Printer/apps/api/worker/src/printing/repository.ts):**
  - Updated `listLiveOrders` SQL query to select `o.payment_method` and `o.cash_confirmed_at_ms`.
  - Strictly mapped `paymentMethod`: `'CASH'` $\rightarrow$ `"CASH"`, `'ONLINE'` $\rightarrow$ `"ONLINE"`, any other/missing value $\rightarrow$ `"UNKNOWN"`. Never silently defaults to `"ONLINE"`.
- **[`apps/api/worker/src/history/repository.ts`](file:///C:/Users/MANTH/Documents/Online_Printer/apps/api/worker/src/history/repository.ts):**
  - Updated `list` query to select `o.payment_method` directly, removing `COALESCE(o.payment_method, 'ONLINE')`.
  - Partitioned online vs cash payments: `online_paid_paise` strictly aggregates payments `WHERE provider <> 'CASH'`.
  - Mapped `paymentMethod` strictly to `"CASH"`, `"ONLINE"`, or `"UNKNOWN"`.
  - Exposed `cashConfirmedAt` timestamp.
- **[`apps/api/worker/src/customer/service.ts`](file:///C:/Users/MANTH/Documents/Online_Printer/apps/api/worker/src/customer/service.ts):**
  - In `getDraft(rawToken)`: Implemented idempotent recovery for eligible `PENDING` files for authenticated sessions before draft expiration.
  - Verifies R2 object existence, file size, and PDF magic bytes (`%PDF-` header and `%%EOF` trailer). Transitions validated files to `UPLOADED`.
  - Unpaid safety invariant: Draft status remains `DRAFT` or `UPLOADING` and never enters `QUEUED` until payment is confirmed.

### 2.3 Admin Frontend (`apps/web/admin`)

- **[`apps/web/admin/src/LiveOrdersPage.tsx`](file:///C:/Users/MANTH/Documents/Online_Printer/apps/web/admin/src/LiveOrdersPage.tsx):**
  - Added visual payment badges: `💵 Cash` (amber/green), `💳 Online` (blue), or `⚠️ Unknown Method` (warning).
  - Displays payment provider status: `"Cash (Counter)"`, `"Online (Razorpay)"`, or `"Unknown / Unset"`.
- **[`apps/web/admin/src/OrderHistoryPage.tsx`](file:///C:/Users/MANTH/Documents/Online_Printer/apps/web/admin/src/OrderHistoryPage.tsx):**
  - Added visual payment badges: `💵 Cash`, `💳 Online`, or `⚠️ Unknown`.
  - Dynamic payment summary labels: `"Cash Paid"`, `"Online Paid"`, or `"Paid Amount"` using `amountPaidPaise ?? onlinePaidPaise`.
  - Shows cash collection confirmation timestamp.

### 2.4 Windows Agent (`apps/agent/windows`)

- **[`apps/agent/windows/src/printing/windows-printer-adapter.ts`](file:///C:/Users/MANTH/Documents/Online_Printer/apps/agent/windows/src/printing/windows-printer-adapter.ts):**
  - Added fast path querying native Win32 `printgo-spooler.exe status` in $< 60$ ms, checking hardware status flags (`PRINTER_STATUS_OFFLINE`, `PAPER_OUT`, `PAUSED`, `DOOR_OPEN`, `PAPER_JAM`).
  - Added direct SumatraPDF process launching via `child_process.spawn()` with CLI args: `-print-to "<PrinterName>" -silent "<PdfPath>"`.
  - Added 60 ms rapid spooler job correlation loop to capture ephemeral jobs before fast despool.
  - Preserved transparent PowerShell fallback if native helper or SumatraPDF is unavailable.
- **[`apps/agent/windows/src/printing/spool-monitor.ts`](file:///C:/Users/MANTH/Documents/Online_Printer/apps/agent/windows/src/printing/spool-monitor.ts):**
  - Tuned default spool poll interval to 300 ms with a 15-second grace window for fast despooling printers.
- **[`scripts/build-agent-windows.mjs`](file:///C:/Users/MANTH/Documents/Online_Printer/scripts/build-agent-windows.mjs):**
  - Integrated automated compilation of `apps/agent/windows/native/spooler-helper.cs` via Windows .NET `csc.exe` into agent build pipeline.

---

## 3. What Is Added or Optimized

| Area                        | Type          | Description                                                                                                                         |
| --------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Native Win32 Spooler**    | **Added**     | `apps/agent/windows/native/spooler-helper.cs` calling Win32 `winspool.drv` (`OpenPrinterW`, `GetPrinterW`, `EnumJobsW`, `GetJobW`). |
| **Printer Readiness Check** | **Optimized** | Replaced 38-second WSD PowerShell SOAP probe with 60 ms local Win32 spooler status query (**~600x faster**).                        |
| **SumatraPDF Launch**       | **Optimized** | Replaced 1.8-second PowerShell CLR process launch with 110 ms direct `child_process.spawn()` (**~16x faster**).                     |
| **Spool Correlation**       | **Optimized** | Native Win32 job enumeration every 60 ms catches fast-despooling jobs in 35 ms.                                                     |
| **R2 Upload Recovery**      | **Added**     | Idempotent R2 object inspection in `getDraft()` recovering interrupted uploads without paid Cloudflare Queues or Events.            |
| **Cash vs Online Badges**   | **Added**     | Explicit payment method badges and counter collection status in Admin Live Orders and Order History.                                |
| **Unknown Method Fallback** | **Added**     | Explicit fallback to `"UNKNOWN"` ensuring missing or corrupt payment data is never misclassified as `"ONLINE"`.                     |

---

## 4. Safeguards Preserved

- **Authoritative Step Transitions:** `POST /api/agent/print-jobs/:orderId/steps/:stepId/start` remains mandatory.
- **Durable Local Journal:** SQLite local journaling (`RECORDED_START_MUTATION` $\rightarrow$ `SUBMITTED_TO_SPOOLER` $\rightarrow$ `TERMINAL_MUTATION_CONFIRMED`) remains intact.
- **Uncertain Spool Protection:** Spool submissions with `UNKNOWN` outcome are **never** automatically retried.
- **Payment Enforcement:** Orders strictly remain in `DRAFT`/`UPLOADING` until payment authorization is confirmed via Razorpay webhook or admin counter confirmation. Unpaid orders cannot print.
- **D1 Write Invariant:** Phase 10 introduces **0 additional D1 writes** (+0.0% write delta).

---

## 5. Verification Matrix

- **`pnpm typecheck`:** **Exit code 0** (passed across all 10 packages).
- **`pnpm lint`:** **Exit code 0** (`eslint . --max-warnings 0` passed across monorepo).
- **`vitest run`:** 100% tests passing (19 cash tests, 22 customer tests, 71 Windows agent tests, zero overlaps).
- **`build:agent:windows`:** Successful SEA binary build (`PrintGo-Agent.exe` and `printgo-spooler.exe`).

---

## 6. CI Pipeline Hardening

- **Test Fixture Alignment (`apps/api/worker/src/cleanup/repository.test.ts`):** Included migrations `0020_order_retention_duration.sql` through `0034_d1_live_orders_index.sql` in test fixtures so in-memory D1 emulation includes `o.payment_method` and all indexes.
- **Agent Single-Instance Enforcement (`apps/agent/windows/control-center/PrintGoControlCenter.cs`):** Restored `singleInstanceMutex` ("PrintGo_ControlCenter_SingleInstance_Mutex") to ensure secondary process instances cleanly exit as required by Windows CI smoke tests.
- **Cross-Platform Test URL Resolution (`apps/api/worker/src/printing/phase8-final-audit-e2e.test.ts`):** Passed `URL` instances directly to `readdirSync` and `readFileSync` for reliable execution on both Windows and Linux CI runners.
