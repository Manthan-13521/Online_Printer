# Phase 6: Final Reliability Hardening Report

## Invariant Validations
1. **Never duplicate a print:** The queue controller relies on strict D1 atomic `.batch()` updates and `claim_id` unique UUID leases. A physical order cannot be claimed twice. Print Again blocks active jobs, ensuring duplicate claims are impossible.
2. **Never mark Windows spool removal as physical success:** The `WindowsPrinterAdapter` detects spool removals as `COMPLETED_OR_REMOVED`. This is now correctly mapped to `UNCERTAIN` in the executor layer and sent to the worker, ensuring the backend marks it as `COMPLETION_UNKNOWN` rather than `SUCCEEDED`. This prevents false completion records from spooler API glitches or manual cancellations.
3. **Never auto-reprint an uncertain/submitted job:** Uncertain states (`COMPLETION_UNKNOWN`, `RECOVERY_REQUIRED`) require Admin manual resolution (Recover Printing -> Mark Failed or Mark Completed). The queue processor will skip these safely.
4. **Only ONE physical order active:** Governed tightly by the 1-limit lock query in `fetchJobToPrint` and strict queue state queries.
5. **Waiting orders remain durable in D1:** Protected from cleanup by strict filtering in `repository.ts` active constraints.
6. **Printer/PC/Agent failure must never leave PRINTING/CLAIMED forever:** The `RecoveryController` and Admin UI properly detect Agent stale status (3-minute heartbeat) and stalled printing (5 minutes without progress updates). `last_progress_at_ms` is ONLY updated on genuine state transitions (e.g. from non-PRINTING to PRINTING) or when an error is resolved; it is NEVER blindly updated by the Agent's polling heartbeat. A massive 200-page job correctly preserves its original `last_progress_at_ms`. If 5 minutes pass without a meaningful state transition, the Admin UI correctly flags the job for visual verification (Recover Printing) without blindly killing or retrying it.
7. **Recovery, Clear Queue, Print Again idempotent:** All use `.batch()` SQL executions requiring current valid state boundaries to take effect.
8. **Cleanup safety:** Stage 1 purge skips all unconfirmed active jobs.

## Failure Scenarios Tested
- **Power Loss / Restarts:** Spool ID reconciliation prevents double printing. Missing jobs map to `COMPLETED_OR_REMOVED` which forces an `UNCERTAIN` state for manual verification instead of false physical success.
- **Printer Faults / Jams:** Caught accurately via the Windows spool API checking device masks. Maps cleanly to `BLOCKED`.
- **Manual Windows Cancel:** Maps to `COMPLETED_OR_REMOVED` and safely escalates to `UNCERTAIN` rather than false completion.
- **Race conditions:** D1 batches handle all state changes and UI tab races gracefully. Clear Waiting Queue strictly relies on D1 `status = 'QUEUED'`.
- **Stalls:** 5-minute threshold triggers safely because `last_progress_at_ms` only updates on true state changes, not heartbeats.
- **Late Webhook after Purge:** A webhook arriving after Stage 1 purge correctly matches the Stage 2 30-day retained record and is safely ignored as a duplicate. A webhook arriving after Stage 2 purge (complete deletion) correctly fails with a 500 error, ensuring PrintGo NEVER recreates an order, print job, or triggers a reprint.

## Cost Audit
- **Hot-Path API Calls:** Agent heartbeat is highly optimized, taking only 1 simple D1 statement. Polling loops automatically back-off.
- **D1 Rows Read/Written:** Strict indices used for queue scans.
- **Cron Queries:** Stage 2 retention scan operates strictly on a cleanup index and only purges after 30 days without expensive table scans.
- **CPU:** No redundant JSON manipulation in hot paths.
