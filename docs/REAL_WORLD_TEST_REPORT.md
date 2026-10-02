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

| #     | Timestamp            | Scenario / Area                   | Issue Summary                                                                                                               | Root Cause                                                                                                                                                                                                        | Fix Applied                                                                                                                                                      | Verification Status                 |
| :---- | :------------------- | :-------------------------------- | :-------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------- |
| **1** | 2026-10-02 18:07 IST | Admin Pricing / Addons Form       | Radio buttons for "Pricing" & "Handling" rendered as giant overlapping circles covering label text                          | Global `input` rule had `width: 100%` and `min-height: 2.85rem` without excluding radio/checkbox                                                                                                                  | Scoped `input:not([type="checkbox"]):not([type="radio"])` and set fixed `1.15rem` radio sizes & alignment in `apps/web/admin/src/styles.css`                     | 🟡 Ready for User Retest on Staging |
| **2** | 2026-10-02 18:30 IST | Customer Payment / Verification   | Order with MANUAL_PRINT add-on displayed "Payment could not be completed" on Customer PWA after successful Razorpay payment | `createAuthorization` and `listSafeTimeline` in `apps/api/worker/src/tracking/repository.ts` lacked `'MANUAL_PRINT'` and `'AWAITING_FINISHING'` in SQL `status IN (...)`, returning `TRACKING_ACCESS_UNAVAILABLE` | Added `MANUAL_PRINT`, `AWAITING_FINISHING`, and all valid post-payment statuses to tracking queries; updated customer error fallback                             | 🟡 Ready for Deployment & Retest    |
| **3** | 2026-10-02 19:15 IST | Admin Settings / Cleanup Triggers | "Free All Print Data" & "Free Printed Data" failed with 500; 5-min scheduled cleanup threw errors in Worker logs            | Remote D1 table `cleanup_runs` lacked `cutoff_at_ms` column, throwing `SQLITE_ERROR: table cleanup_runs has no column named cutoff_at_ms` on `createRun` & `claimBatch`                                           | Executed `ALTER TABLE cleanup_runs ADD COLUMN cutoff_at_ms INTEGER NOT NULL DEFAULT 0;` on remote D1 and deployed updated API Worker with enhanced error logging | 🟢 Fixed & Deployed                 |
| **4** | 2026-10-02 19:50 IST | Admin Pricing / Discount Rules    | Browser rejected valid integer discount percentage (e.g. 50%) with HTML5 tooltip "Enter a valid value"                      | Input had `min="0.1"` and `step="0.5"`, causing HTML5 step constraint `(value - 0.1) % 0.5 === 0` which rejected whole numbers like 50; conflicted with integer-only backend schema                               | Changed input to `min="1" max="100" step="1"` and added `Number.isInteger` validation; deployed to Cloudflare Pages                                              | 🟢 Fixed & Deployed                 |

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

### Finding 3: Cleanup Buttons ("Free All Print Data" & "Free Printed Data") Failing in Admin Settings

- **Issue**: Clicking "Permanently delete" in the confirmation modal for "Free All Print Data" or "Free Printed Data" in Admin Settings resulted in a failed operation, and scheduled 5-minute cron runs in Cloudflare Workers logs repeatedly logged `Cleanup scheduled execution failed { error: 'Error' }`.
- **Expected**: Triggering manual cleanup immediately processes a batch, deletes R2 objects and purgeable records, and returns the updated run data. Scheduled 5-minute cron runs run smoothly without uncaught SQL errors.
- **Actual**: Both manual cleanup requests (`POST /api/admin/cleanup/runs`) and scheduled cron executions failed with uncaught exceptions.
- **Root Cause**:
  1. Code in `apps/api/worker/src/cleanup/repository.ts` inserts and queries `cutoff_at_ms` in `cleanup_runs` (`createRun`, `claimBatch`, `finishIfDrained`).
  2. While `database/migrations/0012_multi_file_cleanup_and_app_branding.sql` defined `cutoff_at_ms` in the schema for fresh databases, the live remote Cloudflare D1 database (`printgo-production`) was created during an earlier iteration and was missing the `cutoff_at_ms` column on the `cleanup_runs` table.
  3. This threw `SQLITE_ERROR: table cleanup_runs has no column named cutoff_at_ms` on every execution of `createRun`, `claimBatch`, and `finishIfDrained`.
