# Retention and deletion verification

Date: 2026-10-01

Repository revision inspected: `34765c12265a3fa61a5daa84a90e13bb67e821f8`

Decision: **FAIL — do not proceed to controlled production orders or deployment**

## Executive result

The current runtime does set an unpaid deadline to 10 minutes after the latest
qualifying draft action and a completed-order deadline to 2 hours after the
successful final-file completion transition. Exact `T-1 ms`, `T`, and `T+1 ms`
eligibility checks passed locally. Single- and three-file simulated R2/D1
cleanup also passed.

The requested policy is not fully implemented safely:

1. A `CREATED` or `PENDING` payment blocks unpaid cleanup indefinitely; there is
   no stale-payment transition that makes an abandoned payment eligible at 10
   minutes.
2. Completed cleanup deletes `print_attempts`, `print_attempt_steps` (including
   spool identity), and `order_events`. Payment/provider summaries and generic
   audit logs survive, but duplicate-print investigation evidence does not.
3. A cleanup run that fails once and later drains successfully remains
   `PARTIAL`; subsequent empty scheduler cycles write to it again.
4. The production aggregate snapshot is inconsistent with a uniform two-hour
   deadline: 8 completed rows were exact, 3 were shorter, and 5 lacked
   `purge_at_ms`.

Per the task's hard stop, no real Razorpay payment, production order, production
R2 object, manual timestamp update, cleanup invocation, deployment, or push was
performed.

## Evidence labels and scope

- **MEASURED LOCAL with SIMULATED R2**: actual migrations plus the current
  cleanup service/repository, SQLite, a fake clock, and an in-memory R2 binding.
- **MEASURED CLOUD**: read-only aggregate D1 queries and one-hour Query Insights;
  no PII or identifiers were retained in evidence.
- **MODELED**: the expected scheduler window derived from the five-minute cron.
- **NOT VERIFIED**: a natural production expiry and actual Cloudflare R2 delete.

Artifacts:

- `scripts/verify-retention-deletion.mjs`
- `docs/evidence/retention-deletion-verification/local/controlled-retention-matrix.json`
- `docs/evidence/retention-deletion-verification/cloud/production-aggregate.json`

## 1–5. Implemented rules, timer origin, scheduler, and deletion window

| Data/state                    |             Current duration | Starting timestamp                                                                            | Eligibility condition                                                          | D1 action                                         | R2 action                                      | Source                                                                                                                                             |
| ----------------------------- | ---------------------------: | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| New unpaid draft              |                   10 minutes | Draft creation                                                                                | `draft_expires_at_ms <= now`, eligible status, no active payment/physical work | Whole order graph purged after R2 success         | Delete every owned `order_files.r2_object_key` | `packages/domain/src/constants.ts:30`; `apps/api/worker/src/customer/service.ts:134-168`; `apps/api/worker/src/cleanup/repository.ts:21-28,66-81`  |
| Validated upload              |            10 minutes, reset | Successful upload validation                                                                  | Same as above                                                                  | Same                                              | Same                                           | `apps/api/worker/src/customer/service.ts:183-238`                                                                                                  |
| Added file                    |            10 minutes, reset | File addition                                                                                 | Same as above                                                                  | Same                                              | Same                                           | `apps/api/worker/src/customer/service.ts:241-282`                                                                                                  |
| Saved quote                   |            10 minutes, reset | Quote save                                                                                    | Same as above                                                                  | Same                                              | Same                                           | `apps/api/worker/src/customer/service.ts:478-498`                                                                                                  |
| Failed/cancelled payment      |                   30 minutes | Explicit failure/cancel transition                                                            | Expired deadline and no active payment                                         | Same                                              | Same                                           | `packages/domain/src/constants.ts:31`; `apps/api/worker/src/payments/service.ts:459-485`; `apps/api/worker/src/payments/repository.ts:575-642`     |
| Stale pending payment         |       **Unbounded mismatch** | No expiry transition exists                                                                   | Excluded while payment is `CREATED`/`PENDING`                                  | None                                              | None                                           | `apps/api/worker/src/payments/repository.ts:358-423`; `apps/api/worker/src/cleanup/repository.ts:21-26,44-45`                                      |
| Automatically completed order |                      2 hours | Atomic final-file success time used for `printed_at_ms`, `completed_at_ms`, and `purge_at_ms` | `status='COMPLETED' AND purge_at_ms <= now`                                    | Whole order graph purged after R2 success         | Delete every owned key                         | `packages/domain/src/constants.ts:32-33`; `apps/api/worker/src/printing/repository.ts:972-1076`; `apps/api/worker/src/cleanup/repository.ts:27-28` |
| Manually completed order      |                      2 hours | Authorized manual-complete time                                                               | Same                                                                           | Same                                              | Same                                           | `apps/api/worker/src/printing/repository.ts:1194-1305`                                                                                             |
| Payment/provider evidence     | Indefinite in current schema | Copied at purge                                                                               | Purge transaction                                                              | Compact records inserted, raw linked rows deleted | None                                           | `database/migrations/0012_multi_file_cleanup_and_app_branding.sql:151-179`; `apps/api/worker/src/cleanup/repository.ts:334-404`                    |
| Print forensic evidence       | Only until completed cleanup | Print execution                                                                               | Deleted during purge                                                           | Attempts, steps, and order events deleted         | None                                           | `apps/api/worker/src/cleanup/repository.ts:367-379`                                                                                                |
| Cleanup audit/run             |      No retention rule found | Cleanup execution                                                                             | Retained                                                                       | Run/item rows remain                              | None                                           | `database/migrations/0012_multi_file_cleanup_and_app_branding.sql:112-149`                                                                         |

