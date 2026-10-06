# PrintGo — Print Queue Recovery & Admin Control Architecture Audit

**Audit Date**: October 2026  
**Auditor**: Antigravity (direct source read — not delegated)  
**Mode**: ANALYSIS ONLY — zero code changes  
**Evidence Standard**: CODE VERIFIED from direct file reads

---

## Summary Answer Block

```
ARCHITECTURE READY:               NO
CURRENT QUEUE RECOVERY SAFE:      NO
CURRENT PRINT AGAIN IDEMPOTENT:   NO  (QUEUED/CLAIMED/PRINTING blocked, but COMPLETED/PRINTED allows duplicate)
CURRENT DELETE IS FULL PURGE:     NO  (retained_payment_records + retained_provider_events intentionally preserved)
CURRENT AUTO CLEANUP IS FULL PURGE: NO (same: payment records retained; also R2-before-D1 with no atomic guarantee)

MAJOR BLOCKERS:
  1. No RecoveryController — "Recover Printing" is a manual admin retry, not a safe reconciliation flow
  2. PREFLIGHT_DEFERRED silently stalls CLAIMED forever (prior audit proven it; fix partly in place but no server BLOCKED report after timeout)
  3. No stall detection — PRINTING for 10+ min has no watchdog
  4. No Clear Waiting Queue operation exists
  5. Print Again / retryOrder is NOT idempotent for COMPLETED/PRINTED orders — blindly re-queues
  6. purgeOrder() writes to retained_payment_records/retained_provider_events — contradicts full-purge requirement
  7. R2 delete and D1 delete are not atomic — orphan R2 objects possible on crash
  8. cleanup_state = 'CLAIMED' blocks retries AND recovery but no timeout to un-claim orphaned cleanup rows
  9. No recovery lock — two Admin tabs can fire concurrent retryOrder() for the same order
  10. ADMIN_ACTION_REQUIRED / COMPLETION_UNKNOWN / NEEDS_ADMIN have no UI controls beyond retry-print / manual-complete

RECOMMENDED PHASES:
  Phase 2 — State machine + recovery foundation (STALLED status, RecoveryController skeleton, cron wire-up)
  Phase 3 — Recover Printing UI + stall detection + idempotent Print Again
  Phase 4 — Admin per-order controls + Clear Waiting Queue
  Phase 5 — Full purge + automatic cleanup unification (single OrderPurgeService)
  Phase 6 — Failure/race tests + Windows physical acceptance + agent upgrade

REPORT: docs/PRINT_QUEUE_RECOVERY_ADMIN_CONTROL_AUDIT.md
```

---

## 1. Current Architecture Map

### Cloud Layer (Cloudflare Worker + D1 + R2)

```
Customer Browser
  └─ PUT (signed URL) ──► R2 (private bucket)
  └─ POST /api/customer/* ──► Worker ──► D1

Razorpay
  └─ POST /api/webhooks/razorpay ──► Worker ──► D1 (payment verified, order → QUEUED)

Windows Agent (outbound only)
  └─ POST /api/agent/heartbeat  ──► Worker ──► D1 (claimOrRenew → print job delivered)
  └─ POST /api/agent/print-jobs/:id/steps/:id/{start,submitted,result}  ──► Worker ──► D1

Admin Browser
  └─ GET/POST /api/admin/* ──► Worker ──► D1
  └─ POST /api/admin/orders/:id/retry-print
  └─ POST /api/admin/orders/:id/manual-complete
  └─ GET  /api/admin/orders/:id/pdf-url
  └─ GET  /api/admin/orders/live
  └─ GET  /api/admin/orders/history

Cloudflare Cron (scheduled)
  └─ CleanupService.runScheduled()
  └─ printingRepo.recoverExpiredClaims()   ← CODE VERIFIED: index.ts:55
  └─ printingRepo.autoRetryEligibleOrders()
```

**Key absence**: No `RecoveryController`. No `QueueSupervisor`. No `OrderPurgeService`. These responsibilities are fragmented across `D1PrintingRepository` (1909 lines), `CleanupService`, and ad-hoc admin routes.

---

## 2. Current Queue / State Machine

### Order Status Vocabulary

CODE VERIFIED: `packages/domain/src/vocabularies.ts:1-24`

```
CREATED → UPLOADING → UPLOADED → PAYMENT_PENDING
                                       ↓
                         PAID → QUEUED → CLAIMED → SPOOLING → PRINTING
                                                                  ↓
                          PRINT_FAILED ← RETRY_PENDING ← PRINT_BLOCKED
                                                                  ↓
                              NEEDS_ADMIN  COMPLETION_UNKNOWN  ADMIN_ACTION_REQUIRED
                                    ↓
                            PRINTED → COMPLETED    AWAITING_FINISHING → COMPLETED
                                                   MANUAL_PRINT → COMPLETED
                                         CANCELLED (from most states)
```

CODE VERIFIED: `packages/domain/src/order-transitions.ts:3-64`

### Print Attempt Status

`CREATED → SUBMITTING → SPOOLING → PRINTING → SUCCEEDED/FAILED/BLOCKED/CANCELLED`  
And `UNCERTAIN` for the spool-lost case.  
CODE VERIFIED: `vocabularies.ts:56-66`

### Print Step Status

`PENDING → SUBMISSION_STARTED → SUBMITTED → BLOCKED/SUCCEEDED/FAILED/UNCERTAIN`  
CODE VERIFIED: `database/migrations/0006_paid_print_execution.sql:12-15`

### Claim Lifecycle

- Lease = `PRINT_CLAIM_LEASE_MS` = 5 minutes (300 000 ms)
- CODE VERIFIED: `constants.ts:45`
- Lease renewed in final third (`< PRINT_CLAIM_LEASE_MS/3` = 100s remaining)
- CODE VERIFIED: `printing/repository.ts:394-416`
- Heartbeat interval = 30s agent-side, timeout = 90s server-side
- CODE VERIFIED: `constants.ts:42-43`

### Cron Handler

CODE VERIFIED: `apps/api/worker/src/index.ts:28-67`

- `CleanupService.runScheduled()` — handles EXPIRED_UNPAID, COMPLETED_DUE, daily run
- `recoverExpiredClaims()` — **IS wired to cron** (fix applied since prior audit)
- `autoRetryEligibleOrders()` — up to 5 PRINT_FAILED orders per cron tick

---

## 3. Exact Gaps

### Gap 1: No RecoveryController

**CURRENT**: "Recover Printing" does not exist as a server endpoint. The closest is `retryOrder()` which blindly re-queues without:

- acquiring a recovery lock
- inspecting spool identity
- classifying SAFE vs UNCERTAIN
- pausing new claims during recovery
- verifying printer health before re-queuing

**RISK**: Admin retries uncertain orders without confirming print state → paper duplication.

### Gap 2: PREFLIGHT_DEFERRED Bounded but Not Yet Escalating to BLOCKED

**CURRENT**: `paid-print-executor.ts:111-143` — if printer is OFFLINE/BLOCKED before submission, returns `"PREFLIGHT_DEFERRED"` without reporting to server. The prior audit (Oct 2026) documented this as the PA-088 root cause.  
**STATUS**: `recoverExpiredClaims` is now in cron, so a dead Agent will eventually recover. But if the Agent is _alive and pulsing_ while the printer is offline, the claim renews indefinitely again because PREFLIGHT_DEFERRED is still silent.  
**CODE VERIFIED**: `paid-print-executor.ts:118-143` — no `reportPrintStep(BLOCKED)` call path exists for the offline preflight case.

