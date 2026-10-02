// Local SQLite query-plan evidence, not Cloudflare D1 billed rows or latency.
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { format } from "prettier";

const migrations = readdirSync("database/migrations")
  .filter((name) => name.endsWith(".sql"))
  .sort();

function database(includePhase7) {
  const db = new DatabaseSync(":memory:");
  for (const migration of migrations) {
    if (!includePhase7 && migration === "0019_phase7_restore_hot_indexes.sql")
      continue;
    db.exec(readFileSync(`database/migrations/${migration}`, "utf8"));
  }
  return db;
}

function explain(db, sql, values = []) {
  return db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...values)
    .map((row) => row.detail);
}

const before = database(false);
const after = database(true);
try {
  const cases = [
    {
      name: "customer draft token lookup",
      before: `SELECT id FROM orders WHERE draft_token_hash = ? AND cleanup_state = 'ACTIVE'`,
      after: `SELECT id FROM orders WHERE draft_token_hash = ? AND cleanup_state = 'ACTIVE'`,
      values: ["synthetic-token"],
    },
    {
      name: "unpaid cleanup due probe",
      before: `SELECT 1 FROM orders o WHERE o.cleanup_state = 'ACTIVE'
        AND o.status IN ('CREATED','UPLOADING','UPLOADED','PAYMENT_PENDING','PAYMENT_FAILED','PAYMENT_CANCELLED')
        AND o.draft_expires_at_ms <= ? LIMIT 1`,
      after: `SELECT 1 FROM orders o INDEXED BY orders_unpaid_cleanup_due_idx
        WHERE o.cleanup_state = 'ACTIVE'
        AND o.status IN ('CREATED','UPLOADING','UPLOADED','PAYMENT_PENDING','PAYMENT_FAILED','PAYMENT_CANCELLED')
        AND o.draft_expires_at_ms <= ? LIMIT 1`,
      values: [1_000],
    },
    {
      name: "completed cleanup due probe",
      before: `SELECT 1 FROM orders o WHERE o.cleanup_state = 'ACTIVE'
        AND o.status = 'COMPLETED' AND o.purge_at_ms IS NOT NULL
        AND o.purge_at_ms <= ? LIMIT 1`,
      after: `SELECT 1 FROM orders o INDEXED BY orders_completed_cleanup_due_idx
        WHERE o.cleanup_state = 'ACTIVE' AND o.status = 'COMPLETED'
        AND o.purge_at_ms IS NOT NULL AND o.purge_at_ms <= ? LIMIT 1`,
      values: [1_000],
    },
    {
      name: "manual queue",
      before: `SELECT o.id FROM orders o WHERE o.status IN ('MANUAL_PRINT','AWAITING_FINISHING')
        AND o.cleanup_state = 'ACTIVE' ORDER BY o.paid_at_ms`,
      after: `SELECT o.id FROM orders o INDEXED BY orders_manual_queue_idx
        WHERE o.status IN ('MANUAL_PRINT','AWAITING_FINISHING')
        AND o.cleanup_state = 'ACTIVE' ORDER BY o.paid_at_ms, o.id LIMIT 51`,
      values: [],
    },
  ];
  const unchanged = [
    {
      name: "priority and next-job candidate",
      sql: `SELECT id FROM orders WHERE status IN ('QUEUED','RETRY_PENDING')
        ORDER BY is_priority DESC, queued_at_ms, id LIMIT 1`,
    },
    {
      name: "retry queue",
      sql: `SELECT id FROM orders WHERE status = 'PRINT_FAILED'
        AND cleanup_state = 'ACTIVE' AND updated_at_ms <= ?
        ORDER BY updated_at_ms LIMIT 5`,
      values: [1_000],
    },
    {
      name: "pickup tracking",
      sql: `SELECT id FROM orders WHERE pickup_code = ? AND cleanup_state = 'ACTIVE' LIMIT 1`,
      values: ["SYNTHETIC"],
    },
    {
      name: "Admin active history keyset",
      sql: `SELECT id, created_at_ms FROM orders WHERE (created_at_ms, id) < (?, ?)
        ORDER BY created_at_ms DESC, id DESC LIMIT 21`,
      values: [Number.MAX_SAFE_INTEGER, "ffffffff-ffff-ffff-ffff-ffffffffffff"],
    },
    {
      name: "Admin retained history keyset",
      sql: `SELECT id, created_at_ms FROM retained_order_history
        WHERE (created_at_ms, id) < (?, ?) ORDER BY created_at_ms DESC, id DESC LIMIT 21`,
      values: [Number.MAX_SAFE_INTEGER, "ffffffff-ffff-ffff-ffff-ffffffffffff"],
    },
    {
      name: "daily cleanup bounded page",
      sql: `SELECT id FROM orders WHERE cleanup_state = 'ACTIVE'
        ORDER BY created_at_ms, id LIMIT 5`,
    },
  ];
  const evidence = {
    scope:
      "Local SQLite representative hot access paths; full Worker route plans are also captured by efficiency-audit.mjs",
    changed: cases.map((item) => ({
      name: item.name,
      before: explain(before, item.before, item.values),
      after: explain(after, item.after, item.values),
    })),
    unchanged: unchanged.map((item) => ({
      name: item.name,
      plan: explain(after, item.sql, item.values ?? []),
    })),
  };
  mkdirSync("docs/evidence/phase7", { recursive: true });
  writeFileSync(
    "docs/evidence/phase7/query-plans.json",
    await format(JSON.stringify(evidence), { parser: "json" }),
  );
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  before.close();
  after.close();
}
