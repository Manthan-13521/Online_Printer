# Full security, UX, and print regression audit

Date: 2026-10-04. Scope: local repository and synthetic fixtures only. Base checkout: `main` at `6b100f3bb63b9702719ca24dbc3e3d9e501d72d1`. The checkout already contained uncommitted customer/admin UI and documentation work; this audit preserved it. No deployment, production data access, real Razorpay charge, or physical Windows print occurred.

Evidence terms: **MEASURED** means a command, local test, or browser inspection completed in this audit; **SOURCE** means current code was traced; **MODELED** is a capacity calculation; **NOT VERIFIED** means the relevant real environment or device was unavailable. A local pass is not a production pass.

# Executive Summary

**NO-GO for production.** Local regression is green after narrowly scoped fixes, but the repository still violates the stated one-hour completed-PDF retention rule: completion assigns a two-hour deadline, and the active scheduled handler does not run the separate upload/PII retention service. The new guard prevents the daily/admin Free All operation from deleting paid, nonterminal orders. The Windows Agent print and live payment/Cloudflare boundaries remain unverified in their real environments.

# Current Architecture

One deployed installation serves one physical shop. The customer and admin React PWAs call a Cloudflare Worker. D1 owns orders, prices, payments, queue state, and audit data; private R2 holds PDFs; the outbound-only Windows Agent uses DPAPI-backed credentials, signed downloads, SumatraPDF/Windows spooler integration, and durable print-step state. There is no tenant router or paid queue infrastructure in this audit's changes.

# Complete Print Flow

1. Customer creates a draft, obtains a short-lived direct R2 PUT authorization, uploads a PDF, and finalizes metadata through the Worker (`customer/service.ts`, `storage/r2-upload-signer.ts`).
2. Worker calculates the quote and reserves the commercial snapshot before creating a Razorpay order. Worker callback/webhook paths verify HMAC signatures and reconcile a paid payment before queueing (`payments/service.ts`, `payments/repository.ts`, `payments/webhook.ts`).
3. Authenticated Agent heartbeat/pulse reads eligible work; D1 claim and print-step records control ownership. A claimed Agent obtains a signed private R2 GET (`agent/repository.ts`, `printing/service.ts`).
4. Agent checks printer readiness, downloads/validates the PDF, persists a pre-submission journal boundary, submits to Windows, records the spooler ID, observes the spooler, and acknowledges the step (`paid-print-executor.ts`, `windows-printer-adapter.ts`). Missing identity after possible submission remains uncertain, not a blind retry.
5. Worker moves through printing/finishing/completion. Private and pickup-code tracking reflect Worker state; admin surfaces order and printer state. Scheduled cleanup removes eligible files/orders (`printing/repository.ts`, `customer/repository.ts`, `cleanup/service.ts`).

This is a **SOURCE** trace plus local synthetic tests, not proof that a real printer received paper or a live Razorpay webhook arrived.

# Security Boundaries

- **SOURCE / local tests:** Server-owned quote and payment verification, authenticated Agent routes, signed R2 upload/download, DPAPI fail-closed tests, and step-state/idempotency tests were inspected. The audit did not alter CORS, CSP, WAF, cookies, signing TTL, auth middleware, or provider configuration.
- **NOT VERIFIED:** Production R2 public-access setting, live Worker secrets/bindings, deployed headers/WAF, global abuse limits, native Windows DPAPI and spooler behavior, and live-provider reconciliation. A per-isolate in-memory public-tracking limiter (`customer/routes.ts`) is not a proven globally enforced rate limit.
- **Single shop:** The pasted multi-shop isolation checklist is not applicable to this architecture; access to private drafts and Agent work still requires appropriate tokens/authorization.

# Baseline Test Results

Before audit fixes: `pnpm test` **PASS** (79 files, 664 passed, 1 skipped); `pnpm typecheck` **PASS**; `pnpm lint` **PASS**; `pnpm db:validate` **PASS** against a local D1 instance; `pnpm format:check` **FAIL** (127 files, including bundled `.gemini` skill material and pre-existing checkout work). Baseline browser inspection showed a customer offline notice because no live backend was connected and an admin login page; it did not exercise upload/payment/physical print.

# Security Findings