The runtime scheduler is `*/5 * * * *`
(`apps/api/worker/wrangler.jsonc:10-12`) and calls the new cleanup service
(`apps/api/worker/src/index.ts:26-47`). The older retention POST is disabled with
HTTP 410 (`apps/api/worker/src/retention/admin-routes.ts:62-73`).

**MODELED expected window:** in a healthy, backlog-free system, an eligible item
is normally attempted from `T` through just after `T + 5 minutes`. This is not a
hard upper bound: batch limits, open runs, R2 failures, or scheduler outages can
delay physical deletion. Failed R2 deletion retries at 5, 10, 20, 40, then 60
minutes (capped), from `apps/api/worker/src/cleanup/repository.ts:406-428`.

The printed timer does **not** start from creation, payment, Agent claim, or
submission. It starts when the last required file's print steps have succeeded
and the order atomically becomes `COMPLETED`, or from the explicit manual
completion time.

## 6–7. Customer-field deletion and intentional retention

The active cleanup path does not redact individual order fields. After all R2
deletes succeed, it deletes the order graph. Therefore the following values are
removed together.

| Field/data                                                         | Classification           | Reason/result                                                                                          |
| ------------------------------------------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------ |
| Customer name, phone, instructions                                 | DELETE                   | Stored on `orders`; deleted with the row.                                                              |
| Original filenames                                                 | DELETE                   | Removed from `orders`, legacy `uploads`, and all `order_files`.                                        |
| R2 object keys and file metadata                                   | DELETE                   | `uploads` and `order_files` are deleted after R2 success.                                              |
| Draft-token hash, tracking-token hash                              | DELETE                   | Hashes are on `orders`; raw draft token is never stored.                                               |
| Public job code                                                    | DELETE                   | Deleted with `orders`; not copied to retained payment records.                                         |
| Print settings/page selections/status timestamps                   | DELETE                   | Deleted with `orders`/`order_files`.                                                                   |
| Email, IP address, device/user-agent data                          | NOT APPLICABLE           | No corresponding order/customer fields were found in the current schema.                               |
| Provider order/payment IDs, amount, currency, payment status/times | RETAIN                   | Compact `retained_payment_records` supports reconciliation and idempotency without customer/file data. |
| Provider event ID/type/status/times                                | RETAIN                   | Compact `retained_provider_events` preserves webhook idempotency/audit evidence.                       |
| Generic `audit_logs`                                               | RETAIN                   | Cleanup does not delete this table; it may retain actor/order UUID references and action/time.         |
| Cleanup runs/items                                                 | RETAIN                   | Operational deletion audit; includes order UUID, counts, errors, and retry state.                      |
| Print attempts, steps, spooler job IDs, order events               | **DELETE — SAFETY FAIL** | Current purge removes the detailed evidence needed for duplicate-print/uncertain-work investigation.   |