### Gap 3: No Stall Detection

**CURRENT**: No `last_progress_at` field. No watchdog for PRINTING > N minutes without progress. The only escalation is:

- Lease expiry (`claim_expires_at_ms`): renewed on every pulse while agent is alive
- `recoverExpiredClaims`: only fires if lease is expired (i.e., agent is dead)
  **RISK**: Physically stalled print (paper jammed mid-print, WSD freeze) stays PRINTING indefinitely.

### Gap 4: Print Again is NOT Idempotent for COMPLETED/PRINTED Orders

CODE VERIFIED: `printing/repository.ts:1738-1751`

```typescript
const retriableStatuses = [
  "ADMIN_ACTION_REQUIRED",
  "PRINT_FAILED",
  "PRINT_BLOCKED",
  "NEEDS_ADMIN",
  "COMPLETION_UNKNOWN",
  "RETRY_PENDING",
  "COMPLETED", // ← COMPLETED can be re-queued
  "PRINTED", // ← PRINTED can be re-queued
];
```

For COMPLETED or PRINTED orders, `retryOrder()` transitions order back to `QUEUED` and resets `order_files.print_status = 'PENDING'` for **all** files. There is no confirmation gate for COMPLETED orders. `UNCERTAIN_RETRY_CONFIRMATION_REQUIRED` is only checked for `ADMIN_ACTION_REQUIRED` and `COMPLETION_UNKNOWN`.

**RISK**: Admin clicks "Print Again" on a COMPLETED order → immediate re-print without any warning that it already printed successfully.

For QUEUED/CLAIMED/SPOOLING/PRINTING/PRINT_BLOCKED: `retryOrder()` **does throw** `ORDER_CANNOT_BE_RETRIED` — so Print Again is blocked for actively-queued states. This part is safe.

### Gap 5: No Clear Waiting Queue Operation

**CURRENT**: No API endpoint or service method exists to bulk-cancel or hold all QUEUED orders.  
**RISK**: No safe operator escape hatch if the shop closes mid-day or queue gets stale.

### Gap 6: Delete Order is NOT a Full Purge — Payment Records Intentionally Retained

CODE VERIFIED: `cleanup/repository.ts:403-484`

```typescript
// purgeOrder() inserts into retained_payment_records before deleting payments
await this.db.prepare(`INSERT OR IGNORE INTO retained_payment_records ...`);
await this.db.prepare(`INSERT OR IGNORE INTO retained_provider_events ...`);
// Then deletes from payments, payment_provider_events, print_attempt_steps,
// print_attempts, order_events, audit_logs (redacted), uploads, order_files,
// order_addon_services, retained_order_history, orders
```

The `orders` row itself IS deleted. But:

- `retained_payment_records` table is **permanently retained** after purge
- `retained_provider_events` table is **permanently retained** after purge
- This contradicts the design requirement: **PrintGo does NOT permanently retain financial records**

### Gap 7: Manual Admin Delete Does Not Exist

**CURRENT**: There is no `DELETE /api/admin/orders/:id` endpoint. The only deletion path is automatic cleanup (`CleanupService`). An admin cannot manually trigger a full purge of a single COMPLETED order.  
**RISK**: Admin UI cannot satisfy "Delete Order" requirement.

### Gap 8: Auto Cleanup and Manual Cleanup Share Code but No Atomicity

CODE VERIFIED: `cleanup/service.ts:154-177`

```typescript
// 1. R2 delete
await this.bucket.delete(candidate.objectKeys);
// 2. D1 purge (separate call)
await this.repository.purgeOrder(runId, candidate, this.now());
```

If the process dies between R2 delete and D1 purge: D1 still has order data but R2 object is gone. Agent cannot re-download PDF if order needs recovery.  
If D1 purge fails after R2 delete: orphan state — D1 references a deleted R2 object.

### Gap 9: No Recovery Lock — Concurrent Admin Tabs

**CURRENT**: `retryOrder()` uses a conditional UPDATE (`WHERE status IN (...) AND cleanup_state = 'ACTIVE'`). The first concurrent call wins; the second gets `ORDER_CANNOT_BE_RETRIED`. This is partially safe for idempotency, but two tabs can create two QUEUED transitions if they race on a non-atomic read-then-write path. There is no distributed lock or idempotency key on the retry endpoint.

### Gap 10: No Live Print System Control Panel

**CURRENT**: `listLiveOrders()` returns Agent name, printer name, status, error. No structured data for:

- Agent online/offline/stale (heartbeat age)
- Printer health breakdown (READY / JAM / PAPER_OUT / OFFLINE)
- Enabled "Recover Printing" button with contextual message
- Waiting order count distinct from active order count

### Gap 11: ADMIN_ACTION_REQUIRED is Not Distinguished From COMPLETION_UNKNOWN in UI/API

Both states require manual decision-making but have different semantics:

- `COMPLETION_UNKNOWN` = submission started, outcome unknown (may have printed)
- `ADMIN_ACTION_REQUIRED` = lease expired after submission started (same risk)
- `NEEDS_ADMIN` = 3+ failed attempts (no uncertain submission)
  All three resolve through the same `retryOrder()` path with `forceUncertain`.

---

## 4. Recovery Architecture (Desired)

### 4.1 Recovery Controller Design

The RecoveryController is a server-side service (Worker endpoint) that:

```
POST /api/admin/recovery/start
  Body: { confirmation: "RECOVER" }
  Auth: Admin session required

Steps (server-side):
  1. Acquire recovery lock (D1 UPDATE installation SET recovery_lock_id = ?, recovery_locked_at_ms = ? WHERE recovery_lock_id IS NULL)
  2. Pause new claims (D1 UPDATE installation SET claims_paused = 1)
  3. Read latest Agent heartbeat → classify ONLINE / STALE / OFFLINE
  4. Read printer status from D1 (last heartbeat report) → classify READY / JAM / PAPER_OUT / OFFLINE
  5. Read active order (status IN CLAIMED,SPOOLING,PRINTING,PRINT_BLOCKED)
  6. Read print_attempts for active order
  7. Read print_attempt_steps for active attempt
  8. Read spool identity (spooler_job_id on step)
  9. Classify outcome:
     - Step PENDING, no spoolerJobId, in CLAIMED = SAFE_TO_RETRY (submission never started)
     - Step SUBMISSION_STARTED, no spoolerJobId = UNCERTAIN (report was lost)
     - Step SUBMITTED/PRINTING, has spoolerJobId = UNCERTAIN (may have printed)
     - Step SUCCEEDED, attempt not completed = ORPHANED_SUCCESS (finishOrphanedSuccess)
     - Step BLOCKED = PRINTER_BLOCKED (clear printer, resolve block)
     - No active order = QUEUE_HEALTHY
  10. Based on classification:
     - SAFE_TO_RETRY: reset to QUEUED (step PENDING, cancel attempt cleanly)
     - UNCERTAIN: set COMPLETION_UNKNOWN, require admin to choose retry/complete
     - PRINTER_BLOCKED: unpause printer, release order to continue from PRINT_BLOCKED
     - QUEUE_HEALTHY: no-op
  11. Release recovery lock
  12. Resume new claims (SET claims_paused = 0)

Returns: { classification, orderId?, message, recoveredStatus? }
```

