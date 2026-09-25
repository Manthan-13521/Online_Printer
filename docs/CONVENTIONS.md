# Engineering Conventions

## Identifiers

Use distinct types and fields for distinct trust domains:

- Internal database IDs are opaque implementation identifiers and are not customer credentials.
- Public job codes are human-friendly references and cannot authorize access to private data.
- Tracking tokens are high-entropy private credentials used for customer tracking access.
- Agent IDs and printer IDs identify resources; Agent secrets authenticate an Agent.
- Provider payment IDs are external references and never replace the internal order/payment relationship.

Do not expose internal database IDs unless an API specifically needs them. Never put secrets in identifiers or logs.

## Deployment scope

One deployed installation represents one shop. D1 and R2 are isolated by deployment, not by runtime tenant middleware. Do not add `shop_id` to every table, a tenant selector, or cross-shop routing. The one-row `installation` record describes the current shop; multiple Agents and printers may belong to it.

## Time

- Persist instants in UTC.
- Send API timestamps as ISO 8601 strings with an explicit UTC offset, normally `Z`.
- Localize display time at the UI boundary using the configured shop/user locale and time zone.
- Keep retention deadlines as explicit UTC instants, not ad-hoc formatted strings.

## Money

- Represent INR as integer paise (`amountPaise`).
- Never use floating-point arithmetic for authoritative pricing.
- Include the ISO currency code (`INR`) at API/provider boundaries.
- Formatting rupees for display is a UI concern; calculations remain in paise.

## File sizes

- Store and compare file sizes as integer bytes.
- One MiB is `1,048,576` bytes. UI labels may say MB for familiarity, but authoritative boundaries must use the documented byte conversion consistently.
- Current future service-charge boundaries are 2, 5, 10, and 25 MiB. Full pricing logic belongs to Phase 3.

## Status vocabulary

Order statuses and transitions are defined once in `@printgo/domain`. APIs and applications must import them instead of spreading string literals. PDF deletion is an upload/storage lifecycle and never replaces a completed order's `COMPLETED` state.

## Security and privacy

- Treat uploaded PDFs and customer-provided names, filenames, phone numbers, and instructions as untrusted input.
- Return safe client messages; keep stack traces, secrets, and sensitive diagnostics out of responses.
- Avoid logging raw document content, tokens, credentials, or unnecessary personal data.
- PDFs belong in private R2 and temporary controlled local Agent storage, never in D1.
