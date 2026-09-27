# PrintGo V2 — Free-Tier Performance Baseline & Capacity Report

## 1. Executive Summary & Objective

PrintGo V2 is an online printing system architected for a single physical print shop running on **Cloudflare's 100% Free Tier** and an on-premise Windows Agent connected to physical printers.

The objective of this performance optimization is to guarantee smooth, continuous operation for **1,500+ completed print jobs per month** (with up to 4,500+ browsing sessions) while consuming **less than 15% of any Cloudflare Free-tier resource limit**, leaving >85% headroom for peak burst periods, retries, and high-volume days.

---

## 2. Cloudflare Free-Tier Limits & Hard Constraints

| Resource                      | Cloudflare Free Limit | Reset Frequency | Primary Consumers                                         |
| :---------------------------- | :-------------------- | :-------------- | :-------------------------------------------------------- |
| **Worker Requests**           | 100,000 / day         | Daily UTC       | Dynamic API endpoints (`/api/*`), Webhooks, Heartbeats    |
| **Worker CPU Time**           | 10 ms / request       | Per request     | JSON parsing, D1 query orchestration, Auth/HMAC checks    |
| **D1 Rows Read**              | 5,000,000 / day       | Daily UTC       | Order listing, config, quote calculations, agent polling  |
| **D1 Rows Written**           | 100,000 / day         | Daily UTC       | Draft creation, payment records, order states, heartbeats |
| **D1 Storage**                | 5 GB                  | Persistent      | Orders, audit logs, print attempts, pricing, settings     |
| **R2 Class A Ops (PUT)**      | 1,000,000 / month     | Monthly         | Direct customer PDF uploads                               |
| **R2 Class B Ops (GET/HEAD)** | 10,000,000 / month    | Monthly         | Worker file verification, Agent download                  |
| **R2 Storage**                | 10 GB-month           | Steady-state    | Ephemeral customer PDFs under strict retention lifecycles |

---

## 3. Subsystem Optimizations: Baseline vs. Optimized

### 3.1 Static Asset Routing (Pages Advanced Mode)

- **Baseline**: Pages Advanced Mode ran `_worker.js` on every incoming HTTP request. Static assets (HTML, CSS, JS bundles, icons, manifests, service worker) were intercepted by the Worker, consuming ~10–15 Worker requests per customer or admin session.
- **Optimized**:
  - Added `apps/web/customer/public/_routes.json` and `apps/web/admin/public/_routes.json` with `"include": ["/api/*"]` and `"exclude": []`.
  - Added `_redirects` (`/* /index.html 200`) for SPA routing fallback.
  - **Result**: 100% of static assets are served directly from Cloudflare Pages Global CDN edge at **0 Worker request cost**. Only dynamic API calls invoke the Worker, preserving same-origin cookie security (`__Host-printgo_admin`) with zero unnecessary Worker invocations.

### 3.2 D1 Query Optimization & Indexing

- **Baseline**:
  - `listLiveOrders()` executed an unbounded table scan: `SELECT * FROM orders ORDER BY updated_at_ms DESC`, scanning all historical orders on every admin poll.
  - `getPricingConfiguration()` issued 4 sequential D1 queries across multiple database round trips.
  - No composite index existed on `orders(status, updated_at_ms)`.
- **Optimized**:
  - Migration `0007_performance_optimization_indexes.sql`:
    - Added composite index `orders_status_updated_idx` on `orders(status, updated_at_ms DESC)`.
    - Added composite index `print_attempts_order_attempt_idx` on `print_attempts(order_id, attempt_number DESC)`.
  - Bounded `listLiveOrders()`: Filters exclusively for active orders (`QUEUED`, `CLAIMED`, `SPOOLING`, `PRINTING`, `PRINT_BLOCKED`, `PRINT_FAILED`, `ADMIN_ACTION_REQUIRED`) OR recently completed orders (`PRINTED` within the last 1 hour), capped at `LIMIT 100`.
  - Consolidated `getPricingConfiguration()` into a single atomic D1 batch containing 3 queries (`installation`, `print_rates`, `file_size_service_charges`).
  - **Result**: D1 rows scanned per admin poll reduced from hundreds/thousands to ~25. Database round trips for customer pricing reduced by 75%.

### 3.3 Public Configuration Caching

- **Baseline**: `GET /api/customer/config` returned `Cache-Control: no-store`, querying D1 for shop name, phone, limits, and pricing rates on every initial visit and page refresh.
- **Optimized**: Added edge caching header:
  ```http
  Cache-Control: public, max-age=30, stale-while-revalidate=60
  ```
  Edge nodes serve repeat visits within 30 seconds directly from cache without hitting D1 or executing database queries.

### 3.4 Agent Heartbeat Optimization

