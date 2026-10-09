# PrintGo V2 — Strict Zero-Data Retention: Production Pre-Release Audit & Preview

**Date:** 2026-10-09  
**Target Database:** Cloudflare D1 Production (`printgo-production` / `81bc9e6b-6e65-4a8a-85dd-4440484482ff`)  
**Target Storage:** Cloudflare R2 Private Bucket (`printgo-pdfs`)  
**Decision:** **GO FOR DEPLOYMENT** _(Awaiting explicit user approval before execution)_

---

## 1. Executive Summary & Verification Matrix

All 5 core pre-release requirements have been thoroughly validated. Zero destructive mutations were executed.

| Requirement                            | Finding / Status                                                                                                 |    Result    |
| :------------------------------------- | :--------------------------------------------------------------------------------------------------------------- | :----------: |
| **1. Read-Only Production Preview**    | **0** orders eligible, **0** PDFs eligible, **0** bytes eligible, **148** active payments retained (< 25d).      | **VERIFIED** |
| **2. Active Protection Invariants**    | **0** active print jobs or unresolved payments are exposed to deletion.                                          | **VERIFIED** |
| **3. Retry & Abandonment Prevention**  | Infinite exponential backoff (capped at 1h); self-heals orphaned runs & phantom items.                           | **VERIFIED** |
| **4. Statutory Accounting Advisory**   | Admin UI updated with explicit CGST Act Sec 36 & IT Act Sec 44AA warning; Razorpay export instructions provided. | **VERIFIED** |
| **5. Platform Backup & Storage Audit** | Documented exact retention limits across D1 snapshots, Cloudflare Edge logs, R2, and Windows Agent.              | **VERIFIED** |
| **Full Local Test Pipeline**           | **713 passed** across 82 test suites; 0 lint warnings; clean typecheck; 28 D1 tables validated.                  |   **PASS**   |

---

## 2. Read-Only Live Production Preview

