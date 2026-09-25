# PrintGo V2 — Technical Architecture

**Status:** Finalized initial architecture  
**Audience:** Developer and future AI coding agents  
**Scope:** Single-shop deployment

---

# 1. Architecture goals

The architecture must be:

- inexpensive for approximately 1,000–1,300 jobs/month
- simple to deploy per shop
- isolated per shop
- secure enough for public PDF uploads and payments
- resilient to printer/offline failures
- easy to understand and maintain
- compatible with a one-time-sale business model
- free-tier-conscious without depending on "free forever"

---

# 2. Production components

## 2.1 Cloudflare Pages

Purpose:

- hosts the React/Vite customer interface
- hosts the React/Vite admin interface
- serves static assets
- supports PWA installation

Pages must not contain secrets.

---

## 2.2 Cloudflare Worker

The Worker is the trusted backend.

Responsibilities include:

- admin authentication/session handling
- shop configuration
- upload authorization
- validation of upload rules
- server-side price calculation
- payment order creation
- Razorpay signature/webhook verification
- job creation
- job state transitions
- customer tracking access
- agent authentication/pairing
- agent heartbeat
- job claiming
- failure/status reporting
- signed R2 access
- PDF deletion orchestration
- admin APIs
- security-sensitive operations

The browser must never be trusted to decide:

- final price
- whether payment succeeded
- whether a job is paid
- arbitrary job state
- R2 object identity
- admin authorization

---

## 2.3 Cloudflare D1

D1 stores structured metadata.

Suggested initial tables:

- `shops`
- `admins`
- `admin_sessions`
- `settings`
- `pricing_rules`
- `printers`
- `agents`
- `orders`
- `order_events`
- `payments`
- `uploads`
- `agent_pair_codes`
- `audit_logs`

The schema can be normalized differently if implementation proves simpler, but the separation of responsibilities must remain clear.

D1 stores **metadata only**.

Never store PDF bytes in D1.

Important indexes should include appropriate combinations of:

- order code
- status
- created time
- payment status
- customer phone
- deletion deadline
- agent/printer identifiers

Do not repeatedly scan the full orders table.

Use pagination and indexed queries.

---

## 2.4 Cloudflare R2

R2 stores temporary PDF objects only.

Example object structure:

```text
uploads/{yyyy}/{mm}/{orderId}/{randomObjectId}.pdf
```

Rules:

- bucket is private
- browser does not receive permanent public object URLs
- object names do not use the customer's original filename
- original filename can exist as metadata in D1
- temporary signed authorization is used for upload/download
- Windows Agent receives short-lived authorized download access
- files must follow deletion deadlines

---

## 2.5 Razorpay

Every shop uses its own Razorpay account.

Flow:

```text
Customer
   |
   v
Shop's Razorpay checkout/account
   |
   v
Shop's settlement/bank account
```

PrintGo does not become the payment intermediary for all shops.

The Worker holds the shop's Razorpay server credentials as secrets.

Never expose Razorpay secrets in React.

A browser callback that says "payment successful" is not sufficient.

Payment must be verified through the backend using the appropriate Razorpay signature/server mechanism.

Webhook processing must be idempotent.

A duplicate payment notification must not create a duplicate print job.

---

# 3. Windows PrintGo Agent

The Agent runs on the shop's Windows computer.

Responsibilities:

- start automatically with Windows
- securely pair to the shop
- authenticate every backend request
- discover/configure Windows printers
- report printer and agent heartbeat
- report printer condition when available
- claim one print job atomically
- download the authorized PDF from R2
- create the PrintGo Job Identification Sheet locally
- submit/monitor print jobs
- distinguish blocked spool jobs from genuinely failed jobs
- report job status and error reason
- delete local temporary PDFs after they are no longer needed
- allow controlled retry/manual-fallback workflow

The Agent must isolate printing behind a printer adapter/interface.

Business logic should not depend directly on one specific PDF-print library.

This allows the print engine to be replaced later without redesigning payment/order logic.

---

# 4. Online Printing switch

Admin setting:

```text
onlinePrintingEnabled = true | false
```

When false:

- customer web app shows "Online printing is currently unavailable"
- Worker refuses new upload authorization
- Worker refuses new payment creation
- existing already-paid jobs continue processing
- admin can still access the dashboard/history

The restriction must be enforced by the Worker, not only by hiding frontend buttons.

---

# 5. Printer availability gate

Before accepting a new paid print job, the backend should require:

- online printing enabled
- active paired agent
- sufficiently fresh heartbeat
- configured target printer
- printer not known to be unavailable
- printer supports the selected required capability, where capability detection is reliable