- **Fix**:
  1. Executed `ALTER TABLE cleanup_runs ADD COLUMN cutoff_at_ms INTEGER NOT NULL DEFAULT 0;` and backfilled `UPDATE cleanup_runs SET cutoff_at_ms = created_at_ms WHERE cutoff_at_ms = 0;` on remote production D1.
  2. Verified through deep schema diffing that 100% of all other tables, columns, and constraints across all 19 migrations perfectly match the remote database.
  3. Enhanced Worker error logging in `apps/api/worker/src/index.ts` and `apps/api/worker/src/cleanup/admin-routes.ts` to log full `error.message` and `error.stack` traces.
  4. Deployed updated worker (Version `72fc7021-7414-4a10-96a4-9454311034a9`).
- **Tests**: `pnpm test` (78 suites, 655 tests passing), `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm db:validate`, `pnpm build` all passed (exit 0).

### Finding 4: HTML5 Step Validation Trap on Discount Percentage Input

- **Issue**: In Admin Pricing (`/admin/pricing`), when adding a new Discount Rule, entering valid integer values like `50` in the "Discount Percentage (%)" field and clicking "Save Rule" resulted in the browser blocking submission with a native popup: _"Enter a valid value"_.
- **Expected**: Entering any integer percentage (e.g. 5%, 10%, 50%, 100%) is accepted and saved.
- **Actual**: Browser blocked submission because the HTML `<input type="number">` had `min="0.1"` and `step="0.5"`. Under HTML5 validation, allowed values are `min + (n * step)`. For `min="0.1"` and `step="0.5"`, valid values are `0.1, 0.6, 1.1, ..., 49.6, 50.1`. The integer `50` was rejected by the browser because `(50 - 0.1) % 0.5 !== 0`. Furthermore, the backend schema (`packages/validation`) strictly requires integers (`Number.isSafeInteger`).
- **Fix**:
  1. Changed input attributes to `min="1" max="100" step="1"` in `apps/web/admin/src/DiscountRulesSection.tsx`.
  2. Added explicit `!Number.isInteger(discountPercent)` check in `handleCreate` to provide clear feedback.
  3. Built and deployed updated Admin PWA to Cloudflare Pages (`https://printgo-admin.pages.dev`).
- **Tests**: `pnpm --filter @printgo/admin test` (all passed), `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm build` all passed (exit 0).

### Finding 5: Priority Queue Persistence and Add-on Services Disappearing on Page Refresh

- **Issue**:
  1. In Admin Pricing (`/admin/pricing`), enabling "Priority Printing", setting a fee (e.g. ₹20), and clicking "Save Pricing" displayed "All changes saved", but upon refreshing or navigating away, the priority fee and toggle reverted to disabled / ₹0.
  2. Creating Add-on Services (or Discount Rules) displayed them immediately in the UI, but upon refreshing the page, they disappeared and displayed "No add-on services configured. Click '+ Add Service' to create one."
- **Expected**:
  - Saved priority printing enabled state and fee persist to database and reload accurately across page refreshes.
  - Configured add-on services and discount rules remain visible and populated across page refreshes.
- **Actual**:
  - Priority printing fee was not saved to the D1 `installation` table despite the UI success message.
  - Add-on services disappeared from the UI on refresh, even though the records existed safely in the database.
- **Root Cause**:
  1. **Priority Printing Validation Stripping**: `packages/validation/src/index.ts` defined `ValidatedPricingUpdate` with only `printRates` and `fileSizeServiceCharges`. In `validatePricingUpdateInput`, incoming `priorityPrinting` parameters were not processed or returned in `value`. Consequently, the API route passed `{ printRates, fileSizeServiceCharges }` to `repository.updatePricing`, which skipped updating the `installation` table columns `priority_printing_enabled` and `priority_fee_paise`.
  2. **Add-on Services Omission in Pricing Query**: `D1ConfigurationRepository.getPricing()` in `apps/api/worker/src/config/repository.ts` executed batch queries for print rates, size charges, installation, and discount rules, but omitted `addon_services`. `PricingPage.tsx` therefore received `undefined` for `pricing.addonServices`.
  3. **React Prop Lifecycle Desynchronization**: Both `AddonServicesSection.tsx` and `DiscountRulesSection.tsx` initialized state using `useState(initialServices)` and `useState(initialRules)`. Because `useState` initializers only evaluate on component mount (when initial props are `[]`), subsequent prop updates from the parent async API response never synchronized without a `useEffect` hook.