**Idempotency**: The recovery lock (`recovery_lock_id` in `installation`) ensures only one recovery operation runs at a time. Second click from same or different tab hits the `recovery_lock_id IS NULL` guard and receives `RECOVERY_ALREADY_IN_PROGRESS`.

### 4.2 Current Code Coverage of Recovery Steps

| Step                       | Current Support                                          | Gap                                                                 |
| -------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------- |
| Recovery lock              | ❌ Missing                                               | Need `recovery_lock_id` + `recovery_locked_at_ms` in `installation` |
| Pause new claims           | ❌ Missing                                               | Need `claims_paused` flag checked in `claimOrRenew`                 |
| Agent heartbeat age        | Partial — `AGENT_HEARTBEAT_TIMEOUT_MS = 90s` in domain   | Not surfaced as structured field to Admin UI                        |
| Printer status             | ✅ Stored in D1 from heartbeat reports                   | Not queried by recovery endpoint                                    |
| Inspect active order       | ✅ `listLiveOrders()` shows active                       | Not used by recovery endpoint                                       |
| Inspect step/spool         | ✅ `findOwnedStep()` exists but requires agentId+claimId | Cannot call as admin without owning the claim                       |
| Classify SAFE vs UNCERTAIN | ❌ Missing                                               | No classification logic                                             |
| Repair safe states         | Partial — `recoverExpiredClaims()` handles lease expiry  | Not gated by recovery flow                                          |
| Release lock               | ❌ Missing                                               | No lock to release                                                  |

---

## 5. Admin Control Architecture

### 5.1 Current Admin Controls (code-verified)

| Control               | Endpoint                                       | Implementation                    | Status                          |
| --------------------- | ---------------------------------------------- | --------------------------------- | ------------------------------- |
| List live orders      | GET /api/admin/orders/live                     | `listLiveOrders()`                | ✅ Works                        |
| List history          | GET /api/admin/orders/history                  | `D1OrderHistoryRepository.list()` | ✅ Works                        |
| Manual complete       | POST /api/admin/orders/:id/manual-complete     | `manualComplete()`                | ✅ Works                        |
| Print Again / Retry   | POST /api/admin/orders/:id/retry-print         | `retryOrder()`                    | ⚠️ Not idempotent for COMPLETED |
| Download PDF          | GET /api/admin/orders/:id/pdf-url              | `getOrderPdfUrl()`                | ✅ Works                        |
| Delete order (single) | ❌ Not implemented                             | —                                 | ❌ Missing                      |
| Clear waiting queue   | ❌ Not implemented                             | —                                 | ❌ Missing                      |
| Recover printing      | ❌ Not implemented                             | —                                 | ❌ Missing                      |
| Live control panel    | ❌ No structured agent/printer health endpoint | —                                 | ❌ Missing                      |

### 5.2 Desired Control Set

```
GET  /api/admin/system/print-status       → agent online/stale/offline, printer health, active order, waiting count
POST /api/admin/recovery/start            → RecoveryController (with RECOVER confirmation)
POST /api/admin/queue/clear-waiting       → Clear QUEUED orders (with CLEAR QUEUE confirmation)
POST /api/admin/orders/:id/retry-print    → Already exists — needs COMPLETED idempotency gate
POST /api/admin/orders/:id/manual-complete → Already exists
DELETE /api/admin/orders/:id              → New: full OrderPurgeService for single order
GET  /api/admin/orders/:id/pdf-url        → Already exists
```

---

## 6. Power-Cut / 20-Order Behavior

### Current Behavior

CODE VERIFIED: `printing/repository.ts:255-331` (`recoverExpiredClaims`)

**Scenario**: A=PRINTING, B–T=QUEUED. Power goes off.

After power returns:

