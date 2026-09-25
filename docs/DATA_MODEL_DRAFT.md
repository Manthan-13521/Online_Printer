# Data Model Boundary Draft

This is a Phase 0 responsibility map, not a migration or finalized D1 schema. Table definitions, keys, indexes, constraints, and state-transition enforcement belong to Phase 1.

| Concept       | Owns                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------- |
| Shop/settings | Single-shop identity, availability, customer notices, retention-independent configuration |
| Admin/session | One V1 admin identity and revocable secure sessions                                       |
| Pricing rule  | Versioned authoritative prices, supported print options, file-size tiers                  |
| Printer/Agent | Pairing identity, configured printer, capabilities, heartbeat and operational state       |
| Order/event   | Customer request metadata, controlled status, print settings, immutable timeline          |
| Upload        | Private R2 object reference, trusted byte size, logical expiry/deletion outcome           |
| Payment       | Expected amount/currency, Razorpay references, verified/idempotent outcome                |
| Audit log     | Minimum-necessary record of security-sensitive admin and Agent actions                    |

Design constraints for Phase 1:

- D1 stores metadata only; PDF bytes stay in private R2.
- Internal IDs, public job codes, private tracking tokens, Agent IDs, printer IDs, and payment IDs remain distinct.
- Atomic job claiming and idempotent payment processing must be supported by constraints/transactions.
- Retention deadlines must be queryable without full-table scans.
- History/report queries must be indexed and paginated.
- One deployment serves one shop; no centralized cross-shop data plane is introduced.
