# PHASE 12 REPORT: Automated Retention, R2 PDF Deletion & Customer PII Purge

**Status**: COMPLETED & VERIFIED IN PRODUCTION  
**Production Commit**: `main`  
**Worker Version**: `7471e94f-c5a2-4455-8374-f81710af2f72`  
**Cron Trigger Active**: `*/5 * * * *` (Every 5 minutes)

---

## 1. Exact Retention Periods Implemented

| Category                        | Retention Window | Constant                                                     | Trigger Point                                                                                 | Actions on Expiry                                                                                                                                                                                                             |
| :------------------------------ | :--------------- | :----------------------------------------------------------- | :-------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unpaid Uploads**              | **10 minutes**   | `UNPAID_RETENTION_MS = 10 * 60 * 1000`                       | PDF upload initialization (`created_at_ms`)                                                   | Pre-signed URL rejected; R2 PDF deleted; status set to `DELETED`.                                                                                                                                                             |
| **Failed / Cancelled Payments** | **30 minutes**   | `FAILED_OR_CANCELLED_PAYMENT_RETENTION_MS = 30 * 60 * 1000`  | Payment failure or cancellation recorded                                                      | Pre-signed URL rejected; R2 PDF deleted; status set to `DELETED`.                                                                                                                                                             |
| **Completed Print Jobs (PDF)**  | **1 hour**       | `COMPLETED_PDF_RETENTION_MS = 60 * 60 * 1000`                | Order marked `COMPLETED` (`completed_at_ms`)                                                  | Admin & Agent PDF download links return HTTP 410 `ORDER_PDF_EXPIRED`; R2 PDF deleted; upload record marked `DELETED`.                                                                                                         |
| **Customer PII**                | **5 hours**      | `COMPLETED_CUSTOMER_PII_PURGE_MS = 5 * 60 * 60 * 1000`       | Order marked `COMPLETED` (`completed_at_ms`)                                                  | `customer_name` overwritten with `'Customer'`, `customer_phone` overwritten with `''`, `instructions` set to `NULL`, `pii_purged_at_ms` set to timestamp. Order status, financial audit, page count, and job codes preserved. |
| **Unresolved Paid Failures**    | **24 hours**     | `UNRESOLVED_PAID_FAILURE_RETENTION_MS = 24 * 60 * 60 * 1000` | Order payment verified (`paid_at_ms`) when in `BLOCKED`, `UNCERTAIN`, `ADMIN_ACTION_REQUIRED` | PDF deleted from R2; upload marked `DELETED`; order status remains untouched (prevents silent status muting so shop owner can review/refund).                                                                                 |

---

## 2. Automated Cleanup Execution Architecture

PrintGo runs retention cleanup automatically via Cloudflare Worker Scheduled Event Handler triggered by Cloudflare Cron:

