# Phase 4: Admin Queue Controls Report

## 1. Clear Waiting Queue

Implemented a safe, batch-optimized \`clearWaitingQueue\` operation.

- **Atomic Operation:** Runs exactly two statements in a single \`db.batch()\` roundtrip (one for the batch \`UPDATE\`, one to count skipped active/uncertain jobs).
- **Safety Invariant:** Explicitly restricts the \`UPDATE\` to \`status = 'QUEUED'\`, fully protecting \`CLAIMED\`, \`SPOOLING\`, \`PRINTING\`, \`PRINT_BLOCKED\`, and \`COMPLETION_UNKNOWN\` orders from being unintentionally cancelled.
- **UI Flow:** "Clear Waiting Queue" button correctly verifies Admin confirmation by requiring the user to explicitly type "CLEAR QUEUE" in the input box to avoid misclicks.

## 2. Safe Print Again (Idempotency and Protection)

Audited and refactored the \`retryOrder\` repository implementation to adhere to strict idempotency rules and block blind reprints of uncertain jobs.

- **Idempotency:** A single \`UPDATE orders SET status = 'QUEUED'\` atomic operation prevents double-clicks from spawning duplicate attempts, utilizing SQLite's \`meta.changes === 1\` check.
- **Uncertain Order Protection:** Added an explicit \`ORDER_IS_UNCERTAIN\` check to prevent retry of \`ADMIN_ACTION_REQUIRED\` and \`COMPLETION_UNKNOWN\` states. The UI has been updated to remove the "Retry Print" confirmation modal for these states and replace it with a persistent visual warning stating: _"Printing result is uncertain. Some pages may already have printed."_
- **Active Job Protection:** Added an explicit \`ORDER_ALREADY_IN_PROGRESS\` check (covering \`QUEUED\`, \`CLAIMED\`, \`SPOOLING\`, \`PRINTING\`, \`PRINT_BLOCKED\`, and \`RECOVERY_REQUIRED\`) to immediately block API requests from accidentally duplicating attempts on actively printing jobs.

## 3. Per-Order Admin Controls

Rewrote the action buttons in the \`LiveOrdersPage\` to securely match the specific order state:

- **QUEUED:** Now displays "Remove from Queue" alongside "View/Download PDF". Removal utilizes a safe, per-order \`removeFromQueue\` mutation.
- **PRINTING / CLAIMED / SPOOLING:** Dangerous retry/remove actions have been entirely removed, replacing them with a passive "Printing in progress..." indicator.
- **PRINT_BLOCKED:** Replaced dangerous buttons with a bold diagnostic warning: _"Printer fault. Clear printer error, then Recover."_
- **COMPLETION_UNKNOWN / NEEDS_ADMIN:** The dangerous retry controls are now completely removed and safely replaced with a bold, dedicated "Mark as Printed" resolution UI block for explicit physical outcome confirmation.
- **COMPLETED:** "Print Again" is securely displayed.

## 4. Cloudflare Free-Tier Optimizations

The new \`clearWaitingQueue\` function heavily optimizes Worker CPU and D1 limits. Instead of performing a read followed by an N+1 loop of individual updates, it executes a highly optimized, dual-statement SQLite \`db.batch()\` in a single API call, minimizing network latency and avoiding unnecessary hot-path full-table scans. All single-order mutations rely strictly on targeted \`WHERE\` clauses to enforce 0 extra D1 reads.