- **Fix**:
  1. Updated `packages/validation/src/index.ts` to include `priorityPrinting?: { enabled: boolean; feePaise: number }` in `ValidatedPricingUpdate` and validated non-negative integer paise.
  2. Updated `apps/api/worker/src/config/repository.ts` and `apps/api/worker/src/config/service.ts` to include `addon_services` in `getPricing()`.
  3. Added `useEffect(() => { setServices(initialServices); }, [initialServices]);` in `AddonServicesSection.tsx` and `useEffect(() => { setRules(initialRules); }, [initialRules]);` in `DiscountRulesSection.tsx`.
  4. Updated `PricingPage.tsx` to keep state synced across save operations.
  5. Added unit tests for priority printing validation and repository updates.
- **Tests**: `pnpm test` (78 suites, 657 tests passing), `pnpm typecheck` (0 errors), `pnpm lint` (0 warnings), `pnpm format:check` (clean), `pnpm db:validate` (clean), `pnpm build` (all packages built).

### Finding 6: Add-on Services Missing from Physical Job Identification Sheet (Paper)

- **Issue**: When a customer ordered print jobs with Add-on Services (such as Stapling, Spiral Binding, or Custom Colour Pages), the generated physical Identification Sheet that prints with the job omitted the add-on services list, pickup code, and any due-at-pickup balance. Print shop operators had no way to know from the printed paper what post-print finishing or manual actions were required for the customer's order.
- **Expected**: The physical Identification Sheet must visibly display all selected Add-on Services, including their name, price (e.g. Free, fixed price, or Staff Priced), handling mode (e.g. Staff Finishing, Manual Print, or Automatic), customer Pickup Code, and any amount due at pickup.
- **Actual**: The Identification Sheet only included customer details, general print summary (paper size, colour, sides, page range, copies), and customer instructions.
- **Fix**:
  1. Updated `IdentificationSheetData` and added `IdentificationSheetAddonService` in `packages/api-contract/src/index.ts` to include `pickupCode`, `dueAtPickupPaise`, and `addonServices`.
  2. Updated `apps/api/worker/src/printing/repository.ts` to query `order_addon_services` via SQLite `json_group_array(json_object(...))` and pass `pickup_code`, `due_at_pickup_paise`, and parsed `addonServices` into `identificationSheet` on claimed print jobs.
  3. Updated `apps/agent/windows/src/printing/identification-sheet.ts` to add a dedicated `ADD-ON SERVICES & FINISHING` section in the PDF layout, displaying each selected service (or "None selected by customer"), plus Pickup Code and Due at Pickup amounts.
  4. Added unit tests in `apps/agent/windows/src/printing/identification-sheet.test.ts`.
  5. Built and deployed updated Windows Agent bundle (`dist/bundle.cjs` & `dist-package/PrintGo-Windows-Test`) and API Worker (Version `b7c3d95d-234a-45cb-9aed-8dddaf5431e6`).
- **Tests**: `pnpm test` (78 suites, 658 tests passing), `pnpm typecheck` (0 errors), `pnpm lint` (0 warnings), `pnpm format:check` (clean), `pnpm db:validate` (clean), `pnpm build` (all packages & Windows bundle built).

### Finding 7: Unification to Single Pickup Code (PA-00x) and Removal of ID Card Notices & Human Job Code

- **Issue**:
  1. Customer checkout and payment success screens displayed confusing multiple codes: a primary "PICKUP CODE: PA-00x" alongside a secondary "Your Job Reference: PG-XXXX".
  2. The physical printed Identification Sheet also displayed both codes with title "HUMAN JOB CODE - VERIFY WITH CUSTOMER: PA-001 (PG-XXXX)".
  3. Pre-checkout and post-payment screens displayed unwanted ID card / ID required alert banners ("🪪 Identification will be required at pickup").