| ID    | Severity | Finding and evidence                                                                                                                                                                                                                                                | Impact / action                                                                                                                                                                                                                                                        | Status                                          |
| ----- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| PG-01 | High     | Legacy `saveQuote` accepted `PAYMENT_PENDING` after a payment reservation and could overwrite order totals (`customer/repository.ts`).                                                                                                                              | A captured payment could disagree with the stored order and fail to print. Added a D1 conditional write that rejects CREATED/PENDING/PAID reservations and inactive cleanup state; service returns the existing 409 state error. SQLite and service regressions added. | Fixed locally; live Razorpay race NOT VERIFIED  |
| PG-02 | High     | Free All cleanup excluded active physical steps but allowed PAID queued/nonterminal rows (`cleanup/repository.ts`).                                                                                                                                                 | Automatic/admin cleanup could delete paid work before printing. Added a paid-nonterminal guard and bounded-run drain logic with SQLite tests.                                                                                                                          | Fixed locally; live D1 concurrency NOT VERIFIED |
| PG-03 | High     | `COMPLETED_RETENTION_MS` and PDF alias are two hours (`packages/domain/src/constants.ts:32-34`); completion writes that deadline (`printing/repository.ts`). Active cron calls `CleanupService.runScheduled`, not `RetentionService.runCleanup` (`index.ts:28-61`). | Stated one-hour completed-PDF retention is not met; separate 5-hour PII purge path is not scheduled, and order deletion/forensic retention are coupled.                                                                                                                | **Open; production blocker**                    |
| PG-04 | Medium   | Agent's `hasPrintWork` omitted `RETRY_PENDING` even though claim logic can select it (`agent/repository.ts`).                                                                                                                                                       | Retry work could wait behind idle polling. Added state to work hint and regression.                                                                                                                                                                                    | Fixed locally                                   |
| PG-05 | High     | Offline printer preflight reported `BLOCKED` without a spool ID; next poll treated it as `UNCERTAIN` despite no submission (`paid-print-executor.ts`).                                                                                                              | Paid work could be stranded by a false uncertainty boundary. Keep step PENDING and defer preflight 30 seconds; tests cover no report/submission and pacing.                                                                                                            | Fixed locally; physical recovery NOT VERIFIED   |
| PG-06 | Medium   | Public pickup-code tracking has a local in-memory rate limiter (`customer/routes.ts`), with no verified distributed abuse control.                                                                                                                                  | Multi-isolate enforcement cannot be inferred from a local test. Do not add a Cloudflare rule without print/payment compatibility testing.                                                                                                                              | Open; deployed configuration NOT VERIFIED       |

# Printing-Specific Security Findings

PG-04 and PG-05 are the confirmed print regressions. The fix does not resubmit work after `SUBMISSION_STARTED`, `SUBMITTED`, or `BLOCKED`; spooler IDs remain part of the recovery path. Local tests exercise adapter settings, PDF validation, claim, step acknowledgement, restart/uncertain cases, and failed-print handling. Correct physical device, driver interpretation of copies/color/duplex/page range/paper size, real spool completion, local PDF deletion timing, and restart after power loss are **NOT VERIFIED**.

# Payment Findings

PG-01 is the confirmed payment/print race. Local tests cover HMAC rejection, signed webhook idempotency, price-change confirmation, duplicate Pay-click prevention, failed/cancelled checkout, and D1 quote reservation. No real payment, provider dashboard, webhook delivery, settlement, or concurrent deployed D1 race was tested.

# Authentication / Authorization Findings

Agent bearer and admin-session routes were inspected; local auth/route tests pass. No authentication redesign was made. Unauthorized Agent PDF access is tested synthetically, but production token rotation, revoked-device propagation, session cookies in deployed browsers, and Cloudflare edge controls are **NOT VERIFIED**.

# File/PDF Findings

Direct signed PUT and private signed GET paths remain unchanged. Local PDF metadata/size/range validation and Agent download tests pass. Actual R2 bucket privacy, uploaded-byte integrity through Cloudflare, malicious-PDF behavior on Windows, and completed-PDF one-hour deletion are **NOT VERIFIED** or open as PG-03.

# Cloudflare Findings

The configured Worker cron is `*/5 * * * *` (`apps/api/worker/wrangler.jsonc:11`), but the active handler only runs the newer order cleanup and print retry service. `pnpm db:validate` used **local** Wrangler D1; `pnpm build` used Worker `--dry-run`. Neither proves deployment, R2 lifecycle configuration, free-tier headroom, or cron execution. The capacity script is **MODELED**: at 60 orders/day, 16,700 D1 writes/day; at 800, 183,200 writes/day, above its modeled 100,000-write free-tier allowance. Validate with deployed counters before capacity claims.

# Agent Findings

DPAPI code and cross-platform mocks fail closed when protection is unavailable. `pnpm build:agent:windows` on macOS created `bundle.cjs`, `sea-prep.blob`, and a staged test package, **not a Windows `.exe`**. Native DPAPI, SumatraPDF, printer compatibility, spool IDs, recovery, and actual printing remain **NOT VERIFIED**.

# Data Privacy / Retention Findings

