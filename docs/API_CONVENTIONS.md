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

## Implemented routes

`GET /health` reports that the Worker process is available; it does not assert that future R2, Razorpay, Agent, or printer dependencies are ready.

The Phase 2 Admin authentication surface is:

- `POST /api/admin/auth/login`
- `GET /api/admin/auth/me`
- `POST /api/admin/auth/logout`
- `POST /api/admin/auth/sessions/revoke-all`
- `POST /api/admin/auth/change-password`

All state-changing Admin requests require the exactly configured trusted `Origin`. Credentialed CORS never uses a wildcard. Protected handlers derive the admin from the server-side session cookie; a browser-supplied admin ID never grants authority.