- **Baseline**: The Windows Agent sends a heartbeat every 30 seconds. On each heartbeat, the Worker unconditionally executed `UPDATE printers SET status = ?, capabilities_json = ?, ...` even when printer status and hardware capabilities had not changed, generating ~2,880 unnecessary D1 writes per day per agent.
- **Optimized**:
  - `apps/api/worker/src/agent/repository.ts` now diffs the incoming printer status, reason, and capabilities against current database values. If identical, the `UPDATE printers` query is skipped.
  - `apps/agent/windows/src/printing/windows-printer-adapter.ts` caches printer hardware capabilities in-memory for 10 minutes (`600,000 ms`), eliminating repetitive PowerShell CIM invocations on every heartbeat.
  - **Result**: Saves ~2,880 D1 writes per agent per day (~50% reduction in agent database write volume). Reduces idle agent CPU usage to near 0%.

### 3.5 Client Polling with Page Visibility API & Terminal Stop

- **Baseline**: Customer tracking and Admin live orders polled continuously on fixed timers, even when the user minimized the browser or left the tab running in the background for hours. Tracking polling continued indefinitely after printing finished.
- **Optimized**:
  - **Customer Tracking (`TrackingPage.tsx`)**: Polling interval starts at 15s for the first 2 minutes, then backs off to 30s. Automatically and permanently stops polling when a terminal state is reached (`PRINTED`, `COMPLETED`, `CANCELLED`, `PAYMENT_NOT_RECEIVED`). Pauses immediately when `document.hidden` is true and polls once upon becoming visible.
  - **Admin Live Orders (`LiveOrdersPage.tsx`)**: Polling interval is 20s. Completely suspended when the browser tab is hidden (`document.hidden`). Resumes with an immediate refresh as soon as the tab is brought back to focus.
  - **Result**: Eliminates ghost polling traffic from inactive tabs. Zero polling requests once printing finishes.

---

## 4. Quantitative Performance Baseline: Measured & Derived

| Metric / Subsystem                          | Pre-Optimization Baseline        | Post-Optimization                       | Reduction / Benefit                               |
| :------------------------------------------ | :------------------------------- | :-------------------------------------- | :------------------------------------------------ |
| **Worker Requests / Static Load**           | ~12 req/session                  | **0 req/session**                       | **100% eliminated** via Pages CDN routing         |
| **Worker Requests / Completed Job**         | ~35 req/job (unbounded tracking) | **13 req/job**                          | **63% reduction**                                 |
| **D1 Queries for Customer Pricing**         | 4 round trips                    | **1 atomic batch (3 queries)**          | **75% fewer round trips**                         |
| **D1 Rows Scanned / Admin Live Poll**       | Unbounded (all orders in DB)     | **~25 rows (bounded + indexed)**        | **>95% scan reduction**                           |
| **D1 Writes / Agent Heartbeat (Unchanged)** | 2 writes / 30s (5,760/day)       | **1 write / 30s (2,880/day)**           | **50% write reduction** (~2,880 writes/day saved) |
| **Agent Capabilities WMI/PowerShell**       | Every 30s (2,880 calls/day)      | **Cached for 10 min (144 calls/day)**   | **95% CPU/PowerShell reduction**                  |
| **Customer Tracking Polling Duration**      | Indefinite until tab closed      | **Stops immediately on terminal state** | **Zero ghost requests**                           |
| **Admin Tab Inactive Drain**                | 180 req/hr indefinitely          | **0 req/hr** while tab is hidden        | **100% inactive drain eliminated**                |

---

## 5. Free-Tier Capacity Modeling: 4 Workload Scenarios

The capacity calculator (`scripts/calculate-free-tier-capacity.mjs`) models four distinct workload profiles against Cloudflare Free-tier resource ceilings.

### Scenario A — Normal Shop Workload

- **Parameters**: 1,500 completed print jobs/month (50/day), 4,500 abandoned browsing sessions/month (150/day), 1 Windows Agent (30s heartbeat), 12 hours/day active admin dashboard (20s poll), 2 MB average PDF, 5% payment failure rate, 1% unresolved error rate.
- **Results**:
  - **Worker Requests/day**: 5,848 / 100,000 (**5.85%** quota used, **94.15% headroom**)
  - **D1 Rows Read/day**: 61,070 / 5,000,000 (**1.22%** quota used, **98.78% headroom**)
  - **D1 Rows Written/day**: 3,338 / 100,000 (**3.34%** quota used, **96.66% headroom**)
  - **R2 Class A Ops/month**: 1,575 / 1,000,000 (**0.16%** quota used, **99.84% headroom**)
  - **R2 Class B Ops/month**: 3,000 / 10,000,000 (**0.03%** quota used, **99.97% headroom**)
  - **R2 Storage**: 13.33 MB steady-state, 66.67 MB burst / 10 GB (**0.13%** quota used)
  - **Status**: **SAFE across all resources**.