- **Expected**:
  - Exactly ONE single code (e.g. `PA-00x`) must be shown to both customers and print shop operators.
  - The human job reference code (`PG-XXXX`) must be completely removed from customer-facing screens and printed identification sheets.
  - The ID card / ID required alert banners must be completely removed from customer screens.
- **Actual**:
  - Customers saw redundant codes and ID required notices on screens, and printed sheets showed the internal job reference.
- **Fix**:
  1. Updated `apps/agent/windows/src/printing/identification-sheet.ts` to display Box 1 titled `PICKUP CODE - VERIFY WITH CUSTOMER` with only the pickup code (e.g. `PA-001`), completely omitting `jobCode` / `(PG-XXXX)`.
  2. Updated `apps/web/customer/src/App.tsx` to remove the pre-payment ID banner, remove "Your Job Reference", remove the post-payment ID banner, and display only the single Pickup Code card (`PA-00x`).
  3. Updated `apps/web/customer/src/PublicTrackingPage.tsx` to remove the identification required alert banner.
  4. Updated unit tests in `apps/agent/windows/src/printing/identification-sheet.test.ts`.
- **Tests**: `pnpm test` (78 suites, 658 tests passing), `pnpm typecheck` (0 errors), `pnpm lint` (0 warnings), `pnpm format:check` (clean), `pnpm db:validate` (clean), `pnpm build` (all packages & Windows bundle built).

### Finding 8: Add-on Services Display Converted to Custom-Length Chips Turning Green on Selection

- **Issue**: Add-on services were rendered as full-width vertical blocks stretching across the entire width of the card.
- **Expected**: Add-on services must be custom length (content-sized pill/chip buttons that wrap naturally like tags) and must turn green when selected.
- **Actual**: Add-on services used `display: flex; flex-direction: column` full-width cards with standard light blue checkboxes.
- **Fix**:
  1. Updated `.addon-checkbox-list` in `apps/web/customer/src/styles.css` to `display: flex; flex-direction: row; flex-wrap: wrap; gap: 0.5rem; align-items: center;`.
  2. Updated `.addon-checkbox-item` to `display: inline-flex; width: fit-content; border-radius: 9999px; padding: 0.4rem 0.85rem;` (capsule pill chips).
  3. Styled `.addon-checkbox-item.selected` and `.addon-checkbox-item:has(input:checked)` with vibrant green background (`#16a34a`), matching green border (`#15803d`), white text, and semi-transparent white price badges.
  4. Added `.selected` class binding on `App.tsx` and updated unit tests in `apps/web/customer/src/App.test.tsx`.
- **Tests**: `pnpm test` (78 suites, 659 tests passing), `pnpm typecheck` (0 errors), `pnpm lint` (0 warnings), `pnpm format:check` (clean), `pnpm db:validate` (clean), `pnpm build` (all packages built).

### Finding 9: Pagination Added to Live Orders, Manual Orders, and Order History

- **Issue**:
  1. Live Orders rendered all active jobs in a single unbounded vertical list without pagination.
  2. Manual Orders and Order History used a continuous "Load more" pattern that stacked cards indefinitely on the page rather than structured pagination.
- **Expected**:
  - Live Orders, Manual Orders, and Order History must provide structured, accessible pagination controls showing the current range, page numbers, and previous/next page navigation.
- **Actual**:
  - Live Orders had no page division; Manual Orders and Order History had bare "Load more" appending buttons.
- **Fix**:
  1. Created accessible, responsive `<Pagination />` component (`apps/web/admin/src/Pagination.tsx`) with item counters (`Showing X–Y of Z orders`), page number pill buttons (`1`, `2`, `3`...), and `← Prev` / `Next →` navigation.
  2. Integrated pagination into `LiveOrdersPage.tsx` with automatic page bounds clamping on polling updates.
  3. Integrated pagination into `ManualOrdersPage.tsx`, replacing the bare "Load more" button and seamlessly loading subsequent server batches on page advancement.
  4. Integrated pagination into `OrderHistoryPage.tsx`, replacing the bare "Load more" button with clean page-by-page traversal and server cursor fetching.
  5. Added comprehensive pagination CSS in `apps/web/admin/src/styles.css` with responsive mobile stacking and active page pill highlights.
  6. Added unit tests in `apps/web/admin/src/Pagination.test.tsx` and updated integration tests in `apps/web/admin/src/App.test.tsx`.