The order schema fields are defined in
`database/migrations/0001_initial_schema.sql:147-212`, upload/payment/provider
fields in `database/migrations/0001_initial_schema.sql:227-310`, draft-token hash
in `database/migrations/0002_customer_draft_upload.sql:3-14`, and multi-file
names/keys/spool IDs in
`database/migrations/0012_multi_file_cleanup_and_app_branding.sql:41-76`.

## 8–9. R2 and D1 deletion flow

The current flow is:

1. The indexed candidate/open-run gates determine whether a run is needed.
2. A bounded batch claims the whole order and gathers every `order_files` key.
3. Each key is checked against the owning order ID.
4. `await bucket.delete(objectKeys)` runs first.
5. Only after that promise succeeds does the D1 purge copy compact payment and
   provider evidence, delete linked rows, delete the order, mark the cleanup item
   `DELETED`, and increment run totals.
6. Any validation or R2/D1 exception records a failed item with bounded backoff.

This ordering does not falsely mark D1 cleanup successful after an R2 exception
(`apps/api/worker/src/cleanup/service.ts:137-167`). It does have the normal
cross-system limitation that R2 may succeed and D1 may then fail; retrying the
idempotent R2 delete is the recovery path.

## 10–18. Controlled matrix results

| Test                             | Evidence                       | Result                                                                                                                               |
| -------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| U1 unpaid, one file              | MEASURED LOCAL + SIMULATED R2  | PASS: present at `T-1`; eligible/deleted at `T`; order, upload, and file rows gone; unrelated order/object retained.                 |
| U2 unpaid, three files           | MEASURED LOCAL + SIMULATED R2  | PASS: all three objects and references removed; no orphan/dangling file row; unrelated object retained.                              |
| P1 completed, one file           | MEASURED LOCAL + SIMULATED R2  | PARTIAL: timing/R2/D1/payment/provider/audit checks pass; print forensics are deleted, so safety acceptance fails.                   |
| P2 completed, three files        | MEASURED LOCAL + SIMULATED R2  | PARTIAL: all three objects/references removed and unrelated data retained; same forensic-retention failure.                          |
| N1 paid but not printed          | MEASURED LOCAL                 | PASS: protected.                                                                                                                     |
| N2 active print                  | MEASURED LOCAL                 | PASS: `PRINTING`/submitted work protected.                                                                                           |
| N3 failed/uncertain print        | MEASURED LOCAL                 | PASS before completion: `ADMIN_ACTION_REQUIRED`/`UNCERTAIN` work protected. Long-term forensic evidence after completed purge fails. |
| Stale pending payment            | MEASURED LOCAL                 | FAIL: survives, but never becomes cleanup-eligible at the expired ten-minute deadline.                                               |
| Boundary unpaid/completed        | MEASURED LOCAL                 | PASS: false at `T-1 ms`, true at `T` and `T+1 ms`.                                                                                   |
| Cloud R2 before/after existence  | NOT VERIFIED                   | Not attempted because the source/policy gate failed.                                                                                 |
| Old signed URL/token after purge | SIMULATED / NOT VERIFIED CLOUD | D1 owner/token rows and R2 object disappear locally; actual Cloudflare URL behavior was not tested.                                  |

The local harness asserts that no unrelated order or object changes and that all
multi-file keys are removed. It queries the database after cleanup to prove no
`order_files` or legacy `uploads` reference remains; it does not infer R2 deletion
from a success status.

## 19. Retry behavior

