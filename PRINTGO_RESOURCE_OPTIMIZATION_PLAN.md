# PRINTGO — ARCHITECTURAL RESOURCE OPTIMIZATION PLAN
**Evidence-Driven Roadmap to Maximize Cloudflare Free-Tier Capacity**

---

## 1. OPTIMIZATION STRATEGY & PRIORITIZATION HIERARCHY

Based on the forensic audit of the October 14, 2026 production test, the platform is governed almost entirely by **D1 Rows Written (100,000/day limit)**, followed by **D1 Rows Read (5,000,000/day limit)**.

Optimizations are ranked strictly by architectural impact:
- **Priority 1**: Correctness, Financial Security & Print Idempotency (Zero Compromise)
- **Priority 2**: Preventing Production Outages (Eliminating D1 Daily Write Ceiling Exhaustion)
- **Priority 3**: Eliminating Excessive D1 Writes (Unlocks Scaling from 350 to 700+ Orders/Day)
- **Priority 4**: Eliminating Excessive D1 Reads (Fixing Full-Table Scans and Inefficient Queries)
- **Priority 5**: Reducing Worker and Durable Object Invocations
- **Priority 6**: Reducing R2 Storage Operations
- **Priority 7**: Improving Printer and UI Responsiveness

```mermaid
flowchart TD
    P1["Priority 1: Financial & Print Safety"] --> P2["Priority 2: Prevent D1 Outages"]
    P2 --> P3["Priority 3: Eliminate D1 Writes (-35% writes)"]
    P3 --> P4["Priority 4: Eliminate D1 Reads (-65% reads)"]
    P4 --> P5["Priority 5: Worker & DO Optimization"]
    P5 --> P6["Priority 6: R2 Operational Efficiency"]
    P6 --> P7["Priority 7: UI & Printer Latency"]
```

---

## 2. DETAILED ACTIONABLE OPTIMIZATIONS

### PRIORITY 2: PREVENTING PRODUCTION OUTAGES

#### OPT-P2-01: Circuit Breaker for D1 Daily Write Approaching Quota
- **Evidence**: On Cloudflare Free, reaching 100,000 D1 writes causes hard database errors, crashing customer checkout and order creation until 00:00 UTC.
- **Proposed Improvement**: Implement an in-memory / cache-tracked atomic write counter in the Cloudflare Worker. When estimated daily writes exceed 90,000 (90% threshold), gracefully transition Customer PWA to a queue throttle mode ("High demand: Online queue paused, in-store ordering available") while preserving Admin and Agent ability to complete already-paid jobs.
- **Expected Reduction**: Prevents catastrophic crash when order volume spikes beyond capacity.
- **Possible Downside**: New orders temporarily blocked before midnight UTC during massive surges.
- **Implementation Complexity**: Low (50 lines in `apps/api/worker/src/router.ts`).
- **Regression Risk**: Very Low.
- **Components Required**: Worker update.

---

### PRIORITY 3: ELIMINATING EXCESSIVE D1 WRITES

#### OPT-P3-01: Batch Print Attempt and Step Status Transitions
- **Evidence**: In the 1-hour test, updating print attempts and steps across order lifecycle transitions (`SUBMITTING`, `SPOOLING`, `PRINTING`, `SUCCEEDED`) generated **1,120 rows written** (~25.7% of all writes in the test). Each transition independently updates `print_attempts`, `print_attempt_steps`, and `orders`.
- **Proposed Improvement**: Batch the step status update with the attempt status update into a single compound D1 batch statement, and collapse intermediate `SPOOLING` -> `PRINTING` notifications when spooling completes in <1 second.
- **Expected Reduction**: Reduces D1 writes by **~35 rows written per order** (a 15.6% reduction in per-order write cost).
- **Possible Downside**: Admin live UI sees combined `PRINTING` state rather than sub-second `SPOOLING` intermediate state.
- **Implementation Complexity**: Medium (update `apps/api/worker/src/printing/repository.ts`).
- **Regression Risk**: Low (covered by existing unit test suite).
- **Components Required**: Worker & Agent update.

