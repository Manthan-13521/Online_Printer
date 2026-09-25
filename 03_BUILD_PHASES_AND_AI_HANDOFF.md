# PrintGo V2 — Build Phases and AI Handoff

**Purpose:** Keep future development sessions consistent and prevent architecture drift.

This file is intended to be read by any future AI model or developer before making major code changes.

---

# 1. Build rule

Do not build the entire product in one uncontrolled pass.

Build phase by phase.

Each phase must have:

- clear scope
- tests/acceptance criteria
- documented decisions
- no unrelated feature expansion

If a later phase exposes a real architecture problem, revise the architecture intentionally and update these documents.

Do not silently redesign core decisions inside implementation code.

## 1.1 Single-shop deployment invariant

PrintGo V2 is not multi-tenant. One production deployment equals one shop, one customer-facing site/domain, one Worker, one D1 database, one R2 environment, and one shop-owned Razorpay account. The private source code is reused for separate, isolated shop deployments.

Do not add a tenant selector, tenant routing, a shared multi-shop database or bucket, runtime shop switching, a centralized multi-shop admin portal, or `shop_id` columns solely for tenant isolation. Each deployment's records inherently belong to its one installation. Multiple Agents and printers within that shop remain allowed.

---

# 2. Phase 0 — Repository and specification freeze

Deliverables:

- monorepo/repository initialized
- linting/formatting
- TypeScript configuration
- environment strategy
- local development instructions
- architecture docs committed
- database schema design
- API contract draft
- status/state transition rules
- naming conventions
- error format
- test strategy

Suggested monorepo structure:

```text
printgo/
|
+-- apps/
|   +-- web/
|   |   +-- customer/
|   |   +-- admin/
|   |
|   +-- api/
|   |   +-- worker/
|   |
|   +-- agent/
|       +-- windows/
|
+-- packages/
|   +-- domain/
|   +-- validation/
|   +-- pricing/
|   +-- auth/
|   +-- shared/
|   +-- api-contract/
|
+-- database/
|   +-- migrations/
|   +-- seeds/
|
+-- tests/
+-- docs/
+-- scripts/
```

Acceptance:

- all applications build
- no production secrets committed
- architecture docs reflect actual chosen structure

---

# 3. Phase 1 — D1 schema and domain model

Implement:

- one-row installation/shop settings
- admin
- pricing
- printer
- agent
- order
- upload
- payment
- event/audit concepts

Define:

- primary keys
- public job code
- internal order ID
- timestamps
- deletion deadlines
- indexes
- status transition validation

Acceptance:

- migrations run from empty database
- seed/dev data works
- invalid state transitions are rejected in unit tests

---

# 4. Phase 2 — Admin authentication and basic shell

Build:

- admin login
- secure session
- logout
- password change
- basic navigation
- responsive admin shell

Do not build Owner/Staff roles.

Acceptance:

- unauthenticated admin API access blocked
- password/session flow tested
- no sensitive auth token stored insecurely in normal frontend storage

---

# 5. Phase 3 — Shop settings and pricing

Build admin UX for:

- shop identity
- online printing ON/OFF
- paper/colour/duplex availability
- page/copy pricing
- file-size service-charge bands
- maximum PDF size
- identification sheet ON/OFF
- identification sheet FIRST/LAST

Build server-side pricing package.

Acceptance:

- backend calculates price independently of browser
- pricing has unit tests for boundaries:
  - exactly 2 MB
  - just above 2 MB
  - exactly 5 MB
  - just above 5 MB
  - exactly 10 MB
  - just above 10 MB
  - configured maximum
  - oversized
- UI clearly shows saved pricing

---

# 6. Phase 4 — Customer upload experience

Build:

- customer landing page
- service availability display
- name + phone
- PDF selection
- browser-side PDF size validation
- print settings
- optional instructions
- price preview
- oversized-PDF iLovePDF link/message

Implement:

- short-lived R2 direct-upload authorization
- upload metadata finalization
- 10-minute unpaid deletion deadline

Acceptance:

- offline service cannot authorize upload
- oversized file cannot get upload authorization
- direct R2 upload works
- PDF bytes do not pass through Worker
- expired unpaid upload becomes inaccessible