- B–T remain QUEUED in D1 — ✅ Durable (D1 survives power loss)
- A's `claim_expires_at_ms` will expire after 5 minutes without an Agent pulse
- Cron fires (if Cloudflare cron is still alive — it is, it's cloud-side) → `recoverExpiredClaims(nowMs)` runs

**What `recoverExpiredClaims` does to A:**

```sql
-- If A had SUBMITTED or SUBMISSION_STARTED steps:
UPDATE print_attempt_steps SET status = 'UNCERTAIN' ...
UPDATE print_attempts SET status = 'FAILED' ...
UPDATE orders SET status = 'ADMIN_ACTION_REQUIRED' ...

-- If A was CLAIMED with step PENDING (no submission started):
UPDATE print_attempts SET status = 'CANCELLED' ...
UPDATE orders SET status = 'QUEUED' ...  ← returns to queue safely
```

**Gap**: If A was in PRINTING with `spooler_job_id` set, it goes to `ADMIN_ACTION_REQUIRED`. It does NOT go to `COMPLETION_UNKNOWN`. The Admin must then manually choose retry-print (with `forceUncertain=true`) or manual-complete. There is no UI to "Hold A and continue B–T" — only retry-print which re-queues A at front.

**B–T behavior**: They remain QUEUED. After Agent comes back online and heartbeats, `claimOrRenew()` finds no busy orders (A is now ADMIN_ACTION_REQUIRED, not CLAIMED), and the next QUEUED order by priority+queue time gets claimed. ✅ B–T are NOT lost and NOT duplicated.

**Gap**: Admin has no way to _skip_ A and let B–T proceed without resolving A first, because:

- A in ADMIN_ACTION_REQUIRED does not block the queue (NOT EXISTS busy check only excludes CLAIMED/SPOOLING/PRINTING/PRINT_BLOCKED)
- ✅ So actually B–T CAN print while A is in ADMIN_ACTION_REQUIRED

**Correction**: After recovery, if A → ADMIN_ACTION_REQUIRED, the queue actually **unblocks**. B–T will begin claiming immediately on next Agent pulse. This is correct behavior. The gap is UI clarity: Admin sees A in error state but isn't told "the rest of the queue is proceeding."

---

## 7. Stall Detection Design

### Current State

No `last_progress_at` or equivalent field. The only "progress" signal the Worker tracks is:

- `print_attempt_steps.last_observed_at_ms` — updated on `recordResult()` (agent call) CODE VERIFIED: `repository.ts:968`
- `print_attempts.last_observed_at_ms` — updated on `recordSubmission()` and `recordResult()` CODE VERIFIED: `repository.ts:862,867`
- `orders.claim_expires_at_ms` — extended on every `claimOrRenew()` renewal

### Proposed Progress Signals

| Signal               | Table / Column                                           | Updated By           | Valid Progress Indicator?                         |
| -------------------- | -------------------------------------------------------- | -------------------- | ------------------------------------------------- |
| Agent heartbeat      | `agents.last_heartbeat_at_ms`                            | `updateHeartbeat()`  | ⚠️ Yes, proves agent alive, not print advancing   |
| Step started         | `print_attempt_steps.submission_started_at_ms`           | `startStep()`        | ✅ Yes — submission began                         |
| Spooler job captured | `print_attempt_steps.submitted_at_ms` + `spooler_job_id` | `recordSubmission()` | ✅ Yes — job in spooler                           |
| Observed at          | `print_attempt_steps.last_observed_at_ms`                | `recordResult()`     | ✅ Yes — step still being monitored               |
| Claim renewal        | `orders.claim_expires_at_ms`                             | `claimOrRenew()`     | ❌ No — renewed even on silent PREFLIGHT_DEFERRED |

### Stall Detection Rule (Proposed, not implemented)

```
STALLED condition (server-side, evaluated in cron or recovery check):
  order.status IN ('SPOOLING', 'PRINTING', 'PRINT_BLOCKED')
  AND (
    MAX(step.last_observed_at_ms, attempt.submitted_at_ms, step.submission_started_at_ms)
    < nowMs - STALL_THRESHOLD_MS   -- proposed: 5 minutes
  )
  AND agent.last_heartbeat_at_ms > nowMs - AGENT_HEARTBEAT_TIMEOUT_MS  -- agent IS alive
```

This distinguishes:

- **True stall**: Agent is alive + heartbeating, but print progress has not been reported for 5 min → expose "Recover Printing" button with STALLED warning
- **Dead agent**: Agent heartbeat expired → `recoverExpiredClaims` handles it

**Not a new status** — STALLED is a UI classification, not a D1 status. This avoids adding a new terminal state and state-machine transitions for a monitoring concern.

---

## 8. Clear Waiting Queue Semantics

### Current State

❌ No endpoint exists.

### Design

```
POST /api/admin/queue/clear-waiting
  Body: { confirmation: "CLEAR QUEUE" }

Business rules:
  - Only affects orders WHERE status = 'QUEUED'
  - Does NOT touch: CLAIMED, SPOOLING, PRINTING, PRINT_BLOCKED, RETRY_PENDING
  - Does NOT touch: ADMIN_ACTION_REQUIRED, COMPLETION_UNKNOWN, NEEDS_ADMIN
  - Transition: QUEUED → CANCELLED
  - Idempotency: confirmation string required

Payment/Customer implications:
  - These are PAID orders (QUEUED requires verified payment)
  - Cancelling a paid-queued order does NOT trigger a refund (Razorpay external)
  - Admin must handle refunds separately
  - Retention: CANCELLED paid orders should NOT be auto-purged immediately
    (admin may need to refund) — they should follow UNRESOLVED_PAID_FAILURE retention

Retention behavior:
  - CURRENT: cleanup safetyGuard checks PAID_NONTERMINAL = (status != 'COMPLETED' AND has paid payment)
  - A CANCELLED order with paid payment would be protected by PAID_NONTERMINAL guard
  - Correct — cancelled paid orders stay in D1 for admin review
  - After manual resolution (refund confirmed), admin can Delete Order

Returns: { cancelledCount, orderIds[] }
```

---

## 9. Print Again Semantics

### Current Behavior (Code Verified)

CODE VERIFIED: `printing/repository.ts:1738-1827` (`retryOrder`)

**Retriable statuses**:

```typescript
[
  "ADMIN_ACTION_REQUIRED",
  "PRINT_FAILED",
  "PRINT_BLOCKED",
  "NEEDS_ADMIN",
  "COMPLETION_UNKNOWN",
  "RETRY_PENDING",
  "COMPLETED",
  "PRINTED",
];
```

**Idempotency**:

- QUEUED, CLAIMED, SPOOLING, PRINTING: `ORDER_CANNOT_BE_RETRIED` thrown ✅ safe
- PRINT_BLOCKED: retriable ⚠️ — order may still be physically active (printer is blocked, but this is in retriable list)
- COMPLETED: no confirmation required ❌ — blindly re-queues a successfully completed order
- PRINTED: no confirmation required ❌ — blindly re-queues a printed-but-not-completed order
- COMPLETION_UNKNOWN / ADMIN_ACTION_REQUIRED: `forceUncertain=true` required ✅ safe

**Unique constraint protection**:  
CODE VERIFIED: `database/migrations/0006_paid_print_execution.sql:46-48`

```sql
CREATE UNIQUE INDEX print_attempts_one_active_per_order_uq
  ON print_attempts(order_id)
  WHERE status IN ('CREATED','SUBMITTING','SPOOLING','PRINTING','BLOCKED');
```

This prevents two active print_attempts for the same order at D1 level. The `retryOrder()` first cancels non-succeeded/cancelled attempts, then the new attempt is created by `claimOrRenew()`. This is structurally safe — no duplicate physical prints from a single retry call.

**Risk**: Two concurrent `retryOrder()` calls (two Admin tabs) on the same COMPLETED order:

- Both pass the `retriableStatuses.includes(order.status)` check before either UPDATE runs
- `results[0]?.meta.changes !== 1` catches the loser — the second call throws `ORDER_CANNOT_BE_RETRIED`
- ✅ D1 serialized writes + conditional UPDATE protect against actual duplicate re-queue

**Net**: Print Again cannot create _duplicate D1 queue entries_ due to conditional UPDATEs. But it CAN reprint a COMPLETED order without warning. This is the primary semantic gap.

### Required Fix

For COMPLETED or PRINTED orders, `retryOrder()` should require:

1. A distinct `forcePrinted=true` confirmation flag (analogous to `forceUncertain`)
2. A warning in the Admin UI: "This order was already completed. Reprinting will create a new print job."

---

## 10. Full Delete / Purge Architecture

### Current `purgeOrder()` Behavior (Code Verified)

CODE VERIFIED: `cleanup/repository.ts:403-484`

Deletes:

- `retained_order_history` row
- `print_attempt_steps` (by order_id)
- `print_attempts` (by order_id)
- `order_events` (by order_id)
- `audit_logs` (entity_id + metadata nulled, row kept)
- `uploads` (by order_id)
- `order_files` (by order_id)
- `order_addon_services` (by order_id)
- `payments` (by order_id) — ← the payment record itself is deleted
- `payment_provider_events` (related to this order) — ← deleted
- `orders` row (by id + cleanup_run_id + cleanup_state='CLAIMED')

**Before deleting payments/events, inserts into**:

- `retained_payment_records` — permanent financial record
- `retained_provider_events` — permanent webhook record

**This contradicts the full-purge requirement**. The design intent is that external Razorpay systems retain records, not PrintGo. The `retained_payment_records` and `retained_provider_events` tables must be removed from the purge path.

### Safety Guard on Purge (Code Verified)

CODE VERIFIED: `cleanup/repository.ts:34-68` (`ACTIVE_PHYSICAL`, `safetyGuard`)

```sql
ACTIVE_PHYSICAL = (
  o.status IN ('CLAIMED','SPOOLING','PRINTING','PRINT_BLOCKED')
  OR EXISTS (SELECT 1 FROM print_attempt_steps active_step
    WHERE active_step.order_id = o.id
      AND active_step.status IN ('SUBMISSION_STARTED','SUBMITTED'))
  OR EXISTS (SELECT 1 FROM order_files active_file WHERE active_file.order_id = o.id
    AND active_file.print_status IN ('SUBMISSION_STARTED','SUBMITTED'))
)
```

This guard is strong. QUEUED, RETRY_PENDING, NEEDS_ADMIN, COMPLETION_UNKNOWN, ADMIN_ACTION_REQUIRED are **not** in `ACTIVE_PHYSICAL` — meaning they COULD be purged if they're COMPLETED (but they can't be COMPLETED while in those states, so the guard is fine for normal paths).

