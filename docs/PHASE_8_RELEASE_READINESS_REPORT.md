# Phase 8 — local regression, security and release-readiness audit

Base checkpoint: `c54c521` (Phase 7). This audit is local only. No deployment,
production data deletion, live payment, Windows process, or physical printer was
used. An independent Windows setup documentation commit (`e460f7a`) landed in
the shared checkout during the audit; it is not a Phase 8 application change.

## Confirmed finding and fix

- The customer quote included a server-configured priority fee and volume
  discount, but checkout repricing omitted both. Thus a previously quoted
  priority/discount order could be charged the wrong online amount and have
  its order snapshot overwritten. Checkout now recomputes printing, file
  charge, fixed add-on snapshots, current priority policy, discount, and ID
  policy on the server, then persists the complete commercial snapshot before
  creating the Razorpay order. A changed total requires customer acknowledgement.
- A competing checkout could reserve a payment between the active-payment
  check and quote update. The quote update is now conditional on no active or
  paid payment, and reservation requires the stored order total to equal the
  amount sent to Razorpay. A matching no-op quote remains reusable; commercial
  changes behind a reserved payment fail closed. SQLite repository and payment
  service regression tests cover the boundaries.

## Integrated audit

- Customer draft and multi-PDF upload use bearer-secret draft tokens, short
  signed private-R2 PUTs, Worker R2 HEAD/size verification, and server-side
  print settings/pricing. Client page counts and totals are not trusted.
  STAFF_PRICED add-ons contribute zero online; Admin pickup charges remain
  separate. The payment callback/webhook verifies HMAC, provider order,
  captured status, amount, currency, and idempotency records. Paid snapshots
  are not repriced by the checkout update.
- A verified payment assigns a pickup code and routes AUTO versus MANUAL_PRINT
  work. Priority queue, retry/pause/fallback, claim/lease checks, spool-step
  idempotency and `COMPLETION_UNKNOWN` fail-closed recovery were traced through
  the Worker, Agent, and regression suites. Completion requires every file
  printed or explicitly Admin-confirmed; POST_PRINT finishing remains open
  until staff completes it. Only actual completion starts the two-hour purge.
- Admin routes require an authenticated session and trusted Origin; Agent
  print routes require Agent credentials and claim ownership. Customer/private
  tracking needs its secret token and returns no-store responses. Public pickup
  tracking reveals only customer-safe status, never PII, filenames, PDFs,
  printer errors, or Admin data. SQL values are bound parameters; list/history
  pages are bounded and do not fetch PDF binaries. One installation/D1 is one
  shop; no runtime tenant-routing layer was introduced.
- The public pickup-code limiter is in Worker-isolate memory, so it is
  **best-effort, not a globally enforced limit**. Its Cloudflare behavior and
  any edge protection remain a deployment security gate. The R2 bucket's
  actual public-access setting, Worker secrets/origins, and production-only
  environment mode also require live verification.
- Unified cleanup handles expired unpaid uploads at ten minutes, completed
  orders at two hours, Free Printed Data, Free All Print Data, and the configured
  daily run. Failed/cancelled payments retain their configured 30-minute
  deadline. It claims bounded indexed batches, deletes stored R2 object keys
  without bucket listing, skips active spool/payment ownership, and preserves
  only retained anonymous order/payment/provider-event audit records. The
  order, its PII, filenames, print settings, jobs, tracking credentials and
  pickup code are removed on purge. Unresolved completed work is held; Free
  All intentionally covers inactive failed/manual/uncertain workload.

## Local performance regression

Reran `scripts/runtime-cost-audit.mjs` and
`scripts/phase7-query-plan-audit.mjs`. The fixed-versus-adaptive one-hour idle
sample still measures **720 → 122 Agent HTTP requests**, **804 → 205 local SQL
statements**, and **60 → 59 changed SQLite rows** per shop. Twelve empty
scheduled cleanup invocations contribute indexed probes, zero changed rows,
and zero R2 operations. The three sampled visible Admin polls total three
HTTP requests, 18 SQL statements, and zero writes; hidden-tab policy is
covered by UI tests. Priority/retry use status indexes; pickup uses a unique
code index; history uses keyset indexes; unpaid/completed due probes use due
timestamp indexes; daily cleanup traverses a bounded active-order covering
index. No new index or Agent polling change was justified. These are local
SQLite/modeled cadence measurements, **not** D1 billed rows, Cloudflare
latency, R2 network cost, or Windows timing.

## Verification

- `pnpm test`: 77 suites; 652 passed, one Windows-only skip.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm db:validate`,
  `pnpm build`: passed. Worker build was `wrangler deploy --dry-run` only.
- Focused payment tests: 25 passed across service and repository suites.
- Reran Phase 7 runtime and query-plan scripts; deterministic counts/plans
  matched the Phase 7 checkpoint. Their timing fields are not comparable
  production measurements.

## Release checklist

### READY LOCALLY

- [x] Phase 1–7 automated regression suites and Phase 8 pricing/race tests.
- [x] Type, lint, formatting, local D1 migration validation, and builds.
- [x] Server-authoritative quote/checkout consistency and active-payment
      snapshot guard in local tests.
- [x] Indexed/bounded cleanup and no-work/R2 behavior in local tests.

### MUST VERIFY ON WINDOWS / REAL PRINTER

- [ ] Paper-out, jam, offline/blocked, partial print, recovery, retry,
      pause/resume, fallback, manual finishing, and physical page/copy output.
- [ ] Spooler IDs across normal completion, Agent restart, network loss, and
      duplicate callbacks. **Dangerous acknowledgement race:** printer/spooler
      accepts the job, then the Agent loses connection or crashes **before** the
      spooler ID and state are durably persisted. Confirm the restart path never
      blindly submits another physical copy; mocks cannot prove this window safe.
- [ ] Windows DPAPI credentials, outbound-only networking, signed download,
      immediate local PDF deletion, and real process scheduling/liveness.

### MUST VERIFY AFTER CLOUDFLARE DEPLOYMENT

- [ ] Private R2 bucket/public-access setting, presigned PUT/GET behavior,
      short expiry and object-key deletion; deployed D1 migrations/index plans.
- [ ] Production secrets, allowed origins, Admin cookie/session behavior,
      `APP_ENV=production`, public tracking rate limiting across isolates/regions,
      and privacy after actual timed purge.
- [ ] Razorpay test-mode captured payment/webhook ordering and idempotency,
      then an explicitly authorized live-payment acceptance; never infer this
      from mocks. Measure deployed D1 `rows_read`/`rows_written`, Worker request
      rates, R2 operations, and Free-Tier headroom before claiming cost readiness.