---

# 7. Phase 5 — Razorpay payment

Build:

- payment order creation
- Razorpay checkout integration
- backend verification
- webhook/signature verification
- idempotency
- payment records
- payment failure/cancel handling
- 30-minute failed/cancelled file deletion deadline

After verified payment:

- generate public job code
- transition to PAID/QUEUED

Acceptance:

- fake frontend "success" cannot mark paid
- wrong amount rejected
- duplicate webhook does not duplicate job
- payment tied to correct shop/order
- failed/cancelled order follows retention rule

---

# 8. Phase 6 — Customer tracking

Build:

- private tracking token/link
- job code display
- friendly status timeline
- payment status
- print summary
- customer-safe failure wording

Acceptance:

- guessing job code alone does not reveal private order
- internal IDs never exposed unnecessarily
- tracking remains useful after PDF deletion without exposing deleted file

---

# 9. Phase 7 — Windows Agent pairing and heartbeat

Build:

- Agent packaging skeleton
- secure pairing
- one-time expiring pair code
- local secure secret storage where practical
- startup with Windows
- heartbeat
- reconnect handling
- printer discovery/configuration

Acceptance:

- unpaired Agent cannot access shop jobs
- expired pair code rejected
- used pair code rejected
- admin sees online/offline Agent state
- heartbeat expiry affects new-order availability

---

# 10. Phase 8 — Printer adapter and test printing

Create a printer abstraction such as:

```text
PrinterAdapter
- listPrinters()
- getCapabilities()
- getStatus()
- submitPdfJob()
- getJobStatus()
- cancelJob()
```

Do not spread Windows-specific print commands throughout business code.

Build:

- configured printer selection
- controlled local temp files
- basic PDF submission
- spool job tracking

Acceptance:

- test PDF prints
- one PrintGo order maps to known spool-job information
- local temp PDF cleaned
- printer adapter can be mocked in tests

---

# 11. Phase 9 — Identification Sheet

Build local identification-sheet generation.

One sheet per order.

Fields:

- job code
- name
- masked phone
- print summary
- amount
- instruction
- submitted time

Support:

- enabled/disabled
- first/last placement

Acceptance:

- 5 document copies still produce only one ID sheet
- phone is masked
- ID sheet never stored in R2
- test installation can select the placement that appears on top of output

---

# 12. Phase 10 — End-to-end printing

Implement:

```text
QUEUED
-> CLAIMED
-> SPOOLING
-> PRINTING
-> PRINTED
-> COMPLETED
```

Atomic claim required.

Acceptance:

- two simultaneous Agent claim attempts cannot print the same order twice
- already-paid job survives temporary network disconnect
- reconnect performs immediate reconciliation
- completed status recorded correctly enough for supported printer behavior

---

# 13. Phase 11 — Failure handling

Implement:

- paper out
- paper jam
- offline
- toner/ink-related state when available
- generic printer error
- user intervention
- unknown error
- blocked spool handling
- confirmed failure handling
- one controlled retry
- `ADMIN_ACTION_REQUIRED`

Admin actions:

- Retry
- Download PDF
- Print Manually

Critical acceptance:

- paper jam does not blindly submit a duplicate Windows print job
- blocked existing spool job remains distinguishable from confirmed failed job
- admin clearly sees what action to take
- failed paid job remains downloadable within retention window

---

# 14. Phase 12 — Cleanup and retention

Implement scheduled cleanup for:

- unpaid: 10 minutes
- payment failed/cancelled: 30 minutes
- completed: 12 hours
- paid unresolved failure: max 24 hours

Implement:

- access denial after logical expiry
- R2 delete
- deletion status
- retry/logging on delete failure

Acceptance:

- paid order cannot be accidentally deleted because of unpaid cleanup race
- deleted PDF has no working download URL
- order/payment history remains
- repeated cleanup execution is safe/idempotent

---

# 15. Phase 13 — Admin operational dashboard

Build polished admin:

- dashboard
- live orders
- order history
- failed jobs
- order detail
- printer page
- pricing
- reports
- shop settings
- security

Usability acceptance:

- common daily actions reachable in 1–2 clicks
- mobile/tablet view usable
- errors use plain language
- destructive actions require appropriate confirmation
- no Cloudflare/D1/R2 terminology exposed in normal shop workflow

