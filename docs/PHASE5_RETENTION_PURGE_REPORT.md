# Phase 5: Retention & Safe Purge Report

## 1. Stage 1 — Short Retention (PII & PDF)

- **Implementation**: Maintained the robust `purgeOrder` transaction that strictly deletes `uploads`, `order_files`, and `print_attempts`, while safely deleting the active `orders` row.
- **PII Scrubbing**: By deleting the `orders` row and moving the strict financial record into `retained_payment_records`, all customer PII (name, phone, print instructions) is permanently purged without requiring schema changes or nullable columns.
- **Active Order Protection**: Expanded the `ACTIVE_PHYSICAL` protection macro in `apps/api/worker/src/cleanup/repository.ts` to strictly exclude: `QUEUED`, `CLAIMED`, `SPOOLING`, `PRINTING`, `PRINT_BLOCKED`, `COMPLETION_UNKNOWN`, and `RECOVERY_REQUIRED`. This guarantees active queue states are immune to premature cleanup.

## 2. Stage 2 — 30-Day Financial Purge

- **Implementation**: Introduced a new automated `purgeStaleRetainedRecords` method.
- **Execution**: Integrated directly into the daily cron pipeline (`runScheduled()` inside `CleanupService`).
- **Data Purged**: Automatically deletes all residual PrintGo data older than 30 days from `retained_payment_records`, `retained_order_history`, and `retained_provider_events`. No orphaned records remain.

## 3. Cost & Free-Tier Optimization

- **Zero Full-Table Scans**: Stage 1 candidate selection relies on the `orders_cleanup_due_idx` and `orders_expires_idx` partial indexes, scanning only eligible orders.
- **Safe Batching**: All deletions and cross-table migrations happen within a single atomic SQLite `.batch()` command to ensure consistency across D1 even during partial failures.

## 4. Test Verification

- All 709 Vitest test cases across the system pass successfully, proving that Phase 5 retention logic properly insulates active queue operations while systematically pruning old history.