### Scenario B — Stress Workload

- **Parameters**: 1,500 completed jobs/month, 7,500 abandoned sessions/month, 2 Windows Agents, 12 hours admin dashboard, 5 MB average PDF, 10% payment failure rate, 2% unresolved error rate, frequent customer tracking polls.
- **Results**:
  - **Worker Requests/day**: 9,385 / 100,000 (**9.38%** quota used, **90.62% headroom**)
  - **D1 Rows Read/day**: 67,040 / 5,000,000 (**1.34%** quota used, **98.66% headroom**)
  - **D1 Rows Written/day**: 6,225 / 100,000 (**6.22%** quota used, **93.78% headroom**)
  - **R2 Class A Ops/month**: 1,650 / 1,000,000 (**0.17%** quota used, **99.83% headroom**)
  - **R2 Class B Ops/month**: 3,000 / 10,000,000 (**0.03%** quota used, **99.97% headroom**)
  - **R2 Storage**: 35.83 MB steady-state, 179.17 MB burst / 10 GB (**0.35%** quota used)
  - **Status**: **SAFE across all resources**.

### Scenario C — High Activity Day (2x Monthly Target)

- **Parameters**: 3,000 completed jobs/month (100 jobs/day), 9,000 abandoned sessions/month, 2 Windows Agents, 16 hours/day active admin dashboard (15s poll), 3 MB average PDF, 5% payment failure rate, 1% unresolved error rate.
- **Results**:
  - **Worker Requests/day**: 11,415 / 100,000 (**11.42%** quota used, **88.58% headroom**)
  - **D1 Rows Read/day**: 110,140 / 5,000,000 (**2.20%** quota used, **97.80% headroom**)
  - **D1 Rows Written/day**: 6,675 / 100,000 (**6.68%** quota used, **93.32% headroom**)
  - **R2 Class A Ops/month**: 3,150 / 1,000,000 (**0.32%** quota used, **99.68% headroom**)
  - **R2 Class B Ops/month**: 6,000 / 10,000,000 (**0.06%** quota used, **99.94% headroom**)
  - **R2 Storage**: 34.00 MB steady-state, 170.00 MB burst / 10 GB (**0.33%** quota used)
  - **Status**: **SAFE across all resources**.

### Scenario D — Maximum PDF Burst (25 MiB Max Uploads)

- **Parameters**: 1,500 completed jobs/month with maximum allowed 25 MiB PDF size for all uploads, 1 Agent, 12 hours admin dashboard.
- **Results**:
  - **Worker Requests/day**: 5,848 / 100,000 (**5.85%** quota used, **94.15% headroom**)
  - **D1 Rows Read/day**: 61,070 / 5,000,000 (**1.22%** quota used, **98.78% headroom**)
  - **D1 Rows Written/day**: 3,338 / 100,000 (**3.34%** quota used, **96.66% headroom**)
  - **R2 Storage**: 166.67 MB steady-state, 833.33 MB burst / 10 GB (**1.63%** quota used, **98.37% headroom**)
  - **Status**: **SAFE across all resources**.

---

## 6. Retention Policy & Storage Analysis

The strict retention policy prevents unbounded accumulation of binary files in R2:

| Stage                        | Trigger / Condition                              | Retention Window   | Storage Impact                                    |
| :--------------------------- | :----------------------------------------------- | :----------------- | :------------------------------------------------ |
| **Unpaid Upload**            | Customer uploads PDF but never completes payment | **10 minutes**     | Cleared rapidly; max ~2–5 MB transient            |
| **Failed/Cancelled Payment** | Razorpay payment fails or is dismissed           | **30 minutes**     | Transient buffer for customer retry               |
| **Paid + Print Completed**   | Physical print finished and terminal verified    | **1 hour**         | Deleted from R2 after 60 min; steady-state <35 MB |
| **PII Cleanup**              | Customer personal data (name, phone, notes)      | **5 hours**        | Overwritten in D1 to protect customer privacy     |
| **Paid + Print Unresolved**  | Hardware jam, paper out, or spooler failure      | **Up to 24 hours** | Preserved temporarily for operator recovery       |
| **Windows Agent Temp**       | Local downloaded PDF on Windows                  | **Immediately**    | Securely deleted right after print job handoff    |

---

## 7. Architectural Invariants Preserved

All optimizations were achieved without violating any system invariants:

1. **Single-Shop Model Preserved**: No multi-tenant partitions, schemas, or complex overhead.
2. **Server-Side Authority**: Price calculation and payment verification remain strictly executed on Cloudflare Worker.
3. **No Weakened Security**: DPAPI credential encryption on Windows, HMAC webhook verification, same-origin admin session cookies, and private R2 storage remain intact.
4. **No Paid Dependencies**: Zero external queues, Redis instances, Supabase instances, or paid Cloudflare add-ons required.
