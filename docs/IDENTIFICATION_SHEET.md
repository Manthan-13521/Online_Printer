# Identification Sheet Generation and Placement

Phase 9 adds a local Windows Agent subsystem for creating a one-page shop
identification sheet. It does not claim customer orders, fetch objects from R2,
open or modify customer PDFs, or execute customer-document printing. Those
orchestration steps remain Phase 10 work.

## Invariants

- At most one identification sheet is planned for an order.
- Its copy count is always `1`, even when the customer ordered many copies.
- It is always A4, black and white, single-sided, and page `1` only.
- It uses the same exact named printer selected for the order. The Windows
  adapter rejects a different `settings.printerName` and fails closed when the
  printer or deterministic SumatraPDF engine cannot satisfy the request.
- `FIRST` produces `IDENTIFICATION_SHEET -> CUSTOMER_DOCUMENT`; `LAST`
  produces the reverse. When disabled, the plan contains only
  `CUSTOMER_DOCUMENT`.
- The planner is a pure sequencing function. A `CUSTOMER_DOCUMENT` plan step is
  not executed in Phase 9.

The Agent evaluates the installation's current identification-sheet setting
when Phase 10 eventually builds an execution plan. Changing the setting affects
orders that have not yet been executed; it does not rewrite an already printed
order or create a second sheet.

## Safe data contract

`IdentificationSheetData` contains only the operational display fields needed
to generate the sheet: public job code, customer name, already-masked phone,
customer print summary, frozen paid amount, instructions, paid timestamp, and
optional shop name. It contains no tracking token, draft token, Agent secret,
Admin session, R2 key, Razorpay identifier, database ID, claim ID, or internal
route URL.

The Agent masks the supplied phone value again before rendering, so a malformed
caller cannot accidentally print the full number. Text is bounded, control
characters are removed, PDF metacharacters are escaped, and characters outside
the built-in PDF font's safe range are replaced rather than allowed to corrupt
the file. Instructions wrap to a bounded number of lines.

## Local PDF lifecycle

The PDF is generated entirely in Agent memory and written with mode `0600` to a
cryptographically unpredictable filename under the operating-system temporary
directory. `withIdentificationSheetFile` deletes it after either successful or
failed submission. A cleanup failure is surfaced as a typed error; it is not
silently treated as success. No identification sheet is uploaded to R2 or
stored in D1.

`printIdentificationSheet` submits only this generated local PDF with the fixed
settings above. It does not download or print the customer's document.

## Data sources for later orchestration

The sheet content maps to existing frozen order/payment fields:

- `orders.public_job_code`, `customer_name`, masked `customer_phone`
- `paper_size`, `color_mode`, `sides`, `selected_pages`, `copies`
- `total_amount_paise`, `currency`, `instructions`, `paid_at_ms`
- the installation shop name and identification-sheet configuration

No Phase 9 migration is required. `print_attempts.identification_sheet_included`
already exists for Phase 10 to record whether the one sheet was included in an
actual attempt.

## Verification boundary

Automated tests cover one-page A4 PDF structure and content, defensive phone
masking, metacharacter/Unicode handling, fixed settings, `FIRST`, `LAST`, `OFF`,
one-sheet-with-many-customer-copies planning, and temporary-file cleanup on
success and failure. Real Windows identification-sheet printing has not been
exercised and remains a required hardware acceptance test.