Unpaid and failed/cancelled deadlines are configured as 10 and 30 minutes (`packages/domain/src/constants.ts:30-31`) and covered by local tests. PG-03 remains unresolved: completion's two-hour order/PDF deadline conflicts with the required one-hour PDF deletion. The 5-hour PII routine exists in `retention/service.ts` but is not called by the active cron. The newer two-hour completed-order purge may erase PII earlier in a successful cleanup, but it also deletes order/print forensic rows; it is not evidence that the 5-hour dedicated purge is operating. R2 deletion failure/backoff and real cron timing need deployed proof. PG-02 protects paid nonterminal work from broad cleanup.

# UI/UX Findings

The in-progress tracking journey previously showed a ready-style takeover during `PRINTED`/finishing and could mislabel the order code as a pickup code. It now reserves the finished screen for backend `COMPLETED`, shows the actual pickup code only when available, retains exact Worker status/recovery text, and exposes stale-network state. Tests cover private/public finishing, ready, printer issue, and terminal polling. The source had user-owned Figma UI work before the audit; changes were limited to tracking correctness and accessibility. End-to-end browser flow with a live backend is **NOT VERIFIED**.

# Accessibility Findings

Tracking now presents status text in DOM and honors reduced-motion preference for the animated journey. Local automated assertions pass; screen-reader traversal, keyboard-only full journey, contrast measurements, and high-zoom visual verification are **NOT VERIFIED**. Small text in the in-progress Figma journey warrants a dedicated contrast/type audit.

# Responsive Design Findings

**MEASURED:** In-app browser at widths 320, 375, 390, 430, 768, 1024, 1366, 1440, and 1920 px showed no horizontal overflow on customer landing and admin login; admin sign-in target was about 46 px high. Authenticated admin, upload, checkout, status journey, and ready screen at every breakpoint were **NOT VERIFIED** in a connected browser.

# Design-System / Color Consistency Findings

Current customer Figma work is green, while the inspected admin login remains blue. The supplied PrintGo design-system skill describes an older blue palette, so it was not applied over the user's current uncommitted work. Cross-app color/token consistency is **open**, not silently declared complete.

# Performance Findings

Customer build emitted a ~440.68 kB main JS bundle (136.05 kB gzip), a ~437.74 kB PDF chunk (131.10 kB gzip), and a ~1.27 MB PDF worker. Agent preflight now waits 30 seconds while offline rather than repeatedly asking for work every short active interval. Local request-budget tests pass for config and terminal tracking. Real LCP/INP, low-end devices, deployed cache behavior, and production R2/D1 quotas are **NOT VERIFIED**.

# Business-Logic / Race-Condition Findings

PG-01 quote reservation, PG-02 paid cleanup, and PG-05 false uncertain step were the principal local data/side-effect races. All were fixed with predicates or pre-submission behavior, not by weakening auth, state checks, or at-most-once print boundaries. Late payment capture after expiry and distributed concurrency require live-safe reconciliation tests before release.

# Automated Tests Added

Added or expanded SQLite/service tests for quote reservation, paid queued cleanup, retry work hints, offline preflight scheduling, private/public tracking states, and the `PRINTED` → `COMPLETED` polling budget. Existing payment/webhook, Agent, PDF, admin, and cleanup suites were rerun as part of full Vitest.

# Changes Made

- Conditional legacy quote write; paid nonterminal cleanup exclusion; retry work hint; offline preflight deferral.
- Tracking stage/status/pickup-code corrections and reduced-motion behavior in existing user UI work.
- Narrow regression tests. No migration, deployment, auth/signing/CORS/WAF change, real data write, or live payment.

# Changes NOT Made and Why

- Did not change the two-hour constant alone: it currently governs both PDF and order/forensic deletion. Meeting one-hour PDF deletion safely requires separating the PDF lifecycle from order/step retention, wiring the active cron, and testing R2 failure/retry behavior.
- Did not add a global rate limiter or edge rule: the chosen free-tier mechanism and compatibility effect on customer upload, Agent polling, signed PDF retrieval, and webhooks need a separate staged test.
- Did not reformat unrelated/user files, bulk-update dependencies, or alter the existing green/blue design decisions. Full format debt predates these fixes.

# Remaining Risks

1. One-hour PDF deletion and active PII lifecycle are not satisfied/proven (PG-03).
2. Physical Windows printing, spool recovery, and native executable are unverified.
3. Live Razorpay/R2/D1/Cloudflare concurrency, bucket privacy, and cron behavior are unverified.
4. Global public-tracking abuse resistance is unverified (PG-06).
5. Full authenticated UI accessibility/responsiveness and cross-app design consistency are incomplete.

# Production Recommendations