- **Tests**: `pnpm test` (79 suites, 663 tests passing), `pnpm typecheck` (0 errors), `pnpm lint` (0 warnings), `pnpm format:check` (clean), `pnpm db:validate` (clean), `pnpm build` (all packages & PWAs built).

### Finding 10: Customer Identification Policy Removed Completely from Admin Settings

- **Issue**: The admin shop settings page contained a "Customer Identification at Pickup" dropdown (options: "Off", "Always required", "Required only above order amount") under the Identification section, which was confusing and obsolete after standardizing on single Pickup Codes (`PA-00x`).
- **Expected**: Completely remove customer identification requirements from admin shop settings, leaving only the shop identification sheet printing settings, and ensure identification requirement policy is permanently forced to `OFF`.
- **Actual**: The Identification section in `ShopSettingsPage.tsx` contained configuration inputs for customer pickup ID policies and minimum order threshold amounts.
- **Fix**:
  1. Removed the "Customer Identification at Pickup" subsection, dropdown, and threshold input from `apps/web/admin/src/ShopSettingsPage.tsx`.
  2. Simplified the panel header to `Identification Sheet` focused exclusively on physical print sheet sorting.
  3. Ensured that loading and saving in `ShopSettingsPage.tsx` normalizes any ID requirement policy permanently to `OFF` with `0` threshold paise.
  4. Cleaned up unused pricing helper imports (`formatPaiseAsRupeesInput`, `parseRupeesToPaise`).
- **Tests**: `pnpm test` (79 suites, 663 tests passing), `pnpm typecheck` (0 errors), `pnpm lint` (0 warnings), `pnpm format:check` (clean), `pnpm db:validate` (clean), `pnpm build` (all packages & PWAs built).

### Finding 11: Storage & Privacy UI Layout, Modal Backdrop, and Danger Button Inconsistencies Fixed

- **Issue**:
  1. The "Free All Print Data" confirmation dialog was rendered inline without `.dialog-backdrop`, causing it to float haphazardly inside the card and overlap buttons.
  2. The primary `.danger-button` class was overridden by a secondary definition in `styles.css` with small padding (`0.4rem 0.75rem`) and light pink background, causing "Permanently delete" to have a completely mismatched height and style next to the "Cancel" `.secondary-button`.
  3. "Next Cleanup" was displaying a raw UTC ISO string (`2026-10-02T18:00:00.000Z`) rather than a friendly localized time.
  4. The definition list `<dl>` for cleanup status had broken grid alignment due to wrapper divs.
  5. The cleanup result status and refresh button were unstyled and rendered raw underneath the card content.
- **Expected**:
  - The confirmation dialog must be a centered modal with a dimmed backdrop (`.dialog-backdrop`).
  - `.danger-button` must match `.secondary-button` and `.primary-button` in height (`2.85rem`), border-radius (`0.55rem`), and typography, with solid red `#dc2626` background.
  - Dates and timestamps must be formatted in friendly localized medium date/time format.
  - Cleanup stats must be rendered in structured `.settings-stat-grid` cards.
  - Cleanup results must be rendered in an integrated `.notice` banner.
- **Fix**:
  1. Wrapped `cleanupPreview` confirmation dialog in `<div className="dialog-backdrop">` outside the form, with proper ARIA attributes and full backdrop blur/dim.
  2. Harmonized `.danger-button` styling with `.danger-button.subtle` (for card trigger buttons) and `.danger-button.compact` (for inline table actions), removing the conflicting global override.
  3. Formatted `lastCleanupAt` and `nextCleanupAt` with `formatCleanupDateTime` for readable localized date and time.
  4. Created `.settings-stat-grid` with `.stat-card` styling for clean, responsive key-value stats.
  5. Placed cleanup execution results in a styled `.notice` banner with inline status refresh.
