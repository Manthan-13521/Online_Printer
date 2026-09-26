# Customer PDF upload pipeline

Phase 4 ends at **Review ready**. It creates no payment, paid job, collection code,
printer claim, or cleanup schedule.

## Workflow

1. `GET /api/customer/config` returns customer-safe settings and enabled print
   combinations with `Cache-Control: no-store`.
2. The browser validates the local PDF with `pdfjs-dist`, obtains a page count
   for selection UX, and sends only small metadata to the Worker.
3. `POST /api/customer/drafts` creates an `UPLOADING` draft and returns a random
   32-byte bearer token once plus a five-minute SigV4 PUT URL.
4. The browser PUTs the PDF directly to the private R2 S3 endpoint. PDF bytes do
   not pass through the Worker.
5. `POST /api/customer/uploads/complete` uses `PDF_BUCKET` to HEAD the generated
   key and read at most 1,024 prefix bytes. Actual size, the configured maximum,
   and a `%PDF-` header are checked before `UPLOADED`.
6. `PUT /api/customer/draft/print-settings` parses the explicit page range on the
   server, loads verified size and current pricing, and returns the review.

The browser converts **All pages** to `1-N`. Browser-detected
`source_page_count` is useful metadata and a selection bound, not a charged-page
count. The server derives the unique count from `selectedPages`; the contract has
no `selectedPageCount` input.

## Draft and retention security

The raw token is kept in `sessionStorage`; D1 stores only its SHA-256 hash. Draft
operations resolve an order from that hash. An order UUID or R2 key is never
authorization. Pending drafts expire after ten minutes. Successful finalization
resets the unpaid logical deadline to `uploaded_at_ms + 10 minutes`.

Logical expiry blocks authorization, finalization, and quoting before physical
deletion. Invalid objects are deleted immediately where possible. Phase 12 owns
the scheduled physical cleanup sweep.

## R2 production configuration

Required configuration:

- bindings: `DB`, private `PDF_BUCKET`
- variables: `APP_ENV`, `ADMIN_ALLOWED_ORIGIN`, `CUSTOMER_ALLOWED_ORIGIN`,
  `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`
- Worker secrets: `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`

Keep the bucket private. Its CORS rule should allow only the exact customer
origin, `PUT`, `Content-Type` and `If-None-Match`, and optionally expose `ETag`.
Do not enable `r2.dev`, public listing, wildcard origins, browser GET, or unrelated
headers.

The signed `If-None-Match: *` makes each generated key create-only. A presigned
PUT cannot portably enforce a maximum body size, so Phase 4 combines its short
lifetime, client metadata gate, authoritative HEAD, and immediate reject/delete.
Phase 15 adds rate-limit and abuse hardening.

## Local and test setup

Run `pnpm db:setup:local`, `pnpm dev:worker`, and `pnpm dev:customer`. Vite proxies
`/api` to port 8787. A real direct upload requires an explicitly configured
development R2 bucket and S3 credentials. Unit tests cover deterministic signing
and mock storage; there is no insecure Worker upload proxy fallback.

The PWA precaches static assets only. `/api/*` navigation is excluded and runtime
caching is empty. There is no offline PDF queue or background upload sync. Raw
tokens, signed URLs, PDF bytes, and private responses must never be logged/cached.

## Later phases

- Phase 5 recalculates current pricing before creating a Razorpay order. This
  review is not a price lock.
- Phase 7 adds real Agent/printer readiness. Phase 4 claims no printer is online.
- Phase 12 performs scheduled deletion.