**Additional guard for ALL_PRINT_DATA scope**:

```sql
NOT (PAID_NONTERMINAL)  -- protects all paid non-completed orders
```

So even QUEUED paid orders are protected. ✅

**Gap**: `RECOVERY_REQUIRED` status does not exist in current code. If we add it in Phase 2, the safetyGuard must be updated to include it.

### Manual Delete Endpoint (Missing)

No `DELETE /api/admin/orders/:id` endpoint exists. The only delete path is the batch cleanup service. A single-order manual delete needs the same safety guard + same purge logic as `purgeOrder()`.

---

## 11. Automatic Cleanup Architecture

### Current Retention Timers

CODE VERIFIED: `packages/domain/src/constants.ts:30-39`

| Scope                                | Timer                                                          | Action                                    |
| ------------------------------------ | -------------------------------------------------------------- | ----------------------------------------- |
| Unpaid (CREATED → PAYMENT_CANCELLED) | `UNPAID_RETENTION_MS` = 10 min                                 | Draft expires; scheduled cleanup picks up |
| Failed/cancelled payment             | `FAILED_OR_CANCELLED_PAYMENT_RETENTION_MS` = 30 min            | —                                         |
| Completed order (PDF)                | `COMPLETED_PDF_RETENTION_MS` = configurable 1–12h (default 2h) | `purge_at_ms` set on order at completion  |
| Customer PII                         | `COMPLETED_CUSTOMER_PII_PURGE_MS` = 5h                         | Separate PII purge (see migration 0009)   |
| Unresolved paid failure              | `UNRESOLVED_PAID_FAILURE_RETENTION_MS` = 24h                   | —                                         |

### Cleanup Trigger Path

CODE VERIFIED: `cleanup/service.ts:240-257` (`runScheduled`)

1. `createScheduledRun("EXPIRED_UNPAID")` — if unpaid orders due
2. `createScheduledRun("COMPLETED_DUE")` — if `purge_at_ms <= nowMs` for COMPLETED orders
3. `scheduleDailyRun()` — ALL_PRINT_DATA at configured daily time
4. `nextRunnableRun()` — picks first runnable run
5. `processRun()` — deletes R2 then D1, batch of 5

### Desired: One Authoritative Purge Path

Currently: `CleanupService.processRun()` → `CleanupRepository.purgeOrder()` is the only code that deletes orders. **The manual Admin Delete (when implemented) MUST call `purgeOrder()` directly** — not duplicate the deletion SQL.

### Retention After Full Purge Design

The full purge requirement means `purgeOrder()` must:

1. Delete R2 objects (already done)
2. Delete D1 order + all related rows (already done)
3. **NOT insert into `retained_payment_records`** (change needed)
4. **NOT insert into `retained_provider_events`** (change needed)
5. **Null out `audit_logs.entity_id`** (already done)

---

## 12. Failure Matrix