- **Tests**: `pnpm test` (79 suites, 663 tests passing), `pnpm typecheck` (0 errors), `pnpm lint` (0 warnings), `pnpm format:check` (clean), `pnpm db:validate` (clean), `pnpm build` (all packages & PWAs built).

### Finding 12: Storage & Privacy Cleanup Returns "Deleted: 0 orders / 0 PDFs" and Abandoned Drafts Never Purged

- **Issue**:
  1. Triggering "Free Printed Data" or "Free All Print Data" in Admin -> Storage & Privacy returned `Deleted: 0 orders (0 PDFs) · 1 active skipped`.
  2. The only remaining order in remote D1 (`a0e7603f`) was created 2 days ago with status `PAYMENT_PENDING` and a 3.5MB PDF in R2, but was never cleaned up automatically or manually.
  3. The Admin UI stat card displayed `Last Cleanup: Not yet run` and `Last Result: —`, even after automated cron runs deleted earlier completed orders.
- **Root Causes**:
  1. **Abandoned Payment Lockout**: In `D1CleanupRepository`, `scopeWhere("EXPIRED_UNPAID")` checked `NOT EXISTS (SELECT 1 FROM payments p WHERE p.status IN ('CREATED','PENDING','PAID'))` and `safetyGuard` checked `ACTIVE_PAYMENT = EXISTS (... status IN ('CREATED','PENDING'))`. If a customer opened the Razorpay checkout modal but abandoned it, Razorpay left a row with `status = 'PENDING'`. Because the payment safety check lacked a check against the order's `draft_expires_at_ms`, the abandoned pending payment permanently locked the order from both `EXPIRED_UNPAID` and `ALL_PRINT_DATA` cleanup runs forever.
  2. **Run Hang in `finishIfDrained`**: When an active order existed, `finishIfDrained` used `remainingGuard = "1 = 1"` for `ALL_PRINT_DATA` and `ALL_COMPLETED`, ignoring the safety guard. It detected the skipped order in `orders` and concluded that eligible work remained, leaving the cleanup run stuck in `PENDING` indefinitely instead of completing.
  3. **Single Batch Cap on Admin Runs**: `requestAdminRun` called `processRun` once with `BATCH_LIMIT = 5`. If more than 5 orders were eligible, it only processed the first 5, leaving the run in `RUNNING` status and requiring subsequent 5-minute scheduled crons to finish the rest.
  4. **Installation Stat Card Stale**: `recordDailyResult` was only called when `source === "DAILY"`. Neither `SCHEDULED` (5-min cron) nor `ADMIN` manual runs ever updated `installation.last_cleanup_at_ms` or `last_cleanup_result`, causing the Admin UI to continuously display "Last Cleanup: Not yet run".
- **Fix Applied**:
  1. In `repository.ts`:
     - Updated `scopeWhere("EXPIRED_UNPAID")` so only `p.status = 'PAID'` prevents cleanup when `o.draft_expires_at_ms <= nowMs`. Expired drafts with abandoned/pending checkout attempts are now properly purgeable.
     - Updated `safetyGuard(scope, nowMs)`: `ACTIVE_PAYMENT` now checks `(o.draft_expires_at_ms IS NULL OR o.draft_expires_at_ms > nowMs)`. Once the order draft expiration time passes, pending payments are treated as dead and do not block cleanup.
     - Updated `finishIfDrained`: evaluates `safetyGuard(scope, nowMs)` directly so protected active orders do not cause the run to hang.
     - Added `recordCleanupResult` to update `installation.last_cleanup_at_ms` and `installation.last_cleanup_result`.
  2. In `service.ts`:
     - Updated `requestAdminRun` to loop up to 10 batches (50 orders) and immediately call `recordCleanupResult`.
     - Updated `runScheduled` to call `recordCleanupResult` whenever orders are deleted or a run completes.
  3. Added comprehensive regression tests in `apps/api/worker/src/cleanup/repository.test.ts`.
- **Tests**: `pnpm test` (79 suites, 664 tests passing), `pnpm typecheck` (0 errors), `pnpm lint` (0 warnings).
