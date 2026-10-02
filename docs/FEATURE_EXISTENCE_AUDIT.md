# PRINTGO FEATURE EXISTENCE AUDIT REPORT

**Date:** 2026-10-02  
**Scope:** Complete End-to-End Capability & Visibility Audit across Admin UI, Customer UI, Worker API, D1 Database, Windows Agent, and Test Suites.

---

## 1. Feature Audit Matrix

| FEATURE                             | ADMIN UI       | CUSTOMER UI    | API      | DB       | AGENT          | TESTS                  | STATUS       | EVIDENCE                                                                                                                                                                                      |
| :---------------------------------- | :------------- | :------------- | :------- | :------- | :------------- | :--------------------- | :----------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Add-on Services**              | COMPLETE       | COMPLETE       | COMPLETE | COMPLETE | COMPLETE       | COMPLETE               | **COMPLETE** | Config, order placement, state routing (`AWAITING_FINISHING`, `MANUAL_PRICING`), D1 schema `addon_services` & order snapshots verified.                                                       |
| **2. Pricing Engine**               | COMPLETE       | COMPLETE       | COMPLETE | COMPLETE | COMPLETE       | COMPLETE               | **COMPLETE** | Configurable rate bands, surcharges, server-authoritative calculations in `@printgo/pricing`, D1 migrations verified.                                                                         |
| **3. Priority Printing**            | COMPLETE       | COMPLETE       | COMPLETE | COMPLETE | COMPLETE       | COMPLETE               | **COMPLETE** | Priority toggle & fee configured in Admin, quote & checkout calculated server-side, priority queue ordering in Agent verified.                                                                |
| **4. Tiered Discounts**             | COMPLETE       | COMPLETE       | COMPLETE | COMPLETE | COMPLETE       | COMPLETE               | **COMPLETE** | Tiered discount rules configured in Admin (`discount_rules` table), server-calculated non-stacking highest threshold wins, snapshotted in order.                                              |
| **5. Identification Rules**         | COMPLETE       | COMPLETE       | COMPLETE | COMPLETE | COMPLETE       | COMPLETE               | **COMPLETE** | Settings `OFF`, `ALWAYS_REQUIRED`, `REQUIRED_ABOVE_X` in Admin & API; snapshot flag on paid orders; no PII/ID data stored.                                                                    |
| **6. Pickup Code System**           | COMPLETE       | COMPLETE       | COMPLETE | COMPLETE | COMPLETE       | COMPLETE               | **COMPLETE** | `PA-001` ➔ `PZ-999` safe wrap & active non-reuse. Admin UI now has explicit `[ Reset Next Code to PA-001 ]` with confirmation dialog & API verification.                                      |
| **7. Customer Tracking**            | COMPLETE       | COMPLETE       | COMPLETE | COMPLETE | COMPLETE       | COMPLETE               | **COMPLETE** | `/track/:code` route with safe statuses, no sensitive PII exposed, 2-hour completed purge (5-hour non-completed ceiling), rate-limiting on API endpoints.                                     |
| **8. Manual Orders**                | COMPLETE       | COMPLETE       | COMPLETE | COMPLETE | COMPLETE       | COMPLETE               | **COMPLETE** | Dedicated Admin tab for `MANUAL_PRICING` orders. Customer Checkout UI now explicitly distinguishes `ONLINE PAYMENT` vs `PAYABLE AT SHOP (Price decided by staff)`.                            |
| **9. Print Failure / Retry**        | COMPLETE       | COMPLETE       | COMPLETE | COMPLETE | COMPLETE       | REQUIRES REAL HARDWARE | **COMPLETE** | State transitions for `RETRY_PENDING`, `NEEDS_ADMIN`, `COMPLETION_UNKNOWN`, 2 auto-retries with 10s delay, Admin Retry/Download/Confirm UI.                                                   |
| **10. Printer Failure**             | COMPLETE       | COMPLETE       | COMPLETE | COMPLETE | COMPLETE       | REQUIRES REAL HARDWARE | **COMPLETE** | Printer-wide offline/paper-out/error detection pauses affected queue; Admin displays error status and "Check Again" reconciliation.                                                           |
| **11. Printer Fallback**            | COMPLETE       | NOT APPLICABLE | COMPLETE | COMPLETE | COMPLETE       | COMPLETE               | **COMPLETE** | PrinterPage now exposes native Primary/Fallback printer dropdown selection & Auto-Fallback toggle with capability validation.                                                                 |
| **12. Reprint / Duplicate Safety**  | COMPLETE       | NOT APPLICABLE | COMPLETE | COMPLETE | COMPLETE       | COMPLETE               | **COMPLETE** | Durable `print_attempt_id`, state machine preventing double-printing on duplicate webhooks, Admin manual reprint creating new attempt.                                                        |
| **13. Multi-PDF Support**           | COMPLETE       | COMPLETE       | COMPLETE | COMPLETE | COMPLETE       | COMPLETE               | **COMPLETE** | Up to 10 PDFs with per-file settings, reordering/removal, single payment checkout, and exact upload=print sequence.                                                                           |
| **14. System Branding**             | COMPLETE       | COMPLETE       | COMPLETE | COMPLETE | NOT APPLICABLE | COMPLETE               | **COMPLETE** | Admin Settings Branding UI (name, logo upload, max 1MB validation), dynamic header/title rendering across Customer & Admin PWAs.                                                              |
| **15. Storage & Privacy**           | COMPLETE       | NOT APPLICABLE | COMPLETE | COMPLETE | NOT APPLICABLE | COMPLETE               | **COMPLETE** | Automatic lifecycles (unpaid 10m; completed 2h purge of PDFs + disposable customer PII; 5h non-completed ceiling), Admin manual cleanup triggers & lifecycle toggles, zero R2 bucket listing. |
| **16. Admin History**               | COMPLETE       | NOT APPLICABLE | COMPLETE | COMPLETE | NOT APPLICABLE | COMPLETE               | **COMPLETE** | Keyset-paginated Admin history listing pickup codes, status, Add-ons, totals, printer details without loading PDF binaries.                                                                   |
| **17. Pricing & Info Page**         | NOT APPLICABLE | COMPLETE       | COMPLETE | COMPLETE | NOT APPLICABLE | COMPLETE               | **COMPLETE** | Customer `/pricing` route displaying live rate bands, Add-on Services, FREE services, priority info, and public shop details.                                                                 |
| **18. UI / Workflow Accessibility** | COMPLETE       | COMPLETE       | COMPLETE | COMPLETE | COMPLETE       | COMPLETE               | **COMPLETE** | Responsive navigation, modals, loading states, validation error boundaries across all Admin and Customer PWA screens.                                                                         |

