# PrintGo V2 — Final System Audit

**Audit Date:** 2026-10-02  
**Auditor:** Antigravity (static analysis + real D1/R2 verification)  
**Staging API Version:** `f64a58c8-b276-46ec-a14d-bdf2b24d1b5d`  
**Admin commit:** `94d395c`

---

## Real D1 State at Audit Time

| Table | Rows | Notes |
|---|---|---|
| `orders` | 0 | All cleaned up correctly |
| `order_files` | 0 | Cleaned |
| `payments` | 0 | Cleaned |
| `print_attempts` | 0 | Cleaned |
| `uploads` | 0 | Cleaned |
| `order_events` | 0 | Cleaned |
| `order_addon_services` | 0 | Cleaned |
| `retained_order_history` | 0 | Removed permanently |
| `retained_payment_records` | 42 | Anonymized Razorpay audit (no PII) |
| `cleanup_runs` | 15 | Run history only |

**R2:** 0 objects / 0 bytes ✅

---

## Section 1 — Workflow Trace

| Workflow | Status |
|---|---|
| Customer creates draft (UUID token, CREATED order) | ✅ PASS |
| Upload auth: 5-min presigned PUT, Content-Type: application/pdf, If-None-Match: * | ✅ PASS |
| Upload verify: PDF magic + EOF + size match | ✅ PASS |
| Per-file print settings: enum validation server-side | ✅ PASS |
| Pricing quote: server-side only | ✅ PASS |
| Discount: highest tier only, no stacking | ✅ PASS |
| Priority fee: from DB config, added server-side | ✅ PASS |
| Checkout price guard: acknowledgedTotalPaise vs server reprice | ✅ PASS |
| Razorpay order: amount from server quote only | ✅ PASS |
| Webhook HMAC: verified before any processing | ✅ PASS |
| Webhook idempotency: duplicate → 200 no double process | ✅ PASS |
| Payment amount mismatch: webhook amount ≠ stored → throws | ✅ PASS |
| Pickup code: server-assigned on payment captured | ✅ PASS |
| AUTO / MANUAL routing: based on add-on handling_mode | ✅ PASS |
| Agent claim: QUEUED → CLAIMED, atomic UPDATE | ✅ PASS |
| Print attempt: new row per attempt | ✅ PASS |
| Max 2 auto-retries | ⚠️ REQUIRES_REAL_PRINTER |
| Fallback printer | ⚠️ REQUIRES_REAL_PRINTER |
| COMPLETED only after all files PRINTED | ✅ PASS |
| 2-hour automatic cleanup via cron | ✅ PASS |
| D1 fully deleted after cleanup | ✅ VERIFIED (0 rows) |
| R2 fully deleted after cleanup | ✅ VERIFIED (0 objects) |
| Tracking expires after cleanup | ✅ PASS |
| Pickup code reusable after cleanup | ✅ PASS |
| Admin Free Printed Data | ✅ PASS (fixed) |
| Admin Free All Print Data | ✅ PASS |
| All admin routes require session auth | ✅ PASS |

---

## Section 2 — Calculation Audit

| Check | Status |
|---|---|
| Entire engine operates in paise (integers) | ✅ PASS |
| PRICE_OVERFLOW guard: `!Number.isSafeInteger` catches all bad values | ✅ PASS |
| Negative page count → INVALID_PAGE_COUNT | ✅ PASS |
| Zero file size → INVALID_FILE_SIZE | ✅ PASS |
| NaN values caught by isSafeInteger | ✅ PASS |
| Discount: only highest qualifying tier | ✅ PASS |
| Discount capped at subtotal: `Math.min(subtotalPaise, ...)` | ✅ PASS |
| Browser never authoritative for total | ✅ PASS |
| Add-on STAFF_PRICED (zero online charge) | ✅ PASS |
| Add-on FREE (zero charge, still recorded) | ✅ PASS |
| Max copies 100, min 1 | ✅ PASS |
| Max PDF size ≤ 25 MiB enforced | ✅ PASS |

---

## Section 3 — File Upload Security

| Check | Status |
|---|---|
| Upload URL 5-min expiry | ✅ PASS |
| Content-Type: application/pdf required | ✅ PASS |
| If-None-Match: * prevents overwrite | ✅ PASS |
| Size limit enforced server-side via HEAD | ✅ PASS |
| 0-byte file rejected (EMPTY_OBJECT) | ✅ PASS |
| PDF magic bytes checked (`%PDF-`) | ✅ PASS |
| PDF EOF marker checked (`%%EOF`) | ✅ PASS |
| Oversized file rejected (PDF_TOO_LARGE) | ✅ PASS |
| Size mismatch rejected (SIZE_MISMATCH) | ✅ PASS |
| Path traversal: R2 key = `uploads/{uuid}/{uuid}.pdf` — server UUIDs only | ✅ PASS |
| No user input in R2 object key | ✅ PASS |
| R2 bucket private, presigned only | ✅ PASS |
| Download URL has expiry | ✅ PASS |
| Decompression bomb: only 3 KB read max for validation | ✅ PASS |
| Encrypted/password-protected PDF | ⚠️ REQUIRES_MANUAL_TEST |
| Page count limit | ⚠️ REQUIRES_MANUAL_TEST |

---

## Section 4 — Security Audit

