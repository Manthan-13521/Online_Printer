# End-to-End Paid Printing

Phase 10 connects a captured Razorpay payment to the private R2 object, one
eligible Windows Agent, a deterministic print plan, and customer-safe status.
The overriding rule is: if PrintGo cannot prove whether a spool submission
occurred, it does not submit that step again automatically.

## Eligibility and claim lease

The Agent receives work only through its authenticated 30-second heartbeat. A
claim candidate must be `QUEUED`, have a verified `PAID` payment with provider
payment ID, retain an `UPLOADED` PDF, and match an enabled `ONLINE` printer whose
reported capabilities satisfy the frozen paper, colour, and duplex settings.
The Agent must be active and fresh.

Claiming uses a conditional D1 update and one D1 batch that creates the
`print_attempts` row, all print-plan steps, and claim event. A two-minute lease
names the owning Agent, exact printer, and random claim nonce. Only that
authenticated Agent plus the live nonce can mutate a step. Heartbeats and step
updates renew the lease; another Agent cannot steal it.

An expired claim is automatically recoverable only while every persisted step
is still `PENDING`. If any step reached `SUBMISSION_STARTED`, `SUBMITTED`, or
`BLOCKED`, expiry changes the outcome to `ADMIN_ACTION_REQUIRED`/`UNCERTAIN`
instead of requeueing it.

## Private R2 and local PDF lifecycle

The Worker signs a five-minute, GET-only R2 URL only after returning a job to
its legitimate claim holder. The bucket stays private and the Agent receives no
R2 access key, secret, object-list permission, Razorpay secret, customer
tracking token, draft token, or Admin session.

The Agent streams the object to a mode-`0600`, cryptographically random `.pdf`
inside a mode-`0700` temporary directory. It enforces the verified maximum and
exact byte size, `%PDF-` header, `%%EOF` marker, source page-count bound, and
normalized page range. The deterministic SumatraPDF submission is the final
openability check. Customer filenames are never used as paths. Local bytes are
deleted after submission handling; a blocked Windows spool job already owns
its spool data and is reconciled by ID, so the source file is not resubmitted.

## Attempts, steps, and physical idempotency

One active `print_attempts` row is permitted per order. Its
`print_attempt_steps` rows persist the exact plan:

- off: `CUSTOMER_DOCUMENT`
- first: `IDENTIFICATION_SHEET`, then `CUSTOMER_DOCUMENT`
- last: `CUSTOMER_DOCUMENT`, then `IDENTIFICATION_SHEET`

The ID sheet always uses A4, black and white, single-sided, one copy, page 1.
Customer copies apply only to the customer document. Each step crosses a
server-persisted `SUBMISSION_STARTED` boundary before the Windows side effect,
then records the correlated spool ID as `SUBMITTED`. Repeated HTTP messages are
conditional and idempotent. A different spool ID is rejected.

The Agent also writes a restricted local journal containing only order,
attempt, step, and spool identifiers—never credentials. After restart it:

- observes the saved/current spool ID without resubmitting;
- reports `UNCERTAIN` if submission had started but no safe spool identity
  survived; and
- executes normally only when the server still says the step is `PENDING`.

`BLOCKED` preserves and re-observes the same spool job. Proven failure becomes
`PRINT_FAILED`. Ambiguous correlation, lost post-submission state, or an expired
post-submission lease becomes `ADMIN_ACTION_REQUIRED`. Phase 10 has no automatic
or Admin retry action; recovery belongs to Phase 11.

## Completion and retention

The order remains active until every required step is `SUCCEEDED`. The Worker
then records `PRINTED` and `COMPLETED`, marks the attempt successful, and sets
`uploads.retention_reason = COMPLETED` with `delete_after_ms` exactly 1 hour
after the server completion timestamp. Phase 10 does not physically delete the
R2 object; the scheduled sweeper remains Phase 12. Customer PII is purged permanently
after 5 hours.

Customer tracking maps operational states to safe wording and never exposes
claims, spool IDs, Agents, Windows errors, or R2 details. The authenticated
Admin Live Orders page shows a bounded operational list with job, customer,
paid summary, assignment, status, safe issue text, and timestamps. It provides
no retry button.

## Verification boundary

Automated tests cover payment/upload/capability eligibility, competing Agents,
lease recovery, uncertain expiry, `FIRST`/`LAST`/off planning, one ID sheet with
many customer copies, private signing, bounded PDF validation and cleanup,
exact settings, restart reconciliation, same-spool blocked behavior, duplicate
messages, completion, exact +1-hour PDF retention, and +5-hour PII purge. Real Cloudflare R2,
Razorpay capture, Windows, SumatraPDF, a target driver, the physical printer,
paper-out/jam recovery, and actual page output remain hardware/environment
acceptance work and are not claimed by local tests.