| Scenario                                                         | Current Behavior                                                                                                                                                                                     | Risk                                                                                                                             | Desired Behavior                                                                                 | Code Change Needed                                                                                |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| **Power cut (A=PRINTING, B-T=QUEUED)**                           | After 5-min lease expiry + cron: A → ADMIN_ACTION_REQUIRED, B-T remain QUEUED                                                                                                                        | ✅ B-T safe; A requires admin decision                                                                                           | Same                                                                                             | None for queue durability; UI clarity needed                                                      |
| **Windows restart (clean)**                                      | Agent restarts, re-loads credentials, resumes heartbeat; `claimOrRenew()` finds A in PRINTING if lease valid, re-claims                                                                              | ⚠️ If lease expired between restart: A → ADMIN_ACTION_REQUIRED (correct); if lease valid: Agent re-receives A and checks journal | Correct                                                                                          | ExecutionJournalStore recovery path already handles this                                          |
| **Agent crash (PRINTING, mid-job)**                              | Lease expires → cron `recoverExpiredClaims` → ADMIN_ACTION_REQUIRED                                                                                                                                  | ✅ Correct after cron fires                                                                                                      | Same                                                                                             | None (cron wired in index.ts:55)                                                                  |
| **Agent offline (PREFLIGHT_DEFERRED, printer offline)**          | Lease renewed indefinitely — **ROOT CAUSE OF PA-088**                                                                                                                                                | 🔴 CRITICAL: entire queue blocked                                                                                                | After N deferred cycles, report BLOCKED to server                                                | `paid-print-executor.ts`: add deferral counter, after 2 deferrals call `reportPrintStep(BLOCKED)` |
| **Agent stale (heartbeat > 90s)**                                | Server-side: `agents.last_heartbeat_at_ms >= nowMs - 90000` check in candidate query; stale agent cannot claim new orders                                                                            | ✅ New claims blocked; existing claim lease expires normally                                                                     | Same                                                                                             | None                                                                                              |
| **Duplicate Agent (two instances)**                              | D1 credential hash lookup is authoritative. Two instances with same secret both get valid agentId. Both pulse. One claims an order; both try to renew — `claim_id` mismatch prevents second renewal. | ⚠️ Possible brief double heartbeat; claim protected by `claim_id` guard                                                          | Print safety maintained by claim_id                                                              | None — claim_id provides protection                                                               |
| **Internet loss (agent-side)**                                   | Agent: heartbeat throws, `failures++`, exponential backoff to 30s                                                                                                                                    | ✅ Agent backs off; lease expires if down >5min                                                                                  | Same                                                                                             | None                                                                                              |
| **Worker/API unavailable**                                       | Agent gets 503 or connection error, treats as network failure                                                                                                                                        | ✅ Same as internet loss                                                                                                         | Same                                                                                             | None                                                                                              |
| **Printer powered off (before claim)**                           | `printerReports` shows OFFLINE; agent does NOT mark printer ONLINE; `claimOrRenew` candidate query checks `p.status = 'ONLINE'` → no claim                                                           | ✅ No new claims while printer offline                                                                                           | Same                                                                                             | None                                                                                              |
| **Printer powered off (after claim, during PREFLIGHT_DEFERRED)** | See "Agent offline / PREFLIGHT_DEFERRED" above — root cause                                                                                                                                          | 🔴 Critical                                                                                                                      | After 2 deferrals, report BLOCKED                                                                | `paid-print-executor.ts` fix                                                                      |
| **USB disconnected**                                             | Windows reports printer OFFLINE or BLOCKED in WMI; agent detects → PREFLIGHT_DEFERRED loop                                                                                                           | 🔴 Same as above                                                                                                                 | Same fix                                                                                         | Same fix                                                                                          |
| **Wi-Fi printer disconnected (WSD)**                             | WSD WorkOffline latch: Windows marks `WorkOffline: true`, does NOT clear automatically                                                                                                               | 🔴 WSD-specific: even when printer reconnects, agent sees OFFLINE until Windows clears latch                                     | Need WSD socket probe to detect false-offline                                                    | `windows-printer-adapter.ts`: WSD endpoint IP resolution + TCP probe                              |
| **WSD stale status**                                             | Same as above                                                                                                                                                                                        | 🔴                                                                                                                               | Same                                                                                             | Same                                                                                              |
| **Paper jam (during print)**                                     | Agent `monitorSpoolJob()` → BLOCKED → `reportPrintStep(BLOCKED)` → D1 order: PRINT_BLOCKED, printer: is_paused=1                                                                                     | ✅ Correct                                                                                                                       | Same                                                                                             | None                                                                                              |
| **Paper out (during print)**                                     | Same as paper jam path                                                                                                                                                                               | ✅ Correct                                                                                                                       | Same                                                                                             | None                                                                                              |
| **Paper jam (before claim)**                                     | Printer status = BLOCKED; `p.status = 'ONLINE'` check in candidate query excludes it — no claim                                                                                                      | ✅ Correct                                                                                                                       | Same                                                                                             | None                                                                                              |
| **Windows spool job manually cancelled**                         | `monitorSpoolJob()` returns `COMPLETED_OR_REMOVED`; agent checks post-status; if printer not blocked → `reportPrintStep(SUCCEEDED)`                                                                  | ⚠️ Manual cancel looks like success — order completed even though paper didn't print                                             | Need: distinguish "removed while queued" from "printed then removed"                             | Not trivially detectable from Windows API. Document as known limitation.                          |
| **Spool job disappears (no observation)**                        | `monitorSpoolJob()` timeout → `UNCERTAIN` → order: COMPLETION_UNKNOWN                                                                                                                                | ✅ Conservative path                                                                                                             | Same                                                                                             | None                                                                                              |
| **Spool identity missing (SUBMISSION_STARTED, no spoolerJobId)** | On agent restart: `paid-print-executor.ts:48-64` checks journal; if no spoolerJobId in journal → `reportPrintStep(UNCERTAIN)`                                                                        | ✅ Conservative                                                                                                                  | Same                                                                                             | None                                                                                              |
| **Printer renamed/reinstalled**                                  | `windows_printer_name` on order mismatches actual printer name → `PrinterNotFoundError` → `reportPrintStep(FAILED)`                                                                                  | ✅ Fails cleanly                                                                                                                 | Same                                                                                             | None                                                                                              |
| **PDF missing (R2 unavailable / deleted)**                       | `downloadAndValidateCustomerPdf()` throws → `reportKnownPreSubmissionFailure(FAILED)`                                                                                                                | ✅ Fails cleanly                                                                                                                 | Same                                                                                             | None                                                                                              |
| **R2 unavailable**                                               | Same as PDF missing                                                                                                                                                                                  | ✅                                                                                                                               | Same                                                                                             | None                                                                                              |
| **Stale CLAIMED (PREFLIGHT_DEFERRED loop)**                      | Root cause — see above                                                                                                                                                                               | 🔴                                                                                                                               | Fix in executor                                                                                  | `paid-print-executor.ts`                                                                          |
| **Stuck PRINTING (physically stalled)**                          | No detection. Order stays PRINTING until agent dies or lease expires.                                                                                                                                | 🔴 Can stay PRINTING indefinitely                                                                                                | Stall detection: expose Recover after 5 min without progress signal                              | New: `last_progress_at` field + cron check                                                        |
| **PRINT_BLOCKED forever**                                        | Printer stays paused; agent stays in PREFLIGHT_DEFERRED if block preexisted claim                                                                                                                    | 🔴 Queue blocked                                                                                                                 | Recovery UI: un-pause printer, re-queue or retry                                                 | Recover Printing flow                                                                             |
| **20 waiting orders**                                            | B-T all stay in QUEUED in D1; only A is active                                                                                                                                                       | ✅ Durable                                                                                                                       | Same                                                                                             | None                                                                                              |
| **Priority order while recovery occurs**                         | No recovery lock → priority order could be claimed during recovery if `claims_paused` doesn't exist                                                                                                  | ⚠️ Priority order starts while A is being reconciled                                                                             | Add `claims_paused` flag, check in `claimOrRenew`                                                | New field in `installation`                                                                       |
| **ID sheet pairing (2-step job)**                                | Identification sheet + document printed as sequential steps within one attempt; both tracked in `print_attempt_steps`                                                                                | ✅ Handled                                                                                                                       | Same                                                                                             | None                                                                                              |
| **Repeated Recover click**                                       | No lock → second call proceeds concurrently                                                                                                                                                          | ⚠️                                                                                                                               | Recovery lock in D1                                                                              | New `recovery_lock_id` field                                                                      |
| **Repeated Print Again click**                                   | Second call hits `ORDER_CANNOT_BE_RETRIED` (order is already QUEUED)                                                                                                                                 | ✅ Safe (D1 conditional UPDATE)                                                                                                  | Same                                                                                             | None                                                                                              |
| **Two Admin tabs (both retry)**                                  | Second UPDATE gets changes=0 → throws `ORDER_CANNOT_BE_RETRIED`                                                                                                                                      | ✅ Safe                                                                                                                          | Same                                                                                             | None                                                                                              |
| **Cleanup during recovery**                                      | `cleanup_state` guard: ACTIVE_PHYSICAL blocks cleanup of printing/claimed orders                                                                                                                     | ✅ Cleanup cannot delete an active order                                                                                         | Same                                                                                             | None                                                                                              |
| **Delete during printing**                                       | No Delete endpoint exists yet; when implemented: check ACTIVE_PHYSICAL guard                                                                                                                         | Must implement guard                                                                                                             | Enforce `status NOT IN (QUEUED, CLAIMED, SPOOLING, PRINTING, PRINT_BLOCKED, ...)`                | Phase 5                                                                                           |
| **Late payment webhook after purge**                             | `handleRazorpayWebhook`: checks `findRetainedPaymentByProviderOrderId` before failing                                                                                                                | ✅ Handles gracefully: returns 200 duplicate if retained record matches                                                          | But if we remove retained_payment_records: webhook will throw "Webhook payment order is unknown" | Need alternative late-webhook deduplication if we remove retained tables                          |
| **Old browser request after purge**                              | Customer tracking: order not found → 404                                                                                                                                                             | ✅ Handled                                                                                                                       | Same                                                                                             | None                                                                                              |

---

## 13. Race-Condition Analysis

### Race 1: Cleanup During Recovery

```
Timeline:
  T1: Admin starts Recover (no recovery lock yet)
  T2: Cron cleanup runs, finds order COMPLETED, starts purge
  T3: Admin recovery reads order → now missing
```

**Current protection**: Recovery only runs on CLAIMED/SPOOLING/PRINTING/PRINT_BLOCKED orders. Cleanup's `ACTIVE_PHYSICAL` guard excludes these. No race is possible on an actively-printing order. ✅

### Race 2: Print Again Racing With Active Print

```
T1: Admin sees order PRINTING → calls retryOrder()
T2: retryOrder() checks status → PRINTING
T3: retryOrder() throws ORDER_CANNOT_BE_RETRIED
```

✅ Protected by retriableStatuses check.

### Race 3: Print Again Racing With Cleanup (COMPLETED order)

```
T1: Order COMPLETED, purge_at_ms passed
T2: Admin calls retryOrder()
T3: Cron cleanup marks cleanup_state='CLAIMED'
T4: retryOrder() UPDATE WHERE cleanup_state='ACTIVE' → changes=0 → throws ORDER_CANNOT_BE_RETRIED
```

