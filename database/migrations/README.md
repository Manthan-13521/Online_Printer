# D1 migrations

SQL files in this directory are the source of truth for the D1 schema. Apply them
in numeric order. `0001_initial_schema.sql` creates the Phase 1 schema,
`0002_customer_draft_upload.sql` adds the Phase 4 draft/upload fields, and
`0003_payment_idempotency.sql` adds the Phase 5 active-attempt and event
idempotency constraints. `0004_customer_tracking.sql` adds the Phase 6 tracking
lifetime fields and expiry index.

Do not edit an already-deployed migration. Add a new numbered migration for later schema changes.