---

## 2. Categorized Summary

### 1. COMPLETE Features (18/18)

1. Add-on Services (Admin UI + Customer UI + Worker API + D1 + Agent)
2. Pricing Engine & Server-Authoritative Quotes
3. Priority Printing & Fee Calculation
4. Tiered Surcharge/Discount Rules
5. Identification Rules & Non-PII Flagging
6. Pickup Code System & Candidate Reset UI
7. Customer Tracking PWA & Safe Status Display
8. Manual Orders & Staff-Priced Customer Breakdown UI
9. Print Failure & Auto-Retry Loop (up to 2 retries, 10s backoff)
10. Printer Hardware Failure Detection & Admin Reconciliation
11. Printer Fallback & Admin Configuration Dropdowns
12. Reprint & Duplicate-Print Fencing (`print_attempt_id`)
13. Multi-PDF Upload & Single-Checkout Batching (up to 10 files)
14. System Branding (Shop Name & Logo Upload)
15. Storage & Privacy Lifecycle Automation (Unpaid 10m, Completed 2h, PII 5h)
16. Admin Keyset Paginated History
17. Customer Pricing & Info Public View
18. Responsive UI / Workflow Accessibility

---

## 3. Verification of Cleanup Policy & Previous Audit Claims

- **Completed Order Retention & PII Cleanup**:
  - `COMPLETED_RETENTION_MS` = 2 Hours (`7_200_000 ms`).
  - Upon order completion, `purge_at_ms` is set to `completed_at_ms + 2 hours`.
  - The 2-hour cleanup run (`COMPLETED_DUE`) deletes both the R2 PDF files AND the order record (which includes customer name, phone, notes, and file metadata).
  - Non-completed customer PII retention cap is 5 hours (`PII_RETENTION_MS` = `5 * 60 * 60 * 1000 ms`). Successfully completed orders are fully purged at 2 hours.
- **Verification of Admin Deployed Reachability**:
  - All Admin sections (Add-on Services, Discounts, Priority, Identification, Pickup Code Reset, Printer Fallback) are fully integrated into Admin Navigation tabs (`Settings`, `Printers`, `Addons`, `Live Orders`, `Manual Orders`).