✅ Protected by `cleanup_state='ACTIVE'` guard in retryOrder SQL.

### Race 4: Webhook After Purge

```
T1: Order purged (payments deleted)
T2: Razorpay sends delayed webhook
T3: webhook looks up payment by provider_order_id → not found
T4: checks retained_payment_records → found (if full-purge not yet implemented)
T5: returns 200 duplicate ✅
```

**If retained_payment_records is removed (full-purge)**: T4 fails → webhook returns 500 `WEBHOOK_PROCESSING_FAILED`. This is technically harmless (Razorpay retries; no money movement needed) but noisy. Need to return 200 for order-not-found case.

### Race 5: R2 Delete / D1 Delete Split

```
T1: cleanup deletes R2 object (success)
T2: D1 purgeOrder() fails (D1 error, timeout)
T3: cleanup catches error, records failure
T4: Retry: R2 delete called again → R2 returns success (idempotent; already gone)
T5: D1 purgeOrder() runs again → removes rows
```

CODE VERIFIED: `cleanup/service.ts:154-177` — failures are caught, logged, retried via `cleanup_run_items` with exponential backoff (max 1h). ✅ Retry-safe.

**But**: Between T2 and T5, D1 has full order data pointing to a non-existent R2 object. If agent tries to print this order during that window (should be impossible since cleanup only runs on COMPLETED orders which are not in queue, but theoretical): PDF download would fail → `reportKnownPreSubmissionFailure(FAILED)`. ✅ Handled.

### Race 6: Two Admin Tabs on Clear Waiting Queue

Both call `UPDATE orders SET status='CANCELLED' WHERE status='QUEUED'` — idempotent (second call updates 0 rows). ✅ Safe.

---

## 14. D1 / R2 Implications

### D1 Foreign Keys

CODE VERIFIED: `database/migrations/0016_phase4_failure_recovery_and_pause.sql:71-73`

```sql
FOREIGN KEY (claimed_by_agent_id) REFERENCES agents(id) ON DELETE RESTRICT,
FOREIGN KEY (printer_id) REFERENCES printers(id) ON DELETE RESTRICT,
FOREIGN KEY (printer_id, claimed_by_agent_id) REFERENCES printers(id, agent_id) ON DELETE RESTRICT,
```

`ON DELETE RESTRICT` means an agent cannot be deleted while it has claimed orders. Safe. But if we add `recovery_lock_id` to `installation`, it must be nullable and not a FK.

`order_events` FK to `orders`:

```sql
FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
```

CODE VERIFIED: `0016:167` — cascade delete on order_events. purgeOrder() manually deletes order_events before deleting orders, so cascade is a safety net.

`print_attempt_steps` FK:

```sql
FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE RESTRICT  -- migration 0006:29
```

So steps must be deleted before the order row. purgeOrder() does this correctly. ✅

### R2 Key Format

CODE VERIFIED: `cleanup/service.ts:13-25` (`isOwnedUploadKey`)

```
uploads/<orderId>/<uuid>.pdf
uploads/<year>/<month>/<orderId>/<uuid>.pdf
```

Cleanup validates key format before deleting. ✅

### Orphan R2 Objects

If an upload's `storage_status` becomes `DELETE_PENDING` or `DELETE_FAILED`, it may remain in R2 indefinitely. The `claimBatch()` query joins `uploads` and `order_files` to collect all keys. `isOwnedUploadKey()` validation prevents arbitrary key deletion. ✅ But if R2 lifecycle rules are not set, failed-delete objects stay forever. Recommend R2 lifecycle rules as belt-and-suspenders.

### New Fields Required by Proposed Architecture

| Field                   | Table            | Type              | Purpose                                 |
| ----------------------- | ---------------- | ----------------- | --------------------------------------- |
| `recovery_lock_id`      | `installation`   | TEXT NULL         | Prevent concurrent recovery ops         |
| `recovery_locked_at_ms` | `installation`   | INTEGER NULL      | Lock timeout (auto-release after 5 min) |
| `claims_paused`         | `installation`   | INTEGER DEFAULT 0 | Pause new claims during recovery        |
| `last_progress_at_ms`   | `print_attempts` | INTEGER NULL      | Stall detection signal                  |

---

## 15. Windows Agent Implications

### ExecutionJournal (Crash Recovery)

CODE VERIFIED: `apps/agent/windows/src/storage/execution-journal.ts`

- Stored at `%LOCALAPPDATA%\PrintGo\active-print.json`
- Saves: `{ orderId, attemptId, stepId, spoolerJobId, updatedAtMs }`
- On agent restart: journal loaded → if matching current job → recovery path
- If `SUBMISSION_STARTED` and no `spoolerJobId` in journal → `UNCERTAIN` reported ✅
- If `SUBMITTED` with `spoolerJobId` → re-observes existing spool job ✅
- Atomic write via temp file + rename ✅

### PREFLIGHT_DEFERRED Loop (Gap Confirmed)

CODE VERIFIED: `paid-print-executor.ts:111-143`
The fix needed: add a deferral counter. After 2 consecutive deferrals (60 seconds), call:

```typescript
await this.client.reportPrintStep(credentials, job, {
  status: "BLOCKED",
  failureCode: "PRINTER_OFFLINE",
  failureDetail: "Printer has been offline for >60 seconds before submission.",
});
```

This transitions order to PRINT_BLOCKED on server, unpauses queue eventually, and makes the state visible to Admin UI.

### WSD / Wi-Fi Printer False-Offline

CODE VERIFIED: `printing/windows-printer-adapter.ts` (reference from prior audit)  
`WorkOffline: true` in WMI is not cleared automatically when printer reconnects. TCP probe to port 9100 can detect actual connectivity independently of WMI state. This is a Windows-specific enhancement for Phase 6.

### Agent Version Check in Recovery

The proposed RecoveryController should verify `agents.agent_version` (stored in heartbeat) to ensure the agent can execute recovery requests. Not currently stored in agents table — needs schema addition or relies on heartbeat payload.

---

## 16. UI / API Changes Required

### Phase 2 (State Machine + Foundation)

- D1 migration: add `recovery_lock_id`, `recovery_locked_at_ms`, `claims_paused` to `installation`
- D1 migration: add `last_progress_at_ms` to `print_attempts`
- Update `recoverExpiredClaims()` to check `claims_paused` flag and skip new claims during recovery
- Fix `paid-print-executor.ts`: bounded PREFLIGHT_DEFERRED (2 retries → BLOCKED)

### Phase 3 (Recover Printing + Stall)

- New endpoint: `POST /api/admin/recovery/start`
- New endpoint: `GET /api/admin/system/print-status` (structured agent+printer health)
- Stall detection in cron: query `last_progress_at_ms`, expose `isStalled` flag to Admin UI
- Admin UI: "Print System" panel in top-right with Agent status, Printer status, Recover button (contextual enable/disable), waiting count

### Phase 4 (Admin Per-Order + Clear Queue)

