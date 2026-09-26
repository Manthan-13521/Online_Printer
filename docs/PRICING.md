# Authoritative Pricing

## Ownership

The Worker is the only price authority. Future customer screens may display a preview, but they must submit selections—not a trusted final amount. The Worker loads the current D1 configuration and calls the environment-neutral `@printgo/pricing` package. That package has no React, HTTP, D1, Razorpay, or Cloudflare dependency.

## Formula

All money is non-negative integer paise. For a valid enabled combination:

```text
printing amount = page count × copies × configured per-page rate
total amount = printing amount + applicable file-size service charge
```

`DOUBLE` is a separately configured rate per logical PDF page. It is not converted into a physical-sheet billing formula.

The lookup key is exactly `(paperSize, colorMode, sides)` using the centralized A4/A3, BW/COLOR, and SINGLE/DOUBLE domain vocabularies. A disabled or missing combination fails closed with `PRINT_RATE_UNAVAILABLE`; it never silently creates a zero-price job.

## File-size rules

One MiB is exactly `1,048,576` bytes. UI labels use familiar `MB` wording while persisted and calculated values follow this binary MiB convention.

| Band | Exact byte rule           |
| ---- | ------------------------- |
| 1    | `0 < size <= 2 MiB`       |
| 2    | `2 MiB < size <= 5 MiB`   |
| 3    | `5 MiB < size <= 10 MiB`  |
| 4    | `10 MiB < size <= 25 MiB` |

The installation maximum is checked before band selection and cannot exceed 25 MiB. Therefore, with a 10 MiB shop maximum, 10 MiB is allowed and 10 MiB plus one byte is rejected even though the fourth band remains configured. Keeping temporarily unreachable bands allows the shop to raise its maximum later without rebuilding pricing.

## Result and errors

`calculatePrintPrice` returns printing, service, and total amounts in paise, INR currency, and copies of the applied rate and band. It rejects invalid counts or sizes, values above the shop maximum, unsupported vocabularies, disabled/missing rates, malformed configuration, absent bands, and unsafe integer overflow with explicit domain codes.

Example: 10 pages × 2 copies × ₹2.00 is ₹40.00 printing. With a ₹4.00 size charge, the authoritative total is ₹44.00.

## Admin editing

The Admin enters natural rupee strings such as `2`, `2.5`, or `2.50`. The shared exact parser converts those strings to 200 or 250 paise without floating-point multiplication and rejects negative values, fractional paise, non-numeric input, and empty input. Free rates and charges (`0`) are valid.

The Admin edits all eight rates and the charge for each of four fixed bands, then explicitly saves once. The Worker validates completeness, uniqueness, booleans, modes, boundaries, and integer paise before a single D1 batch updates the complete configuration plus one audit event. Boundaries are not editable. V1 has one admin account, so optimistic version conflict handling is intentionally omitted.

## Historical orders

Current configuration is separate from commercial history. Later order creation snapshots `printing_amount_paise`, `service_charge_paise`, and `total_amount_paise` from the authoritative result. A later Admin price change must never update or recalculate those order fields; no pricing-version subsystem is needed for V1.