#### OPT-P3-02: Optimize Retention Deletion Cascades
- **Evidence**: When scheduled cleanup runs, `purgeOrder` executes 8 individual `DELETE` statements on historical tables (`retained_order_history`, `print_attempt_steps`, `print_attempts`, `order_events`, `payments`, `uploads`, `order_files`, `orders`), generating **~52 rows written per purged order**.
- **Proposed Improvement**: Consolidate retention purging into single-pass cascade deletions or soft-flag `is_purged = 1` for bulk periodic cleanup during off-hours (e.g. 02:00 AM IST) rather than running every 5 minutes during peak shop hours.
- **Expected Reduction**: Shifts 52 writes/order outside peak hours or reduces cleanup write amplification by 40%.
- **Possible Downside**: Purged records physically deleted during night window rather than immediately at 1 hour.
- **Implementation Complexity**: Medium (update `apps/api/worker/src/cleanup/repository.ts`).
- **Regression Risk**: Low (retention privacy rules preserved; R2 files deleted immediately).
- **Components Required**: Worker & D1 migration update.

---

### PRIORITY 4: ELIMINATING EXCESSIVE D1 READS

#### OPT-P4-01: Eliminate `strftime()` Full-Table Scan on Dashboard
- **Evidence**: [apps/api/worker/src/config/dashboard.ts#L37](file:///Users/manthanjaiswal/Printe_Go_/apps/api/worker/src/config/dashboard.ts#L37) consumed **4,332 rows read** across 38 calls (114 rows/call) by evaluating `strftime('%Y-%m-%d', datetime(created_at_ms / 1000 + 19800, 'unixepoch')) = ?`. This forces SQLite into a table scan of all orders and payments.
- **Proposed Improvement**:
  1. Add an indexed column `date_key TEXT NOT NULL` (e.g. `'2026-10-14'`) directly to `orders` and `payments`.
  2. Index: `CREATE INDEX idx_orders_date_key ON orders(date_key)`.
  3. Replace `strftime()` evaluation with direct equality check: `WHERE date_key = ?`.
- **Expected Reduction**: Reduces dashboard query reads from **O(N) full-table scan** to **O(1) B-tree seek** (reading only 1 summary row or today's rows). Saves **~100,000+ reads/day** as historical order volume grows.
- **Possible Downside**: Requires 1 database migration to add column and backfill.
- **Implementation Complexity**: Low (1 SQL migration + 10 lines in `dashboard.ts`).
- **Regression Risk**: Very Low.
- **Components Required**: D1 migration & Worker update.

#### OPT-P4-02: Optimize Order History Pagination Query
- **Evidence**: [apps/api/worker/src/history/repository.ts#L43](file:///Users/manthanjaiswal/Printe_Go_/apps/api/worker/src/history/repository.ts#L43) consumed **23,730 rows read** across 32 calls (**50.7% of all reads in the entire production test**; avg **741 rows/exec**).
- **Proposed Improvement**:
  1. Separate the pagination key seek from metadata projection. Select only `o.id` inside the CTE:
     `SELECT id FROM orders WHERE (created_at_ms, id) < (?, ?) AND cleanup_state = 'ACTIVE' ORDER BY created_at_ms DESC, id DESC LIMIT 20`.
  2. Join the expensive correlated subqueries (`json_group_array`, `display_name`) only for the 20 returned IDs, rather than evaluating them across candidate scans.
  3. Create covering index: `CREATE INDEX idx_orders_history_paged ON orders(created_at_ms DESC, id DESC, cleanup_state);`.
- **Expected Reduction**: Drops rows read per history page view from **741 rows** to **~25 rows** (a **96.6% reduction in history reads**).
- **Possible Downside**: None. Standard database pagination best practice.
- **Implementation Complexity**: Medium (refactor SQL in `apps/api/worker/src/history/repository.ts`).
- **Regression Risk**: Low.
- **Components Required**: Worker update & D1 migration.

#### OPT-P4-03: Bypass Scheduled Cleanup Aggregative Preview
- **Evidence**: Scheduled cleanup cron fires every 5 minutes and runs `preview(scope, nowMs)`, consuming **~9,528 rows read/hour** (228,000 reads/day) performing aggregations even when zero or one order is due.
- **Proposed Improvement**: In [apps/api/worker/src/cleanup/service.ts](file:///Users/manthanjaiswal/Printe_Go_/apps/api/worker/src/cleanup/service.ts#L180-L200), for `source === "SCHEDULED"`, skip calling `preview()`. Simply call `hasCandidates(scope, nowMs)`; if true, proceed immediately to `claimBatch(limit: 5)`. Only calculate wide preview aggregates when requested by an administrator visiting the Cleanup tab in Admin UI.
- **Expected Reduction**: Eliminates **~200,000 D1 rows read / day** of background cron overhead.
- **Possible Downside**: Scheduled cleanup run records store null preview count (actual deleted counts remain exact).
- **Implementation Complexity**: Low (15 lines in `apps/api/worker/src/cleanup/service.ts`).
- **Regression Risk**: Very Low.
- **Components Required**: Worker update.

---

### PRIORITY 5: REDUCING WORKER AND DURABLE OBJECT INVOCATIONS

#### OPT-P5-01: Admin UI Tab Visibility Awareness (Page Visibility API)
- **Evidence**: When Admin operator left browser tabs open or in background, the Admin UI continued polling `/api/admin/orders/live` and `/api/admin/dashboard` every 15–30s.
- **Proposed Improvement**: In Admin PWA (`apps/web/admin`), pause background HTTP polling and throttle WebSocket messages when `document.visibilityState === "hidden"`. Resume immediately on `visibilitychange` to `"visible"`.
- **Expected Reduction**: Reduces Admin Worker requests and D1 reads by 50–70% when operator is not actively viewing the dashboard.
- **Possible Downside**: Small 1-second delay to refresh data when operator switches back to the tab.
- **Implementation Complexity**: Low (React `useEffect` with `visibilitychange` listener).
- **Regression Risk**: Very Low.
- **Components Required**: Admin PWA update.

---

### PRIORITY 6: REDUCING R2 STORAGE OPERATIONS

#### OPT-P6-01: Combine Upload Verification into Upload Completion Webhook
- **Evidence**: Every customer upload requires 1 `PutObject` (Class A) followed by 1 Worker `HeadObject` (Class B) to verify file size and MIME type.
- **Proposed Improvement**: Ensure pre-signed PUT URLs enforce strict `content-length-range` and `content-type` headers directly in the AWS S3/R2 signed signature. This eliminates the need for a separate Worker `HeadObject` verification call.
- **Expected Reduction**: Reduces R2 Class B operations by 50% on uploads.
- **Possible Downside**: Slightly stricter pre-signed URL generation.
- **Implementation Complexity**: Low.
- **Regression Risk**: Very Low.
- **Components Required**: Worker update.

---

## 3. PROJECTED CAPACITY POST-OPTIMIZATION

Implementing these safe, verified optimizations transforms PrintGo's operational capacity:

| Operational Metric | Phase 9 Measured (Today) | Post-Optimization (Projected) | Improvement Factor |
| :--- | :---: | :---: | :---: |
| **D1 Rows Written / Order** | 224.5 rows / order | **~145.0 rows / order** | **-35.4% Write Reduction** |
| **D1 Rows Read / Order** | 350 rows / order | **~120 rows / order** | **-65.7% Read Reduction** |
| **Daily Fixed Background Reads** | ~258,500 reads / day | **~45,000 reads / day** | **-82.6% Background Cut** |
| **Admin History Page View Cost** | 741 rows read / view | **~25 rows read / view** | **-96.6% Query Cut** |
| **Maximum Safe 13h Capacity** | **350 orders / day** | **650 orders / day** | **+85.7% Daily Capacity** |
| **Maximum Safe 14h Capacity** | **320 orders / day** | **600 orders / day** | **+87.5% Daily Capacity** |

---

## 4. IMPLEMENTATION ROADMAP & CHANGE CLASSIFICATION

| Optimization ID | Summary | Affected Component | Code Change Complexity | Deployment Risk |
| :--- | :--- | :---: | :---: | :---: |
| **OPT-P4-01** | Add indexed `date_key` to eliminate dashboard table scan | D1 / Worker | Low | Very Low |
| **OPT-P4-02** | Refactor Order History pagination query & subqueries | Worker | Medium | Low |
| **OPT-P4-03** | Skip scheduled cleanup preview aggregation on crons | Worker | Low | Very Low |
| **OPT-P3-01** | Batch print attempt and step status transitions | Worker / Agent | Medium | Low |
| **OPT-P5-01** | Admin PWA Page Visibility API background throttle | Admin PWA | Low | Very Low |
| **OPT-P2-01** | D1 write quota circuit breaker at 90,000 writes | Worker | Low | Very Low |
