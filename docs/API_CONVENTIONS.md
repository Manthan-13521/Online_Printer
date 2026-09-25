# API Conventions

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

## Phase 0 route

`GET /health` is the only implemented route. It reports that the Worker process is available; it does not assert that future D1, R2, Razorpay, Agent, or printer dependencies are ready.
