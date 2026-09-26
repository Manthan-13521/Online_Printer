# Razorpay payments

Phase 5 adds payment creation and confirmation without adding printing, Agent
pairing, tracking, refunds, or cleanup execution. A payment can queue an order;
it cannot claim or print it.

## Trust boundary

The browser never supplies an authoritative amount or payment state. Before each
new Razorpay order, the Worker:

1. resolves the draft from its hashed bearer token;
2. rejects expired drafts and missing/changed private R2 objects;
3. loads the current enabled shop configuration and pricing rows;
4. derives the selected page count from the stored page range;
5. recalculates integer-paise printing and file service amounts; and
6. compares that result with the last total the customer explicitly reviewed.

If the total differs, the API returns `PRICE_CHANGED` with the complete new
server quote and creates no Razorpay order. The customer must press Pay again to
acknowledge the new total. The acknowledged amount is only a comparison value;
it is never passed through as the charge amount.

## Readiness gate

In Phase 7, `PaymentReadiness` is connected to real Windows Agent and printer state via `D1PaymentReadiness`.
Before creating a Razorpay order, the Worker verifies:

1. **Shop Online Printing Enabled**: `shop_settings.online_printing_enabled === 1`.
2. **Online Agent Heartbeat**: At least one active agent has pulsed within the last 90 seconds (`AGENT_HEARTBEAT_TIMEOUT_MS`).
3. **Enabled Online Printer**: At least one printer linked to an online agent is enabled (`enabled === 1`) and available (`ONLINE` or `UNKNOWN`).
4. **Print Capability Matching**: The online enabled printer must support the draft's requested options:
   - `colorMode === "COLOUR"` requires colour capability.
   - `sides !== "ONE_SIDED"` requires duplex capability.
   - The requested `paperSize` must be present in the printer's supported paper sizes.

If any check fails, payment creation fails closed with explicit error codes (`ONLINE_PRINTING_DISABLED`, `NO_ONLINE_AGENT`, `NO_ONLINE_PRINTER`, `NO_MATCHING_PRINTER`).

Local development can optionally bypass the readiness gate only when both conditions are met:

```text
APP_ENV=development
PAYMENT_READINESS_DEV_BYPASS=true
```

In production (`APP_ENV=production`), this bypass is completely ignored, ensuring money is never accepted when the shop cannot fulfill the job.

## Creation and checkout

`POST /api/customer/payments/create` accepts only
`acknowledgedTotalPaise`. The Worker reserves one active D1 payment attempt,
creates a Razorpay order with the server total in paise and `INR`, validates the
provider response, then persists the exact provider order ID. A repeated request
reuses the same pending provider order only when its amount and currency still
match. The partial unique index in migration `0003` prevents multiple active D1
attempts for one order.

The browser loads Razorpay Standard Checkout only after the Worker returns
checkout data. Duplicate Pay clicks are disabled. Checkout dismissal records a
customer cancellation. Browser success is provisional: the UI shows no job code
until the Worker completes verification.

## Callback verification

`POST /api/customer/payments/verify` requires the draft bearer token. The Worker:

- loads the server-persisted Razorpay order and verifies it belongs to that draft;
- verifies HMAC-SHA256 over `<stored-order-id>|<payment-id>` using the Razorpay
  key secret;
- fetches the payment from Razorpay; and
- requires `captured`, the exact stored order ID, exact integer amount, and `INR`.

An authorized, created, failed, mismatched, or otherwise unconfirmed payment
does not create a job code. Provider secrets and raw provider responses are not
returned to the browser or written to event JSON.

For Phase 6, the browser also submits a freshly generated 32-byte tracking
credential after saving it in `sessionStorage`. The Worker activates its hash
only after the payment checks above pass. The successful response echoes that
same raw credential so the UI can open/copy the private tracking link. See
`docs/CUSTOMER_TRACKING.md` for idempotency and browser-link behavior.

## Webhook verification and idempotency

`POST /api/webhooks/razorpay` reads a bounded raw request body. It validates
`x-razorpay-signature` against the raw bytes with
`RAZORPAY_WEBHOOK_SECRET` before JSON parsing. A valid
`x-razorpay-event-id` is required and reserved in
`payment_provider_events`; duplicate deliveries return success without replaying
state transitions.

The implemented events are `payment.captured`, `order.paid`, and
`payment.failed`. Captured events must match the stored order, amount, currency,
and captured state. Unknown signed events are recorded as ignored. Processing
failures are recorded as failed and return a non-2xx response for provider retry.
Raw webhook bodies are not persisted.

## Successful transition and job code

A confirmed capture updates the payment to `PAID`, assigns one unique code in
the form `PG-XXXXXX`, records `PAYMENT_PENDING -> PAID -> QUEUED`, and clears the
unpaid upload deletion deadline. The alphabet excludes `0`, `O`, `1`, `I`, and
`L`; collisions retry. Event idempotency keys and provider-event uniqueness make
callback/webhook retries return the already assigned code without another state
transition.

The code is a human collection/reference code, not an authorization credential.
Private tracking requires the separate token added in Phase 6.

## Failure, cancellation, and retention

Provider-confirmed failure and customer checkout cancellation set the order to
the corresponding payment state and change upload retention to
`PAYMENT_FAILED_OR_CANCELLED` for 30 minutes. A successful capture clears the
unpaid deadline so a paid PDF remains available for the later Agent workflow.
Phase 12 owns physical deletion; this phase only records deadlines.

## Configuration

Worker secrets:

- `RAZORPAY_KEY_ID`
- `RAZORPAY_KEY_SECRET`
- `RAZORPAY_WEBHOOK_SECRET`

Register the webhook URL as the shop deployment's
`/api/webhooks/razorpay` endpoint and subscribe to the implemented events. Use
Razorpay Test Mode credentials for local/test flows. Do not place key secrets or
webhook secrets in Vite/frontend variables.

Official integration references:

- https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/
- https://razorpay.com/docs/webhooks/validate-test/
- https://razorpay.com/docs/api/payments/fetch-with-id/

The repository's automated tests use mock provider responses. A successful
build or mock test does not prove a live Razorpay Test Mode payment or webhook.