The customer interface should present a friendly unavailable message rather than exposing technical errors.

There is always a race condition where a printer can fail immediately after payment.

The system therefore also requires safe paid-job recovery.

---

# 6. Customer upload flow

Preferred flow:

```text
Customer selects PDF
        |
        v
Browser checks:
- PDF extension/type
- configured maximum size
        |
        v
Worker checks:
- online printing enabled
- agent/printer availability
- upload policy
        |
        v
Worker creates short-lived upload authorization
        |
        v
Browser uploads directly to R2
        |
        v
Worker verifies/finalizes upload metadata
        |
        v
Order enters PAYMENT_PENDING
```

The PDF should not be proxied through the Worker.

After upload, server-side metadata should be used to confirm the stored object's actual size.

---

# 7. File-size service charge

The admin configures service charges by file-size band:

```text
<= 2 MB
> 2 MB and <= 5 MB
> 5 MB and <= 10 MB
> 10 MB and <= 25 MB
```

The rupee amount for every band is configurable.

The shop also configures `maxPdfSizeMb`.

If the maximum is 10 MB, the >10–25 MB pricing tier is effectively unused.

Final service charge must be based on trusted server/storage metadata, not a number supplied by the browser.

---

# 8. Oversized PDF behavior

If a selected file exceeds the configured limit:

- do not authorize the upload
- show a simple error
- show the configured maximum size
- suggest compressing the PDF
- provide a link to `https://www.ilovepdf.com/compress_pdf`
- clearly state that iLovePDF is an external third-party website

PrintGo must never automatically upload a customer's document to iLovePDF.

---

# 9. Server-side price calculation

Customer selections may include:

- page range
- copies
- B&W / colour
- paper size
- single/double-sided
- applicable service/file-size charge

The browser displays an estimate returned from the backend.

The final payable amount must be calculated by the Worker using D1 pricing rules.

Never accept:

```text
finalPrice = browserSuppliedValue
```

as authoritative.

The exact pricing formula should be versioned/tested.

---

# 10. Payment flow

```text
UPLOADED
   |
   v
PAYMENT_PENDING
   |
   v
Worker creates Razorpay order
   |
   v
Customer pays
   |
   v
Razorpay result/webhook
   |
   v
Worker verifies authenticity
   |
   v
PAID
   |
   v
QUEUED
```

A verified payment must be tied to:

- one PrintGo order
- exact expected amount
- currency
- shop

Never queue printing merely because the browser says payment succeeded.

---

# 11. Job code and tracking

After verified successful payment, the customer receives a human-friendly job code such as:

```text
PG-8F42K7
```

The customer also receives a private tracking link/token.

Do not use a guessable job code alone as authorization to reveal private information.

Do not expose raw database IDs.

---

# 12. Job Identification Sheet

One extra identification sheet is generated **locally by the Windows Agent** for each order.

It is not uploaded to R2.

It is not another permanent stored document.

Suggested information:

- PrintGo job code
- customer name
- masked phone number
- page/copy summary
- B&W/colour
- paper size
- simplex/duplex
- amount paid
- optional short instruction
- submitted time

Example:

```text
PRINTGO
JOB: PG-8F42K7

Customer: Rahul Kumar
Phone: ******4321

Pages: 18
Copies: 2
Print: B&W
Paper: A4
Sides: Double-sided

Amount Paid: Rs. 42

Instruction:
Staple after printing
```

Privacy rule:

- do not print the full customer phone number unless requirements change

The admin configures:

```text
identificationSheetEnabled = true | false
identificationSheetPlacement = FIRST | LAST
```

During installation, a test print determines which placement makes the sheet visible on top of the printer's finished stack.

Only **one identification sheet per order**, even when the customer requests many copies.

---

# 13. Job state machine

Initial controlled states:

```text
CREATED
UPLOADING
UPLOADED
PAYMENT_PENDING
PAYMENT_FAILED
PAYMENT_CANCELLED
PAID
QUEUED
CLAIMED
SPOOLING
PRINTING
PRINT_BLOCKED
PRINT_FAILED
ADMIN_ACTION_REQUIRED
PRINTED
COMPLETED
FILE_EXPIRED
CANCELLED
```

Not every state must become a separate database value if implementation can safely combine some, but transitions must remain controlled.

Arbitrary API requests must never directly set any status.

---

# 14. Atomic job claiming

Only one Agent may claim an eligible queued job.

Conceptually:

```text
QUEUED -> CLAIMED
```

must be atomic.

If two Agent requests race, only one can succeed.