---

# 16. Phase 14 — Reports and history

Implement efficient indexed queries for:

- today
- date range
- revenue
- orders
- completed
- failed
- pages/copies if tracked
- B&W/colour if tracked

Use pagination.

Never load all historical rows on every dashboard refresh.

---

# 17. Phase 15 — Security and abuse hardening

Review:

- public upload validation
- MIME/type handling
- file-size enforcement
- rate limiting where needed
- tracking-token entropy
- admin auth
- Agent auth
- secret handling
- payment idempotency
- R2 authorization
- state-transition authorization
- local Windows file handling
- audit logs

Test malicious/invalid inputs.

---

# 18. Phase 16 — Capacity test

Simulate a workload comfortably above:

- 1,300 jobs/month equivalent
- approximately 2 MB average PDF

Test:

- upload
- D1 query behavior
- R2 object lifecycle
- Agent polling/heartbeat
- payment callbacks in test mode
- admin history performance
- cleanup

The target is not merely "provider says free tier is large enough."

The target is:

> The application demonstrates efficient behavior under the defined shop workload.

---

# 19. Phase 17 — Shop deployment checklist

Per shop:

1. Create/use shop Cloudflare account
2. Deploy Pages
3. Deploy Worker
4. Create D1
5. Create private R2 bucket
6. Configure Worker secrets
7. Configure domain if purchased
8. Configure shop Razorpay
9. Install Windows Agent
10. Pair Agent
11. Configure/test printer
12. Test identification sheet placement
13. Test pricing
14. Test payment using permitted test/production process
15. Test successful print
16. Test paper-out/jam behavior
17. Test failed-job recovery
18. Test deletion behavior
19. Set admin password/security
20. Handover operating instructions

---

# 20. Decisions future AI models must preserve unless explicitly changed

## Architecture

- Cloudflare Pages
- Cloudflare Worker
- Cloudflare D1
- Cloudflare R2
- Razorpay per shop
- Windows PrintGo Agent
- private GitHub source
- one shop per isolated production deployment; no runtime multi-tenancy

## Business model

- one shop = isolated deployment
- one-time sale/setup model
- shop owns production accounts/data/payment relationship

## Product scope

- no customer accounts
- no Owner/Staff roles in V1
- no QR-code page
- user-friendly customer UI
- user-friendly admin portal
- online printing ON/OFF
- no upload/payment while OFF
- printer availability gate
- server-side price calculation
- server-side payment verification
- job code + private tracking link
- local identification sheet

## Retention

- unpaid: 10 min
- payment failed/cancelled: 30 min
- completed: 12 h
- paid unresolved failure: max 24 h

## Safety/reliability

- atomic claim
- do not blindly duplicate blocked spool jobs
- public PDF treated as untrusted
- no permanent PDF storage
- no frontend authority over final price/payment/status

---

# 21. How an AI coding agent should work on this project

Before coding:

1. Read all four project documents.
2. Identify the current phase.
3. Inspect existing code before proposing a redesign.
4. Preserve finalized decisions unless the user explicitly changes them.
5. Implement only the current phase plus necessary supporting work.
6. Add/update tests.
7. Update documentation if behavior changes.
8. Never silently change retention, pricing, payment or printing rules.

When uncertain:

- prefer the simpler implementation
- preserve privacy
- preserve payment correctness
- preserve print deduplication
- preserve user-friendly behavior
- avoid infrastructure that is unnecessary at the target scale

---

# 22. Definition of first sellable release

The first release is ready only when this complete path works reliably:

```text
Customer opens site
-> enters name/phone
-> selects valid PDF
-> chooses print settings
-> sees correct price
-> pays through Razorpay
-> payment is verified
-> gets job code
-> Agent claims job once
-> ID sheet is generated locally
-> PDF prints
-> status updates
-> admin can identify the output
-> customer can track
-> PDF is deleted according to policy
-> metadata remains
```

And failure recovery works for realistic cases such as:

- printer offline
- paper out
- paper jam
- failed print
- Agent reconnect
- payment callback retry
- cleanup retry

That is the baseline for a product that should be sold to a real shop.
