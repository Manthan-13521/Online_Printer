# Phase 2: Recovery Foundation Report

## Overview

Phase 2 focused on building the backend and state-machine foundation for the queue recovery features designed in Phase 1.

## Completed Objectives

1. **D1 Schema Adjustments**
   - Created `0022_phase2_recovery_foundation.sql`.
   - Added `recovery_lock_id`, `recovery_locked_at_ms`, and `claims_paused` to the `installation` table to allow safe pausing of the queue.
   - Added `last_progress_at_ms` to `print_attempts` for stall detection.

2. **PREFLIGHT_DEFERRED Loops Fixed**
   - Modified `apps/agent/windows/src/paid-print-executor.ts` to bound preflight deferrals.
   - The agent now waits for a maximum of 2 consecutive offline checks (~60 seconds).
   - On the 3rd check, it reports `BLOCKED` with `PRINTER_OFFLINE` to the Cloudflare Worker instead of silently deferring indefinitely.
   - Updated `apps/agent/windows/src/paid-print-executor.test.ts` to cover the new bounded deferral logic.

3. **Safe State-Machine Foundation**
   - Modified `apps/api/worker/src/printing/repository.ts` to respect `claims_paused = 1`.
   - When paused, new orders cannot be claimed by any agent, and the cron tasks (`recoverExpiredClaims`, `autoRetryEligibleOrders`) safely skip execution.
   - Identified and handled the risk of stalled `PENDING` states: `claimOrRenew` now stops renewing leases if the step has been stuck in `PENDING` for over 90 seconds. This allows `recoverExpiredClaims` to safely return the order to `QUEUED` if the agent dies.
   - Wired `last_progress_at_ms` in `print_attempts` to be updated upon meaningful transitions (e.g. `startStep`, `recordSubmission`, `recordResult` for `PRINTING`/`BLOCKED`).

4. **Testing Infrastructure Fix**
   - Discovered that the in-memory test database was failing because of an issue with the migration array loop in vitest setup files.
   - Fixed the hardcoded `migrations` array in all 11 `*.test.ts` repository suites to properly include migrations `0019` through `0022`.
   - Ran `pnpm db:validate`, `pnpm test`, `pnpm typecheck`, and `pnpm lint`.

## Findings & Notes

- Tests explicitly cover `power/restart uncertainty` correctly mapping jobs to `UNCERTAIN` instead of blindly reprinting them, and idempotency logic preventing concurrent operations from creating duplicate attempts.
- No patches or sleep/timer hacks were added. The logic relies purely on atomic SQL queries and bounded retry state.

**Ready for Phase 3.**
