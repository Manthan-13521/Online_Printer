# API Conventions

## Customer draft APIs

Customer state changes require the exact configured customer `Origin` and
`Authorization: Bearer <draft-token>`. Tokens, signed URLs, infrastructure IDs,
and object keys must not be logged. Customer responses use `Cache-Control:
no-store`; PDF bytes are never accepted by the Worker API. See
`docs/CUSTOMER_UPLOAD.md` for the Phase 4 endpoints.

## Envelope

Successful JSON responses use:

```json
{ "ok": true, "data": {} }
```

Errors use:

```json
{
  "ok": false,
  "error": {
    "code": "SOME_MACHINE_CODE",
    "message": "Safe human-readable message"
  }
}
```

`error.details` is optional and must contain only safe, structured information. Never return stack traces, raw provider responses, SQL, secrets, or internal paths. Customer apps translate machine codes to calm, actionable wording; admin diagnostics may be more specific only when safe.

## HTTP behavior

- Use resource-oriented paths beneath `/api` for future business endpoints.
- Match HTTP status codes to the failure class; do not return `200` for an error envelope.
- Validate at the Worker boundary and reject unknown or malformed input.
- Require authenticated authorization for admin and Agent operations.
- Use explicit idempotency for payment webhooks and consequential retry operations.
- Paginate list endpoints and use bounded limits.
- Use ISO 8601 UTC timestamps, integer paise, and integer bytes.
- Do not accept client-supplied final prices, payment truth, object keys, or arbitrary status transitions.

## Correlation and logging

Future requests should receive a non-secret correlation/request ID suitable for safe logs and support. Logs must minimize personal data and never include credentials or private tracking tokens.

## Implemented routes

`GET /health` reports that the Worker process is available; it does not assert that future R2, Razorpay, Agent, or printer dependencies are ready.

The Phase 2 Admin authentication surface is:

- `POST /api/admin/auth/login`
- `GET /api/admin/auth/me`
- `POST /api/admin/auth/logout`
- `POST /api/admin/auth/sessions/revoke-all`
- `POST /api/admin/auth/change-password`

The Phase 3 Admin configuration surface is:

- `GET /api/admin/settings`
- `PUT /api/admin/settings`
- `GET /api/admin/pricing`
- `PUT /api/admin/pricing`

Settings responses expose only the normalized installation fields used by the Admin form. Pricing responses contain the eight normalized print-rate combinations, four fixed service-charge bands, and the current maximum PDF size. They never expose raw D1 row IDs. Pricing mutations replace one complete validated configuration; tier boundaries are not user-editable.

All state-changing Admin requests require the exactly configured trusted `Origin`. Credentialed CORS never uses a wildcard. Protected handlers derive the admin from the server-side session cookie; a browser-supplied admin ID never grants authority.

The browser sends configuration, selections, and an acknowledged review total,
never an authoritative charge amount. Payment creation loads current D1
configuration and calls `@printgo/pricing` in the Worker. The resulting
integer-paise amounts are snapshotted on the order and sent to Razorpay.

The Phase 5 customer payment surface is:

- `POST /api/customer/payments/create`
- `POST /api/customer/payments/verify`
- `POST /api/customer/payments/cancel`
- `POST /api/webhooks/razorpay`

The three customer routes require the exact configured customer origin and the
draft bearer token. The webhook is not browser CORS traffic: it authenticates
the raw body with the dedicated webhook secret and deduplicates the provider
event ID. See `docs/PAYMENTS.md` for the amount, capture, and readiness gates.

The Phase 6 private tracking surface is:

- `GET /api/customer/tracking/:jobCode`

It requires the exact customer origin and a 43-character private tracking bearer
token. The job code is normalized but is not authorization. The D1 query matches
the code and SHA-256 token hash together, validates the bounded lifetime, and
returns only `CustomerTrackingData`. Missing, malformed, expired, wrong-token,
and nonexistent-code requests use the same `404 TRACKING_NOT_FOUND` envelope.
Every tracking response, including errors, uses `Cache-Control: no-store`.

The Phase 10 paid-print surface is:

- `POST /api/agent/heartbeat` — renew/claim at most one eligible job and return its current persisted step.
- `POST /api/agent/print-jobs/:orderId/steps/:stepId/start` — persist the pre-submission boundary.
- `POST /api/agent/print-jobs/:orderId/steps/:stepId/submitted` — attach the exact correlated spool ID.
- `POST /api/agent/print-jobs/:orderId/steps/:stepId/result` — report blocked, success, proven failure, or uncertainty.
- `GET /api/admin/orders/live` — authenticated bounded operational observation only.

All Agent mutations require both the Agent bearer credential and active claim
nonce. Responses are `no-store`. Duplicate transitions are idempotent only when
the persisted spool/result identity agrees; conflicting physical identities are
rejected rather than overwritten.

The Phase 7 Agent and Admin Printer surface is:

- `POST /api/agent/pair` — Exchange 8-character Crockford pair code for persistent agent credentials.
- `POST /api/agent/heartbeat` — Periodic pulse (~30s) carrying discovered printers and capabilities, authenticated via `Authorization: Bearer <agentSecret>`.
- `POST /api/admin/agents/pair-code` — Generate new 10-minute pair code (authenticated Admin session).
- `GET /api/admin/printers` — List paired agents, online status, and printers with capabilities (authenticated Admin session).
- `POST /api/admin/agents/:agentId/revoke` — Revoke agent credentials and mark inactive (authenticated Admin session).
- `PUT /api/admin/printers/:printerId` — Toggle printer enabled state (authenticated Admin session).
