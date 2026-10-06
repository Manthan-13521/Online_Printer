# PrintGo Security Audit Report

## 1. Authentication & Access Control

**PASS**: Validated.

- Admin APIs use strict secure cookies with `SameSite=Lax` and `HttpOnly`.
- Customer APIs use `draft_token` hashes tied exclusively to session storage preventing IDOR.
- Private object storage enforces bounds on access. R2 signed URLs explicitly bound action and size.

## 2. PDF & Upload Security

**PASS / findings**:

- **Upload safety**: Pre-signed URLs bound maximum bytes (25MB limit).
- **Resource bomb defense**: The Agent's `downloadAndValidateCustomerPdf` function historically buffered the entire 25MB file into Node.js heap memory to verify the first 5 and last 2048 bytes.
- **Fix Applied**: Rewrote PDF parsing bounds check to use `fs.open` and bounded `fs.read` to only load the exact 2053 bytes needed into memory, enforcing resource efficiency and defending against resource exhaustion (Ponytail Minimal Fix).

## 3. Webhook Idempotency & Payments

**PASS**:

- Razorpay Webhooks strictly enforce HMAC-SHA256 signature verification in constant time.
- The `claimProviderEvent` handles replay protection via D1 event deduplication.
- Amount and currency are authoritatively verified server-side inside `validateCapturedPayment` preventing client tampering.

## 4. Storage & Cleanup

**PASS**:

- 10-minute unpaid draft cleanup explicitly managed.
- 2-hour completion retention enforced for PDF deletion via `COMPLETED_PDF_RETENTION_MS`.
- Free-tier limits correctly bounded.

_No outstanding severe vulnerabilities identified based on source review and local checks._
