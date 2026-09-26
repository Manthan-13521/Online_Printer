# Private customer tracking

Phase 6 provides account-free, read-only print-job tracking. It does not add
printing, Agent state updates, PDF download, customer editing, cancellation, or
refunds.

## Authorization model

The human code (`PG-XXXXXX`) is only a collection/reference code. It never
authorizes a lookup by itself. A tracking request requires both the normalized
job code and a 32-byte private bearer token.

After Razorpay returns a provisional checkout success, the Customer PWA creates
the token with `crypto.getRandomValues`, saves it in `sessionStorage` before
calling payment verification, and includes it in the signed callback request.
The Worker first verifies the draft, Razorpay signature, captured provider
payment, amount, currency, and provider order. Only then does it activate the
credential by storing its SHA-256 hash. The raw token is never stored in D1 or
logged.

This client-generated challenge solves payment retry safely without storing a
recoverable raw secret: if the verification response is lost, the same browser
reuses the pending token. A conditional D1 update creates one authorization;
the same token is idempotent and a different token cannot replace it. A webhook
may finalize payment and assign the job code first, but it never creates,
rotates, or invalidates tracking access. The later verified browser callback can
attach the already-held credential.

Tracking access lasts 14 days from its first activation. The duration is the
shared `CUSTOMER_TRACKING_LIFETIME_MS` constant. Expiry is not extended by page
views or payment retries.

## Browser link behavior

The private link is:

```text
/track/PG-XXXXXX#<tracking-token>
```

The fragment is not sent in the HTTP request. The PWA reads it, stores the raw
token in `sessionStorage`, and immediately removes the fragment from the visible
URL with `history.replaceState`. Refresh works for that browser tab/session.

The payment-success and tracking screens provide an explicit copy action with
the warning: “Anyone with this link can view this print-job status.” Copying is
never automatic. A customer who wants to reopen tracking after completely
closing the browser must retain that private link. Phase 6 deliberately has no
token recovery or rotation flow.

## API and privacy

`GET /api/customer/tracking/:jobCode` requires:

- the exact configured customer `Origin`;
- `Authorization: Bearer <tracking-token>`; and
- a valid, unexpired code-plus-token-hash match for a paid order.

All responses use `Cache-Control: no-store`. Existing code plus wrong token,
nonexistent code, expired access, and malformed credentials return the same
generic `TRACKING_NOT_FOUND` response. The query matches job code and token hash
together, so the code alone never reveals an order.

The response contains only the customer name, payment received state,
customer-safe order status, timestamps, print summary, amount/currency,
instructions, safe file-retention state, and a filtered timeline. It omits
phone number, internal IDs, R2 keys, filenames, payment-provider internals,
Agent/printer identifiers, failure diagnostics, and PDF access.

## Status and file retention

`orders.status` remains current truth. `order_events` contributes only selected
customer-safe timeline entries; internal event names and details are never
returned. The centralized mapping in `@printgo/domain` converts every current
internal order status to customer wording.

Tracking/history retention is independent from PDF retention. A completed order
can still show `Completed` after `uploads.storage_status` becomes `DELETED`, with
the plain message that the uploaded PDF has been deleted. Tracking never depends
on R2 object existence and never offers PDF download.