This prevents duplicate printing.

---

# 15. Printer errors and blocked jobs

The Agent should report the most specific reliable Windows/printer state available, such as:

- paper out
- paper jam
- printer offline
- toner/ink issue
- door open
- user intervention
- printer error
- unknown error

Not all printer drivers provide perfect status detail.

If Windows only exposes a generic error, the UI should display a generic error rather than inventing a specific cause.

---

# 16. Safe retry rule

A critical rule:

> **A blocked Windows spool job must not automatically be submitted as a brand-new duplicate print job.**

Example:

```text
PRINTING
   |
paper jam
   |
   v
PRINT_BLOCKED
```

The original Windows spool job may still exist.

When the jam is fixed, it may continue.

Submitting another copy blindly could cause duplicate output.

Automatic retry is permitted only when the system has reasonable evidence that the prior print job genuinely failed and is no longer pending in the spooler.

Suggested policy:

- blocked printer/spooler condition -> wait/admin visibility, no duplicate submission
- confirmed print-job failure -> one controlled retry
- second confirmed failure -> `ADMIN_ACTION_REQUIRED`

Admin actions:

- Retry
- Download PDF
- Print Manually

---

# 17. PDF retention/deletion rules

## Unpaid upload

```text
Uploaded but not paid
-> delete at 10 minutes
```

## Payment failed/cancelled

```text
Payment failed/cancelled
-> delete within 30 minutes
```

## Completed print

```text
COMPLETED
-> keep PDF for 12 hours
-> delete from R2
-> keep metadata/history
```

## Paid but unresolved failure

```text
PAID + unresolved printing failure
-> retain for admin recovery
-> maximum retention: 24 hours
-> then delete PDF
-> keep metadata/history
```

These are authorization deadlines as well as cleanup deadlines.

After an object is considered expired, application APIs must refuse access even if physical cleanup is a little later.

---

# 18. Cleanup worker

A scheduled Worker/Cron process should:

- find R2 objects whose deletion deadline has passed
- delete them
- mark storage state/deletion outcome in D1
- retry failed deletions
- log failure rather than silently forgetting it

Race protection is required around payment verification so a customer cannot complete payment exactly when an unpaid-cleanup task is deleting the object.

---

# 19. Local file handling on Windows

Treat every uploaded PDF as untrusted.

Rules:

- save to a PrintGo-controlled temporary directory
- use a random internal filename
- never use the customer filename as an executable path
- never "double click" using arbitrary Windows file associations
- use a controlled PDF printing mechanism
- delete the local PDF after the required print/recovery window
- never execute embedded content/scripts from the document

---

# 20. Authentication domains

## Customer

No permanent account.

Uses:

- job code for human recognition
- private tracking token/link for access

## Admin

Single admin account in the initial version.

Needs:

- secure password hashing
- secure session
- HTTP-only secure cookie where practical
- logout
- password change
- session invalidation

No Owner/Staff role system in V1.

## Agent

Uses:

- agent ID
- strong random secret/token
- short-lived pairing code during setup

Pairing codes must:

- expire
- be one-time-use
- become invalid immediately after pairing

Local agent secrets should use Windows secure storage where practical.

---

# 21. Secrets

Never commit:

- Razorpay key secret
- session signing keys
- agent master secrets
- Cloudflare secret values
- production credentials

Use:

- Cloudflare Worker Secrets
- `.env.local` for development
- `.gitignore`

Frontend receives public configuration only.

---

# 22. Free-tier-conscious rules

The target workload is small, but inefficient code can still waste quotas.

Do:

- direct browser -> R2 upload
- indexed D1 queries
- cursor/limited pagination
- small admin history pages
- sensible Agent heartbeat intervals
- immediate heartbeat on reconnect
- reduce polling while idle
- combine status/heartbeat work where appropriate
- R2 for PDF bytes
- D1 for metadata

Do not:

- query all order history every few seconds
- poll the backend every second forever
- proxy multi-megabyte PDFs through the Worker
- store PDFs in D1
- keep old PDFs permanently
- regenerate duplicate paid jobs from duplicate webhooks

---

# 23. Deployment ownership

Per shop:

```text
Shop Cloudflare
- Pages
- Worker
- D1
- R2
- Worker secrets

Shop Razorpay
- keys
- KYC
- bank account
- settlement

Shop Windows PC
- PrintGo Agent
- configured printer
```

Developer/vendor:

```text
Private GitHub repository
Master source code
Development/test environment
Installer/build process
Documentation
```

This ownership boundary is part of the business model and should not be casually redesigned.