- New endpoint: `POST /api/admin/queue/clear-waiting`
- Modify `retryOrder()`: require `forcePrinted=true` for COMPLETED/PRINTED orders
- Modify admin-routes.ts: handle `UNCERTAIN_RETRY_CONFIRMATION_REQUIRED` and `PRINTED_RETRY_CONFIRMATION_REQUIRED`
- Admin UI: per-order controls with idempotency check (show "Already queued" for active states)

### Phase 5 (Full Purge + Cleanup Unification)

- New endpoint: `DELETE /api/admin/orders/:id` (calls same `purgeOrder()`)
- Remove `INSERT INTO retained_payment_records` from `purgeOrder()`
- Remove `INSERT INTO retained_provider_events` from `purgeOrder()`
- Update webhook handler: return 200 gracefully when order not found post-purge
- New table: potentially `purged_payment_references` (just provider_order_id + purged_at_ms, no financial data) for webhook deduplication

### Phase 6 (Tests + Windows)

- `paid-print-executor.ts`: deferral counter + BLOCKED escalation
- `windows-printer-adapter.ts`: WSD TCP probe for false-offline detection
- Acceptance tests: power-cut scenario, 20-order queue restore, paper jam recovery

---

## 17. Tests Required

### Unit Tests

- `RecoveryController.classify()`: all classification branches (SAFE, UNCERTAIN, BLOCKED, ORPHANED, HEALTHY)
- `retryOrder()`: COMPLETED requires `forcePrinted=true`; returns existing if already QUEUED
- `purgeOrder()`: no rows in `retained_payment_records` after full purge
- `claimOrRenew()`: respects `claims_paused` flag — no new claims when paused
- `OrderPurgeService.purge()`: active order refused with correct error code

### Integration Tests

- Recovery lock acquired → second concurrent recovery returns `RECOVERY_ALREADY_IN_PROGRESS`
- Stall detection: `last_progress_at_ms` > 5 min → `isStalled=true` in print-status endpoint
- Clear Waiting Queue: only QUEUED orders cancelled, active order untouched
- Late webhook after full purge: returns 200 not 500

### Physical Acceptance Tests (Phase 6)

- Power cut during PRINTING: after reconnect, A → ADMIN_ACTION_REQUIRED, B-T proceed
- Printer offline: after 60s (2 deferrals), order → PRINT_BLOCKED, queue unblocks
- Paper jam mid-print: order → PRINT_BLOCKED, Recover unblocks after jam cleared
- Recover Printing: SAFE_TO_RETRY path re-queues without duplication
- Recover Printing: UNCERTAIN path shows warning, requires explicit admin choice

---

## 18. Clean Implementation Plan

### Architecture Targets

| Component              | Responsibility                                                                                              | Currently Exists?                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **QueueSupervisor**    | `claimOrRenew()`, `recoverExpiredClaims()`, `autoRetryEligibleOrders()` — already in `D1PrintingRepository` | ✅ Partial                                                   |
| **RecoveryController** | Single entry point for safe recovery; acquires lock, classifies, repairs                                    | ❌ Missing                                                   |
| **OrderPurgeService**  | Authoritative delete: R2 + D1 + safety guard; shared by manual delete + scheduled cleanup                   | ❌ Missing (code is in CleanupRepository but not abstracted) |
| **CompletionPolicy**   | Decides transition after step SUCCEEDED (COMPLETED vs AWAITING_FINISHING)                                   | ✅ Embedded in `completeAttemptIfReady()` in repository      |

The recommendation is **not** to create new microservices. Instead:

1. Extract `OrderPurgeService` from `CleanupRepository.purgeOrder()` — make it callable from both cleanup runs and admin single-delete
2. Add `RecoveryController` as a new service class in `apps/api/worker/src/recovery/`
3. Keep `QueueSupervisor` as `D1PrintingRepository` (it's already coherent)
4. Keep `CompletionPolicy` inline in `completeAttemptIfReady()` — it's small and tightly coupled

### Phase 2 — State Machine + Recovery Foundation

**Scope**: D1 schema additions + PREFLIGHT_DEFERRED bounded fix + cron wiring confirmed

- Migration 0022: `installation.recovery_lock_id`, `installation.recovery_locked_at_ms`, `installation.claims_paused`
- Migration 0022: `print_attempts.last_progress_at_ms`
- `paid-print-executor.ts`: add `preflight_deferrals` counter field; after 2 defers → `reportPrintStep(BLOCKED)`
- `claimOrRenew()`: check `claims_paused = 0` before claiming new order (not on renewal)
- **Deliverable**: PREFLIGHT_DEFERRED no longer infinitely stalls CLAIMED orders

### Phase 3 — Recover Printing + Stall Detection

**Scope**: RecoveryController + stall watchdog + Admin UI control panel

- `apps/api/worker/src/recovery/service.ts`: `RecoveryController` (lock, classify, repair, release)
- New route: `POST /api/admin/recovery/start` (requires `{ confirmation: "RECOVER" }`)
- New route: `GET /api/admin/system/print-status` (agent heartbeat age, printer health, active order, waiting count, isStalled)
- Cron: add stall check query to scheduled handler
- Admin UI: Print System control panel (Agent/Printer status → Recover button with contextual message)
- **Deliverable**: Shopkeeper can recover without editing D1, restarting PC, or opening print queue

### Phase 4 — Admin Per-Order Controls + Clear Waiting Queue

**Scope**: Idempotent Print Again + Clear Queue endpoint + Admin UI controls

- `retryOrder()`: add `forcePrinted` parameter; guard COMPLETED/PRINTED orders
- `admin-routes.ts`: handle `PRINTED_RETRY_CONFIRMATION_REQUIRED`
- New route: `POST /api/admin/queue/clear-waiting`
- Admin UI: per-order buttons with correct enable/disable logic; "Already in queue" if active
- **Deliverable**: All described Admin controls are safe and idempotent

### Phase 5 — Full Purge + Automatic Cleanup Unification

**Scope**: `OrderPurgeService` abstraction + full-purge (no retained records) + manual delete endpoint

- Extract `OrderPurgeService` from `CleanupRepository.purgeOrder()` (same SQL, same safety guard)
- Remove `INSERT INTO retained_payment_records` and `INSERT INTO retained_provider_events` from purge path
- Add: return 200 gracefully in webhook when order not found (not in retained_payment_records)
- New route: `DELETE /api/admin/orders/:id` (calls `OrderPurgeService` with full safety guard)
- Update `CleanupService` to call `OrderPurgeService` instead of direct repository
- Migration 0023: `DROP TABLE retained_payment_records` and `DROP TABLE retained_provider_events` (or keep empty for reference — **schema decision needed**)
- **Deliverable**: One delete code path; PrintGo does not permanently retain financial records

### Phase 6 — Failure/Race Tests + Windows Physical Acceptance

**Scope**: Test coverage + WSD fix + Windows physical validation

- Unit tests for all new components (RecoveryController, OrderPurgeService, idempotent Print Again)
- Integration tests for lock contention, cleanup races, late webhooks
- `windows-printer-adapter.ts`: WSD endpoint TCP probe for false-offline
- Physical test: 20-order queue → power cut → restore → verify B-T proceed, A in ADMIN_ACTION_REQUIRED
- **Deliverable**: All scenarios in failure matrix tested; Windows Agent upgraded

---

_End of Audit — ANALYSIS ONLY — No code modified_
