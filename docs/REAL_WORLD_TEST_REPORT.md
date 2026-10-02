# PrintGo V2 — Real-World Manual Test Report

**Execution Date**: 2026-10-02  
**Test Mode**: Interactive Human-in-the-Loop Manual Real-World Testing  
**Current Baseline Commit**: `d114709`

---

## 1. Environment & Target Baseline

| Component              | Target URL / Address                             | Status                       |
| :--------------------- | :----------------------------------------------- | :--------------------------- |
| **Admin PWA**          | `https://printgo-admin.pages.dev`                | ✅ Online (HTTP 200)         |
| **Customer PWA**       | `https://printgo-customer.pages.dev`             | ✅ Online (HTTP 200)         |
| **API Worker**         | `https://printgo-api.printgo-worker.workers.dev` | ✅ Online (`/health` OK)     |
| **Worker Logs**        | Cloudflare `wrangler tail`                       | 🟢 Actively Streaming        |
| **Windows Agent Host** | `192.168.1.7:22` (`printgo-windows`)             | 🟢 Persistent Daemon Running |
| **Agent Logs**         | `%LOCALAPPDATA%\PrintGo\daemon.log`              | 🟢 Active 5s Polling         |

---

## 2. Test Phase Tracking

- [ ] **Phase A**: Admin Manual Testing (Settings, Pricing, Add-ons, Discounts, Priority, Identification, Branding, Fallback, Storage/Privacy, Manual Orders, UI/UX, Error & Loading states)
- [ ] **Phase B**: Customer Manual Testing (Upload, Config, Review, Payment Simulation, Tracking)
- [ ] **Phase C**: Windows Agent & Real Hardware Dispatch (Hardware spooling, thermal/laser dispatch)

---

## 3. Findings & Incident Log

| #     | Timestamp            | Scenario / Area                 | Issue Summary                                                                                                               | Root Cause                                                                                                                                                                                                        | Fix Applied                                                                                                                                  | Verification Status                 |
| :---- | :------------------- | :------------------------------ | :-------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------- |
| **1** | 2026-10-02 18:07 IST | Admin Pricing / Addons Form     | Radio buttons for "Pricing" & "Handling" rendered as giant overlapping circles covering label text                          | Global `input` rule had `width: 100%` and `min-height: 2.85rem` without excluding radio/checkbox                                                                                                                  | Scoped `input:not([type="checkbox"]):not([type="radio"])` and set fixed `1.15rem` radio sizes & alignment in `apps/web/admin/src/styles.css` | 🟡 Ready for User Retest on Staging |
| **2** | 2026-10-02 18:30 IST | Customer Payment / Verification | Order with MANUAL_PRINT add-on displayed "Payment could not be completed" on Customer PWA after successful Razorpay payment | `createAuthorization` and `listSafeTimeline` in `apps/api/worker/src/tracking/repository.ts` lacked `'MANUAL_PRINT'` and `'AWAITING_FINISHING'` in SQL `status IN (...)`, returning `TRACKING_ACCESS_UNAVAILABLE` | Added `MANUAL_PRINT`, `AWAITING_FINISHING`, and all valid post-payment statuses to tracking queries; updated customer error fallback         | 🟡 Ready for Deployment & Retest    |

---

## 4. Retest & Verification Details

### Finding 1: Radio Buttons Overlapping Text in Add-on Service Form

- **Issue**: In Safari/WebKit, opening "New Service" under Pricing & Add-on Services displayed giant blue and white circles (~48px) overlapping the text "Fixed Price", "Staff Priced", "Automatic", "Print Automatically + Finishing", and "Manual Printing Required".
- **Expected**: Standard compact radio buttons neatly aligned to the left of each text option with clean spacing.
- **Actual**: Giant circles overlapping text due to global `input` CSS rules.
- **Root Cause**: `apps/web/admin/src/styles.css` applied `width: 100%`, `min-height: 2.85rem`, and `padding: 0.7rem 0.8rem` to all `input` elements without excluding `type="radio"` or `type="checkbox"`.
- **Fix**: Scoped text-input rules with `:not([type="checkbox"]):not([type="radio"])`, added dedicated `width: 1.15rem; height: 1.15rem; flex-shrink: 0;` styling for radios and checkboxes, and improved `.radio-group` / `.radio-label` spacing.
- **Tests**: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm build` all passed (exit 0).
- **Deployment**: Deployed in commit `d114709` to `https://printgo-admin.pages.dev`.

### Finding 2: Customer PWA Verification Error on Orders with MANUAL_PRINT Add-on Service

- **Issue**: Customer completed Razorpay payment (₹1.00) for order with manual add-on ("Only images color", `MANUAL_PRINT`). The Admin Manual Orders table correctly showed the order as PAID (`PG-28GWP6` / Pickup `PA-008`), but Customer PWA displayed: _"Payment could not be completed. You have not been shown a successful print job."_
- **Expected**: Customer PWA receives verified confirmation with Job Code, Pickup Code, and transitions to tracking screen showing "Waiting for Staff".
- **Actual**: Customer PWA showed an error banner claiming payment was not completed.
- **Root Cause**: When an order has a `MANUAL_PRINT` add-on service, post-payment routing transitions the order immediately from `CREATED` -> `PAID` -> `MANUAL_PRINT`. During checkout completion, the browser calls `POST /api/customer/payments/verify`, which invokes `attachToVerifiedOrder`. In `apps/api/worker/src/tracking/repository.ts`, `createAuthorization` ran:
  ```sql
  WHERE id = ? AND tracking_token_hash IS NULL AND public_job_code IS NOT NULL
    AND status IN ('PAID', 'QUEUED', 'CLAIMED', 'SPOOLING', 'PRINTING',
      'PRINT_BLOCKED', 'PRINT_FAILED', 'ADMIN_ACTION_REQUIRED', 'PRINTED',
      'COMPLETED', 'CANCELLED')
  ```
  Because `MANUAL_PRINT` (and `AWAITING_FINISHING`) were missing from this list, the query matched 0 rows, leaving `tracking_token_hash` null. `attachToVerifiedOrder` threw `TrackingError("TRACKING_ACCESS_CONFLICT")`, which returned HTTP 409 `TRACKING_ACCESS_UNAVAILABLE`. The customer frontend lacked a specific message for this error, displaying the generic failure message.
- **Fix**:
  1. Updated `createAuthorization` and `listSafeTimeline` in `apps/api/worker/src/tracking/repository.ts` to include `'MANUAL_PRINT'`, `'AWAITING_FINISHING'`, and all other valid post-payment lifecycle statuses (`'RETRY_PENDING'`, `'NEEDS_ADMIN'`, `'COMPLETION_UNKNOWN'`).
  2. Updated `paymentErrorMessage` in `apps/web/customer/src/App.tsx` with dedicated handling for `TRACKING_ACCESS_UNAVAILABLE` and `TRACKING_ACCESS_CONFLICT`.
  3. Added unit tests in `apps/api/worker/src/tracking/repository.test.ts` to assert that `createAuthorization` and `listSafeTimeline` succeed for `MANUAL_PRINT` and `AWAITING_FINISHING`.
- **Tests**: `pnpm test` (78 suites, 655 tests passing), `pnpm typecheck` (0 errors), `pnpm lint` (0 warnings), `pnpm format:check` (clean), `pnpm db:validate` (27 tables, clean), `pnpm build` (all packages & PWAs built).