**MEASURED LOCAL:** an injected R2 delete failure preserved both the R2 object
and D1 order, wrote a failed cleanup item, and scheduled the first retry for five
minutes later. A cron at `next_attempt_at_ms - 1` made zero writes. At the retry
deadline, R2/D1 deletion succeeded.

**FAIL:** the drained run remained `PARTIAL` because terminal status depends on
historical `failures > 0` (`apps/api/worker/src/cleanup/repository.ts:431-472`).
Since open/runnable queries include every `PARTIAL` run
(`apps/api/worker/src/cleanup/repository.ts:50-63,203-223`), the next empty cycle
made one redundant write.

## 20. D1 cleanup cost

The previous captured top-30 baseline attributed 239,150 rows read (75.89% of
that capture) to the scheduled preview path; this historical comparison is from
the earlier optimization evidence and is not re-measured by this verification.

After migration 0013, **MEASURED CLOUD** one-hour Query Insights showed the
open-run probe 6 times at one row read each and zero writes. The completed-due
claim appeared 5 times with zero returned rows/writes. This supports the cheap
indexed gate, but the window is short, Insights can lag, and verification queries
contaminate it. It is not a production capacity recalculation.

**MEASURED LOCAL:** a clean empty scheduled cycle used 6 SQL statements, returned
1 row, changed 0 rows, and made 0 R2 deletes. A failed item before its retry
deadline made 0 writes. Post-recovery empty behavior failed as described above.

Migration 0013 adds the partial open-run index and retry columns at
`database/migrations/0013_d1_usage_optimization.sql:3-17`; the candidate/open-run
gates are at `apps/api/worker/src/cleanup/service.ts:170-189`.

## Production read-only snapshot

**MEASURED CLOUD, aggregate only:** 16 completed orders existed. Of these, 8 had
an exact `completed_at_ms + 7,200,000` deadline, 3 had a shorter delta
(minimum 6,883,176 ms), and 5 had no `purge_at_ms`. There were 22
`PAYMENT_PENDING` orders, consistent with the stale-active-payment risk. The
scheduled unpaid run was still `RUNNING` after 1,060 cumulative failures, with
the error class `Cleanup candidate contains an invalid object key`; the current
aggregate key-shape check did not locate a present malformed key, so the exact
historical offender remains unknown.

This snapshot proves neither Cloudflare R2 deletion nor natural deadline timing.
It does prove production rows are not uniformly in the expected deadline shape.

## 21. NOT VERIFIED

- Actual Cloudflare R2 deletion for controlled unpaid/completed production files.
- Natural 10-minute and two-hour production checkpoints and cleanup run IDs.
- Customer/Admin download denial using an old production token or signed URL.
- Live Razorpay payment/webhook/refund behavior during purge.
- Windows physical print completion and spooler behavior.
- The exact historic object key(s) behind the production cleanup failures.
- A long post-deployment Query Insights window and revised daily capacity model.

## Minimal safe changes requiring owner approval

No production behavior was changed. The smallest safe remediation set is:

1. Add an atomic stale `CREATED`/`PENDING` payment reconciliation/expiry path so
   abandoned unpaid work can become eligible, while a late verified `PAID`
   webhook remains idempotent and can never be purged as unpaid.
2. Preserve a compact, non-PII print-forensic record before whole-order deletion
   (attempt/step outcome, Agent/printer, spool identity, timestamps, failure and
   uncertainty state), or retain/redact the existing forensic rows.
3. Mark a successfully drained recovered cleanup run terminal `COMPLETED` while
   retaining its cumulative failure/error counters, so it is excluded from the
   open/runnable index.
4. Investigate and reconcile legacy completed deadlines and invalid object-key
   failures through a separately approved, idempotent migration/repair. Do not
   weaken the owned-key guard or manually edit production rows.
5. Update stale documentation that still states one-hour PDF and five-hour PII
   retention; the active whole-order runtime is two hours.

Until those are reviewed and implemented, the combined unpaid + completed +
safety policy is **FAIL**, even though the basic local R2-first multi-file purge
mechanism works.