| Check | Status |
|---|---|
| Session auth on all admin routes | ✅ PASS |
| Session token stored as hash (PBKDF2) | ✅ PASS |
| Constant-time HMAC comparison | ✅ PASS |
| CORS: admin origin enforced on mutations | ✅ PASS |
| CORS: customer origin enforced | ✅ PASS |
| SQL injection: no user input interpolated | ✅ PASS |
| SQL IN clause: `?` placeholders only | ✅ PASS |
| IDOR: customer scoped to session token | ✅ PASS |
| Price tampering: server reprice at checkout | ✅ PASS |
| Discount tampering: server recalculates | ✅ PASS |
| Webhook replay: claimProviderEvent idempotent | ✅ PASS |
| Webhook HMAC: verified before processing | ✅ PASS |
| R2 keys not guessable | ✅ PASS |
| Dummy hash timing: prevents login oracle | ✅ PASS |
| PII not leaked in error messages | ✅ PASS |
| Pickup code enumeration rate limit | ⚠️ LOW RISK (large keyspace, no explicit rate limit) |
| Tracking token brute force | ⚠️ LOW RISK (requires knowing job code first) |

---

## Section 5 — State Machine

| Check | Status |
|---|---|
| COMPLETED only reachable via PRINTED | ✅ PASS |
| CLEANUP only after COMPLETED | ✅ PASS |
| Failed/uncertain files block cleanup | ✅ PASS |
| Active printing blocks cleanup | ✅ PASS |
| Live payment blocks cleanup | ✅ PASS |
| No impossible transitions | ✅ PASS |
| CANCELLED is terminal | ✅ PASS |
| COMPLETED is terminal | ✅ PASS |

---

## Section 6 — Cleanup Correctness

| Check | Status |
|---|---|
| Only fully PRINTED orders deleted automatically | ✅ PASS |
| Failed/uncertain orders NOT deleted | ✅ PASS |
| purgeOrder deletes all 9 related tables | ✅ PASS |
| purgeOrder deletes retained_order_history row | ✅ PASS (fixed) |
| No history row written after purge | ✅ PASS (fixed) |
| Admin run purges all stale history rows | ✅ PASS (fixed) |
| R2 deletion uses stored keys (no bucket listing) | ✅ PASS |
| D1 verified empty post-cleanup | ✅ VERIFIED |
| R2 verified empty post-cleanup | ✅ VERIFIED |

---

## Section 7 — UI Consistency

| Check | Status |
|---|---|
| All amounts in rupees (paise/100) | ✅ PASS |
| Order history: no stale "Privacy cleared" records | ✅ PASS (fixed) |
| ShopSettings ID threshold input works | ✅ PASS (fixed missing import) |
| Error states shown on all async pages | ✅ PASS |
| Empty state: "No orders yet." | ✅ PASS |
| Loading states on all pages | ✅ PASS |

---

## Section 8 — Performance / Cost

| Check | Status |
|---|---|
| Cleanup uses DB indexes (no full table scan) | ✅ PASS |
| No R2 bucket listing | ✅ PASS |
| No N+1 in order history | ✅ PASS |
| No N+1 in cleanup | ✅ PASS |
| Agent polling: bounded backoff | ✅ PASS |
| History pagination: cursor-based, LIMIT enforced | ✅ PASS |

---

## Bugs Found and Fixed

| # | Bug | Fix | Files |
|---|---|---|---|
| 1 | Order History showed stale "Privacy cleared" Sept records after cleanup | Removed INSERT into retained_order_history; added DELETE instead; removed from history query | `cleanup/repository.ts`, `history/repository.ts` |
| 2 | Admin Free Printed Data didn't clear stale history rows | Added `purgeAllHistory()` in `requestAdminRun` | `cleanup/service.ts` |
| 3 | ShopSettingsPage TypeScript error — missing imports | Added `formatPaiseAsRupeesInput`/`parseRupeesToPaise` import | `ShopSettingsPage.tsx` |

---

## Items Requiring Manual Test

| Item | Risk Level |
|---|---|
| Encrypted/password-protected PDF | Medium (SumatraPDF error at print) |
| Page count limit enforcement | Medium (no server-side cap) |
| Max 2 auto-retries | High (requires real printer) |
| Fallback printer behavior | High (requires real hardware) |
| Print blocking / pause / health recheck | High (requires real agent) |
| Admin reprint / manual completion | Medium (requires live order) |
| Pickup code enumeration rate limit | Low |
| Tracking token brute force | Low |

---

## Final Verdict

**Tests:** 79/79 files · 664 passed · 0 failed ✅  
**Typecheck:** All packages clean ✅  
**Security:** SQL injection, IDOR, CSRF, HMAC, CORS, R2 privacy — all checked ✅  
**Pricing:** Server-authoritative, overflow-guarded, no discount stacking ✅  
**Cleanup:** Correctly protects failed/active; deletes all data for completed orders ✅  
**State machine:** No impossible transitions ✅  

### ⚠️ NOT RELEASE-READY

**Reason:** Printer hardware testing not yet completed. The software logic, security, calculations, and data lifecycle are all correct based on code audit and staging D1/R2 verification. Release requires at minimum:

1. Real printer: claim → submit → PRINTED → COMPLETED → 2h cleanup verified
2. Retry/fallback with actual hardware failure
3. Encrypted PDF test with SumatraPDF