Executed via [`scripts/preview-production-retention.mjs`](file:///Users/manthanjaiswal/Printe_Go_/scripts/preview-production-retention.mjs) against the remote production database:

### A. Shop Configuration

- **Shop Name:** `PRINT_GO🔥` (ID: 1)
- **Order Retention Window:** 2 hours (`order_retention_hours = 2`)
- **Last Cleanup Execution:** `2 orders / 2 PDFs deleted, 15 failed` (from previous run)

### B. Orders & PDFs Breakdown

- **Active Orders:** `0`
- **Completed Orders (`PRINTED` / `CANCELLED`):** `0`
- **Unpaid Orders (`PENDING_PAYMENT`):** `0`
- **Eligible Completed Orders (> 2h):** **0 orders (0 files, 0 bytes)**
- **Eligible Expired Unpaid Orders (> 10m):** **0 orders (0 files, 0 bytes)**
- _Note:_ A manual admin sweep (`5bbbad90...` and `82f72180...`) previously purged customer print data. No orphaned order files exist in D1.

### C. Payments & Webhooks Breakdown (25-Day Retention Policy)

- **25-Day Cutoff Threshold:** `2026-09-14T07:53:13.964Z` (`1789372393964`)
- **Payments > 25 Days Old (Eligible for deletion):** **0**
- **Payments < 25 Days Old (Protected & Retained):** **148**
- **Webhook Provider Events > 25 Days Old (Eligible for deletion):** **0**
- **Webhook Provider Events < 25 Days Old (Protected & Retained):** **251**

### D. Audit Logs & Cleanup Run Telemetry

- **Diagnostic Audit Logs > 25 Days Old (Eligible):** **0**
- **Diagnostic Audit Logs < 25 Days Old (Retained):** **211**
- **Cleanup Run Records > 7 Days Old (Eligible):** **0**
- **Open / Ghost Runs Identified:** **1 run** (`807fcacf-85e9-4a0d-84c4-a017f12ff174`)
  - Status: `RUNNING`, created during an earlier scheduled run.
  - Contains 2 completed items and 1 orphaned item for an order (`1d30f116...`) that was subsequently deleted by an admin sweep.
  - _Resolution:_ Fixed in repository logic—on next run, `recoverOrphanedClaims` automatically transitions the orphaned item to `DELETED` and drains the run.

---

## 3. Safety Invariants & Protection of Active Operations

The deletion service enforces strict state gates preventing premature deletion:

1. **Unpaid Orders:**
   - Deleted only if `status = 'PENDING_PAYMENT'` AND `payment_status = 'PENDING'` AND `created_at_ms <= (nowMs - 600_000)` (10 minutes).
   - Any order with an in-flight Razorpay checkout session under 10 minutes is 100% immune.
2. **Completed Orders:**
   - Deleted only if `payment_status = 'PAID'` AND `status IN ('PRINTED', 'CANCELLED')` AND `updated_at_ms <= (nowMs - X * 3600_000)`.
   - Orders in `QUEUED`, `PRINTING`, or `WAITING_RETRY` states are strictly excluded, regardless of age.
3. **Recovery & Hardware Protection:**
   - Orders currently held in printer claim locks (`claims_paused`, `recovery_locked_at_ms`) are excluded from cleanup selection.

---

## 4. Verification of Cleanup Retries & Self-Healing

### Previous Limitation

Previous implementation capped retries at 3 attempts, marking persistent failures as `FAILED` (terminal), which risked leaving behind orphaned R2 objects or unpurged D1 records.

### Current Implementation & Verifications

1. **Infinite Exponential Backoff:**
   ```typescript
   const backoffMs = Math.min(
     60 * 60 * 1000,
     30_000 * Math.pow(2, attemptCount - 1),
   );
   ```
   Cleanup tasks never stop retrying until successfully deleted. Backoff starts at 30s, scaling to 1 hour max.
2. **Orphaned Claim Recovery (`recoverOrphanedClaims`):**
   - If a Worker instance crashes or times out while processing a batch, orders stuck in `cleanup_state = 'CLAIMED'` are recovered back to `'ACTIVE'` after 10 minutes.
   - If an order was deleted by another process while an item was recorded in `cleanup_run_items`, `recoverOrphanedClaims` marks the item as `DELETED`:
     ```sql
     UPDATE cleanup_run_items
     SET status = 'DELETED', updated_at_ms = ?
     WHERE status = 'FAILED'
       AND NOT EXISTS (SELECT 1 FROM orders WHERE orders.id = cleanup_run_items.order_id);
     ```
   - This guarantees that ghost runs like `807fcacf...` will self-drain and complete without manual database intervention.

---

## 5. Statutory Accounting & Legal Retention Realities

### Statutory Legal Context (India)

- **Section 36, Central Goods and Services Tax (CGST) Act, 2017:** Requires every registered person to keep and maintain books of account and other records until the expiry of **72 months (6 years)** from the due date of furnishing of the annual return.
- **Section 44AA, Income Tax Act, 1961:** Mandates specified professionals and businesses to maintain books of accounts for **6 to 8 years**.
- **Digital Personal Data Protection (DPDP) Act, 2023:** Requires data fiduciaries to erase personal data as soon as the specified purpose is no longer served.

### PrintGo's Architectural Stance & Solution

1. **Aggregated Daily Totals Are Operational Only:**
   - `daily_order_stats` stores aggregate day-end metrics (`total_orders`, `total_revenue_inr`, `total_pages_bw`, `total_pages_color`).
   - It contains zero customer PII, but does **not** contain individual GSTINs, HSN codes, invoice serials, or line-item tax rates. It is an operational kiosk summary, **not a statutory financial register**.
2. **Shopkeeper Advisory Added to Admin UI:**
   [`apps/web/admin/src/StoragePrivacySection.tsx`](file:///Users/manthanjaiswal/Printe_Go_/apps/web/admin/src/StoragePrivacySection.tsx) now displays a mandatory advisory:
   > **Statutory Accounting & Retention Advisory**  
   > _Notice for Shopkeepers:_ PrintGo automatically purges customer order details and PDFs after the configured hours, and permanently deletes payment records after 25 days to enforce strict customer privacy and minimize edge storage liabilities.  
   > PrintGo's aggregated daily dashboard totals do **not** substitute for statutory books of accounts, tax invoices, or customer sales registers required under applicable laws (including Section 36 of the CGST Act and Section 44AA of the Income Tax Act). Shopkeepers must periodically export and archive their legally required accounting records and GST reports directly from their Razorpay Merchant Dashboard or external accounting systems before the 25-day retention window expires.

---

## 6. Documented Platform Retention Limitations

| Storage Layer              | Retention Boundary                                  | Purge Mechanism                        | Platform Limitations & Residuals                                                                                                   |
| :------------------------- | :-------------------------------------------------- | :------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------- |
| **Cloudflare D1 (Active)** | 10m (unpaid)<br>1–12h (completed)<br>25d (payments) | SQL `DELETE` / `UPDATE`                | Immediate removal from live database.                                                                                              |
| **Cloudflare D1 Backups**  | Platform-managed                                    | Cloudflare automated daily snapshot    | Snapshots are retained by Cloudflare infrastructure for **7 to 30 days**. Application-level deletes cannot rewrite past snapshots. |
| **Cloudflare R2**          | 10m (unpaid)<br>1–12h (completed)                   | `env.PDF_BUCKET.delete(key)`           | Bucket versioning is **disabled**. Deletion is immediate and permanent across all edge locations.                                  |
| **Cloudflare Edge Logs**   | Platform-managed                                    | Cloudflare automatic rolling retention | HTTP request logs retained for **24h to 7d**. Contain IP/path metadata; zero customer PII or PDFs.                                 |
| **Windows Agent**          | 0 seconds (post-spool)                              | `fs.unlinkSync(tempPdfPath)`           | Spool PDFs in `%TEMP%` unlinked immediately after SumatraPDF spooling.                                                             |
| **Admin Browser PWA**      | Transient                                           | React memory state only                | No customer order details or PDFs cached in LocalStorage or IndexedDB.                                                             |

---

## 7. Pre-Release Verification Results

- `pnpm test`: **82 test suites passed (713 tests passed, 1 skipped)**
- `pnpm typecheck`: **0 errors across root and 8 workspaces**
- `pnpm lint`: **0 warnings / 0 errors**
- `pnpm format:check`: **Clean Prettier validation**
- `pnpm db:validate`: **All 28 tables and 23 migrations verified on local D1**
- `pnpm build`: **Clean builds across all PWAs and packages**
- `node scripts/verify-retention-deletion.mjs`: `acceptance.overall = "PASS"`

---

## 8. Final Decision: GO FOR DEPLOYMENT

The system is fully audited, verified, and safe for production release.

- **Next Step upon Approval:**
  1. Commit and push repository changes.
  2. Deploy Cloudflare Worker (`apps/api/worker`) and Admin PWA (`apps/web/admin`).
  3. Scheduled Cloudflare Worker cron (`*/15 * * * *`) will seamlessly drain the single ghost run (`807fcacf...`) and resume normal zero-data maintenance.