Keep deployment gated. In a separate retention change, split PDF deletion from order/print-forensic retention, schedule bounded PDF/PII cleanup, and prove R2 failure/retry/idempotency with local D1 then staging. On Windows, run the native package with a real supported printer and power-loss/restart/spool-ID cases. In staging, run signed webhook replay, claim authorization, private R2 access, cleanup races, and browser status/checkout journeys without charging a real customer. Review deployed counters and safe abuse controls before increasing traffic.

# Final Regression Results

| Check                        | Result                                                          | Scope                                                                              |
| ---------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Targeted changed-path Vitest | PASS: 8 files, 72 tests                                         | Synthetic/local                                                                    |
| Full `pnpm test`             | PASS: 80 files, 677 passed, 1 skipped                           | Synthetic/local                                                                    |
| `pnpm typecheck`             | PASS                                                            | Repository                                                                         |
| `pnpm lint`                  | PASS                                                            | Repository                                                                         |
| `pnpm format:check`          | FAIL: 122 files; baseline was 127                               | Bundled skill files and prior checkout work included; changed audit code formatted |
| `pnpm db:validate`           | PASS                                                            | Local D1 only                                                                      |
| `pnpm build`                 | PASS                                                            | Worker dry-run, web and TS builds                                                  |
| `pnpm build:agent:windows`   | PASS staging; native `.exe` NOT VERIFIED                        | macOS host                                                                         |
| Capacity script              | PASS execution, MODELED output                                  | Not deployed usage                                                                 |
| In-app browser               | PASS no overflow on customer landing/admin login at nine widths | Other states NOT VERIFIED                                                          |
| `git diff --check`           | PASS                                                            | Current worktree                                                                   |

# FINAL GO / NO-GO

**NO-GO.** In the mandatory binary release rubric below, **FAIL** also means the end-to-end production claim is not proven; it does not mean every local test failed. The separate notes identify actual open defects versus missing environmental proof.

PRINTGO SECURITY AUDIT: FAIL  
PRINT FLOW: FAIL (local simulation passes; physical path NOT VERIFIED)  
PAYMENT FLOW: FAIL (local tests pass; live provider NOT VERIFIED)  
AGENT AUTHORIZATION: FAIL (local tests pass; deployed/native behavior NOT VERIFIED)  
DUPLICATE PRINT PROTECTION: FAIL (local tests pass; physical restart NOT VERIFIED)  
PDF SECURITY: FAIL (one-hour retention conflict; live R2 NOT VERIFIED)  
CUSTOMER DATA ISOLATION: FAIL (local access tests pass; deployed boundary NOT VERIFIED)  
RETENTION / CLEANUP: FAIL (PG-03 open)  
ADMIN UX: FAIL (authenticated browser path NOT VERIFIED)  
CUSTOMER UX: FAIL (local tracking tests pass; connected browser path NOT VERIFIED)  
RESPONSIVE UI: FAIL (landing/login pass; all workflow states NOT VERIFIED)  
ACCESSIBILITY: FAIL (partial improvements; full audit NOT VERIFIED)  
DESIGN CONSISTENCY: FAIL (customer/admin mismatch)  
COLOR SYSTEM: FAIL (green customer / blue admin)  
PERFORMANCE: FAIL (build and model only; live measurements NOT VERIFIED)  
PRODUCTION READY: NO

CRITICAL ISSUES: None confirmed in local source/fixtures.  
HIGH ISSUES: PG-01, PG-02, PG-03, PG-05; PG-01/02/05 fixed locally, PG-03 open.  
MEDIUM ISSUES: PG-04 fixed locally; PG-06 open.  
LOW ISSUES: Repository-wide format debt and cross-app visual inconsistency.

SECURITY FIXES IMPLEMENTED: Payment quote reservation guard; paid nonterminal cleanup guard; pre-submission offline printer deferral; retry work visibility.  
REGRESSIONS FOUND: Outdated request-budget tests assumed `PRINTED` was terminal; updated to `COMPLETED`.  
PRINT-FLOW REGRESSIONS: Paid quote mutation, paid cleanup deletion, retry work hint, and false uncertain offline preflight found and fixed locally.  
UI/UX ISSUES FOUND: Premature ready display, misleading pickup-code label, missing exact printer-issue text, reduced-motion gap, and inconsistent customer/admin palette.  
TESTS ADDED: Quote, cleanup, Agent preflight/scheduling/work hint, public/private tracking, and polling-budget regressions.

TOP 5 REMAINING RISKS: (1) retention policy violation; (2) physical Windows print/recovery; (3) live payment/R2/D1/cron behavior; (4) global abuse resistance; (5) full UI/accessibility/design verification.