- **Cron Schedule**: `*/5 * * * *` (registered in `apps/api/worker/wrangler.jsonc` under `triggers.crons`).
- **Worker Handler**: Implemented in [`apps/api/worker/src/index.ts`](file:///Users/manthanjaiswal/Printe_Go_/apps/api/worker/src/index.ts):
  ```typescript
  async scheduled(_controller: ScheduledController, env: WorkerEnv): Promise<void> {
    const repository = new D1RetentionRepository(env.DB);
    const service = new RetentionService(repository, env.PDF_BUCKET);
    const result = await service.runCleanup();
    console.log("Retention cleanup scheduled execution complete", result);
  }
  ```
- **Zero Third-Party Workers**: Runs 100% within Cloudflare Free Tier Worker limits (288 cron invocations/day, using <0.3% of the 100,000 requests/day allowance).

---

## 3. Zero Full-Table Scans: Optimized D1 Indexing

Both PDF cleanup and PII purge query paths are backed by targeted partial indexes introduced in migration `0009_retention_and_pii_purge.sql`:

1. **Uploads Retention Cleanup Index**:

   ```sql
   CREATE INDEX IF NOT EXISTS uploads_retention_cleanup_idx
     ON uploads(delete_after_ms)
     WHERE storage_status <> 'DELETED' AND delete_after_ms IS NOT NULL;
   ```
   - **Candidate Query**:
     ```sql
     SELECT id, order_id, r2_key, storage_status, delete_after_ms, retention_reason
     FROM uploads
     WHERE storage_status <> 'DELETED'
       AND delete_after_ms IS NOT NULL
       AND delete_after_ms <= ?
     ORDER BY delete_after_ms ASC
     LIMIT ?;
     ```
   - **EXPLAIN QUERY PLAN**:
     `SEARCH uploads USING INDEX uploads_retention_cleanup_idx (delete_after_ms<?)`

2. **Orders PII Purge Index**:
   ```sql
   CREATE INDEX IF NOT EXISTS orders_pii_purge_idx
     ON orders(completed_at_ms)
     WHERE status = 'COMPLETED' AND pii_purged_at_ms IS NULL AND completed_at_ms IS NOT NULL;
   ```
   - **Candidate Query**:
     ```sql
     SELECT id, status, completed_at_ms, pii_purged_at_ms
     FROM orders
     WHERE status = 'COMPLETED'
       AND pii_purged_at_ms IS NULL
       AND completed_at_ms IS NOT NULL
       AND completed_at_ms <= ?
     ORDER BY completed_at_ms ASC
     LIMIT ?;
     ```
   - **EXPLAIN QUERY PLAN**:
     `SEARCH orders USING INDEX orders_pii_purge_idx (completed_at_ms<?)`

---

## 4. Logical Expiration Precedes Physical Deletion

Physical deletion via cron occurs every 5 minutes, but **access to expired assets is blocked immediately and synchronously**:

- **PDF Download Enforcement** ([`apps/api/worker/src/printing/service.ts`](file:///Users/manthanjaiswal/Printe_Go_/apps/api/worker/src/printing/service.ts)):
  ```typescript
  if (upload.delete_after_ms !== null && upload.delete_after_ms <= now) {
    return {
      status: "error",
      statusCode: 410,
      code: "ORDER_PDF_EXPIRED",
      message:
        "The PDF for this order has expired under the shop's retention policy and is no longer available.",
    };
  }
  ```
  - Pre-signed download URLs clamp their expiration to `Math.min(now + 900, Math.floor(upload.delete_after_ms / 1000))`. If fewer than 10 seconds remain before logical expiration, pre-signed URL creation is denied.
- **Admin PDF Download Route** ([`apps/api/worker/src/printing/admin-routes.ts`](file:///Users/manthanjaiswal/Printe_Go_/apps/api/worker/src/printing/admin-routes.ts)):
  - Returns HTTP 410 Gone with clear error details when a PDF has logically expired.
- **Customer Tracking Service** ([`apps/api/worker/src/tracking/service.ts`](file:///Users/manthanjaiswal/Printe_Go_/apps/api/worker/src/tracking/service.ts)):
  - Computes `fileRetentionStatus = "EXPIRED"` whenever `delete_after_ms <= nowMs` even if the R2 file has not yet been physically cleaned by the cron worker.

---

## 5. R2 Deletion Performance, Idempotency & Batching

- **Direct Idempotent Deletion**: `bucket.delete(r2_key)` is called directly without preceding `HEAD` or `LIST` operations, cutting billable Class B operations by 50%.
- **Atomic Two-Phase State Lock**:
  1. Phase 1: `UPDATE uploads SET storage_status = 'DELETE_PENDING' WHERE id = ? AND storage_status <> 'DELETED'` (prevents concurrent cron runs from touching the same upload).
  2. Phase 2: Call `bucket.delete(r2_key)`.
  3. Phase 3: `UPDATE uploads SET storage_status = 'DELETED', deleted_at_ms = ? WHERE id = ?`.
  4. Failure Handling: On R2 failure, the state reverts to `UPLOADED` with `retention_error_count` incremented, scheduled for retry on the next cycle.
- **Batch Sizing**:
  - Default batch size: 50 items (max 100).
  - Keeps Worker execution sub-second (well under the 30-second CPU / wall-clock limit).

---

## 6. Customer PII Purge Architecture

- **Redacted Fields**:
  - `customer_name` -> `'Customer'`
  - `customer_phone` -> `''`
  - `instructions` -> `NULL`
  - `pii_purged_at_ms` -> `nowMs`
- **Preserved Accounting & Audit Fields**:
  - `id`, `job_code`, `status`, `page_count`, `copies`, `color_mode`, `paper_size`, `sides`, `printing_amount_paise`, `service_charge_paise`, `total_amount_paise`, `currency`, `created_at_ms`, `paid_at_ms`, `completed_at_ms`.
- **D1 Audit Log Event**:
  - Inserts `order_events` row: `event_type = 'CUSTOMER_PII_PURGED'`, `actor_type = 'SYSTEM'`.

---

## 7. Customer Tracking UI Behavior

- **Active File**: Displays upload filename and active retention countdown ("File retained for print pickup").
- **Expired / Deleted File**: Displays "File automatically removed per shop privacy policy."
- **Purged Order**: Displays name as "Customer", masks personal telephone, preserves job code, status badge ("Completed"), payment receipt, and pickup verification.

---

## 8. Admin UI Behavior

- **Active Order**: Displays customer name, phone number, instructions, "Download PDF" button, and print actions.
- **Expired PDF**: "Download PDF" button gracefully reports HTTP 410 "The PDF for this order has expired under the shop's retention policy." Print retry displays warning that the source file is no longer available.
- **PII-Purged Order**: Shows customer as "Customer", phone empty, instructions empty, with badge indicator that PII has been scrubbed. Financial records and job history remain intact for accounting.

---

## 9. Concurrency & Re-entrancy Protection

- `markUploadDeletePending(uploadId)` issues an atomic conditional update:
  `UPDATE uploads SET storage_status = 'DELETE_PENDING' WHERE id = ? AND storage_status IN ('UPLOADED', 'PENDING')`.
- If two crons overlap, only one process transitions the row; the other skips it.
- If an order is already marked `pii_purged_at_ms IS NOT NULL`, the partial index excludes it, preventing redundant updates.

---

## 10. Admin Retention Controls & Dry-Run API

Exposed two authenticated administrative endpoints:

1. `GET /api/admin/retention/stats`
   - Returns counts of pending deletions, deleted uploads, uploads approaching expiry (< 15 min), and pending PII purges.
2. `POST /api/admin/retention/cleanup`
   - Request Body: `{ "dryRun": boolean, "batchLimit": number }`
   - In dry-run mode, returns candidate uploads and orders without modifying D1 or R2.

---

## 11. Test Coverage & Verification

| Test Suite                                         | Tests   | Result     | Coverage Highlights                                                                                              |
| :------------------------------------------------- | :------ | :--------- | :--------------------------------------------------------------------------------------------------------------- |
| `apps/api/worker/src/retention/service.test.ts`    | 11      | PASSED     | Unpaid, failed, completed, and unresolved failure windows; R2 errors; dry-run; overlapping runs; batch bounding. |
| `apps/api/worker/src/retention/repository.test.ts` | 5       | PASSED     | Index-backed candidate selection; atomic DELETE_PENDING lock; PII redaction; audit events; retention stats.      |
| `apps/api/worker/src/tracking/service.test.ts`     | 5       | PASSED     | Logical expiry mask; PII masking in tracking response.                                                           |
| `apps/api/worker/src/printing/service.test.ts`     | 2       | PASSED     | Logical expiry blocking (HTTP 410).                                                                              |
| **Workspace Test Suite**                           | **476** | **PASSED** | 62 test files across 4 apps and 6 packages.                                                                      |

---

## 12. Free-Tier Capacity Impact

Ran `node scripts/calculate-free-tier-capacity.mjs`:

| Scenario                         | Worker Req/Day (% Quota) | D1 Reads/Day (% Quota) | D1 Writes/Day (% Quota) | R2 Storage (Steady-State) | R2 Storage (Burst) |
| :------------------------------- | :----------------------- | :--------------------- | :---------------------- | :------------------------ | :----------------- |
| **Normal** (1,500 jobs/mo)       | 5,848 (5.85%)            | 61,070 (1.22%)         | 3,338 (3.34%)           | 13.33 MB                  | 66.67 MB           |
| **Stress** (7,500 abandoned)     | 9,385 (9.38%)            | 67,040 (1.34%)         | 6,225 (6.22%)           | 35.83 MB                  | 179.17 MB          |
| **High Activity** (100 jobs/day) | 11,415 (11.42%)          | 110,140 (2.20%)        | 6,675 (6.68%)           | 34.00 MB                  | 170.00 MB          |
| **Max PDF Burst** (25 MiB files) | 5,848 (5.85%)            | 61,070 (1.22%)         | 3,338 (3.34%)           | 166.67 MB                 | 833.33 MB          |

**Conclusion**: Steady-state R2 storage remains under 170 MB (1.7% of the 10 GB free tier allowance). All operations operate safely within Cloudflare Free Tier indefinitely.

---

## 13. Complete List of Files Created or Modified

### Migrations & Setup Scripts

- [`database/migrations/0009_retention_and_pii_purge.sql`](file:///Users/manthanjaiswal/Printe_Go_/database/migrations/0009_retention_and_pii_purge.sql) — Added `pii_purged_at_ms`, partial indexes `orders_pii_purge_idx` and `uploads_retention_cleanup_idx`, and unresolved failure backfill.
- [`scripts/validate-d1-local.sh`](file:///Users/manthanjaiswal/Printe_Go_/scripts/validate-d1-local.sh) — Added migration 0009 to local validation harness.
- [`scripts/setup-d1-local.sh`](file:///Users/manthanjaiswal/Printe_Go_/scripts/setup-d1-local.sh) — Added migration 0009 to local setup harness.

### API & Worker Implementation

- [`apps/api/worker/src/retention/repository.ts`](file:///Users/manthanjaiswal/Printe_Go_/apps/api/worker/src/retention/repository.ts) — D1 retention query, atomic lock, R2 status updates, and PII purge.
- [`apps/api/worker/src/retention/service.ts`](file:///Users/manthanjaiswal/Printe_Go_/apps/api/worker/src/retention/service.ts) — Idempotent R2 deletion engine, dry-run mode, and batch coordination.
- [`apps/api/worker/src/retention/admin-routes.ts`](file:///Users/manthanjaiswal/Printe_Go_/apps/api/worker/src/retention/admin-routes.ts) — Retention stats and manual cleanup trigger endpoints.
- [`apps/api/worker/src/payments/repository.ts`](file:///Users/manthanjaiswal/Printe_Go_/apps/api/worker/src/payments/repository.ts) — Configured 24h unresolved paid failure retention limit on payment success.
- [`apps/api/worker/src/printing/repository.ts`](file:///Users/manthanjaiswal/Printe_Go_/apps/api/worker/src/printing/repository.ts) — Added `delete_after_ms` to `findUploadByOrderId`.
- [`apps/api/worker/src/printing/service.ts`](file:///Users/manthanjaiswal/Printe_Go_/apps/api/worker/src/printing/service.ts) — Enforced logical expiry rejection (`ORDER_PDF_EXPIRED`) and URL expiration clamping.
- [`apps/api/worker/src/printing/admin-routes.ts`](file:///Users/manthanjaiswal/Printe_Go_/apps/api/worker/src/printing/admin-routes.ts) — Mapped `ORDER_PDF_EXPIRED` to HTTP 410.
- [`apps/api/worker/src/tracking/repository.ts`](file:///Users/manthanjaiswal/Printe_Go_/apps/api/worker/src/tracking/repository.ts) — Added `delete_after_ms` and `pii_purged_at_ms` selections.
- [`apps/api/worker/src/tracking/service.ts`](file:///Users/manthanjaiswal/Printe_Go_/apps/api/worker/src/tracking/service.ts) — Added logical expiry check and PII masking for tracking responses.
- [`apps/api/worker/src/router.ts`](file:///Users/manthanjaiswal/Printe_Go_/apps/api/worker/src/router.ts) — Wired retention routes.
- [`apps/api/worker/src/index.ts`](file:///Users/manthanjaiswal/Printe_Go_/apps/api/worker/src/index.ts) — Exported `scheduled` handler for Cloudflare Cron Triggers.
- [`apps/api/worker/wrangler.jsonc`](file:///Users/manthanjaiswal/Printe_Go_/apps/api/worker/wrangler.jsonc) — Added `"triggers": { "crons": ["*/5 * * * *"] }`.

### Tests

- [`apps/api/worker/src/retention/service.test.ts`](file:///Users/manthanjaiswal/Printe_Go_/apps/api/worker/src/retention/service.test.ts)
- [`apps/api/worker/src/retention/repository.test.ts`](file:///Users/manthanjaiswal/Printe_Go_/apps/api/worker/src/retention/repository.test.ts)
- [`apps/api/worker/src/payments/repository.test.ts`](file:///Users/manthanjaiswal/Printe_Go_/apps/api/worker/src/payments/repository.test.ts)
- [`apps/api/worker/src/tracking/service.test.ts`](file:///Users/manthanjaiswal/Printe_Go_/apps/api/worker/src/tracking/service.test.ts)
- [`apps/api/worker/src/printing/repository.test.ts`](file:///Users/manthanjaiswal/Printe_Go_/apps/api/worker/src/printing/repository.test.ts)

---

## 14. Production Verification Results

1. **Remote D1 Migration Execution**:
   - `ALTER TABLE orders ADD COLUMN pii_purged_at_ms INTEGER;` executed successfully.
   - Index `orders_pii_purge_idx` created successfully.
   - Index `uploads_retention_cleanup_idx` created successfully.
   - Backfill executed on remote production D1: historical unresolved orders were backfilled with `retention_reason = 'UNRESOLVED_PAID_FAILURE'` and `delete_after_ms = paid_at_ms + 24 hours`.
2. **Remote Worker Deployment**:
   - Deployed version: `7471e94f-c5a2-4455-8374-f81710af2f72`.
   - Cron trigger active: `*/5 * * * *` on `https://printgo-api.printgo-worker.workers.dev`.
3. **Database State Verification**:
   - Verified that all uploads have exact `retention_reason` and `delete_after_ms` assigned.
   - Verified that candidate queries use partial indexes with zero full-table scans.
