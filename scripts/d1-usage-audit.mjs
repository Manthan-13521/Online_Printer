// Deterministic local query-plan and relative-cost audit.
// This is SQLite evidence, not Cloudflare rows_read/rows_written billing data.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const outputDirectory = "docs/evidence/d1-usage-optimization/local";
mkdirSync(outputDirectory, { recursive: true });

const db = new DatabaseSync(":memory:");
for (const migration of readdirSync("database/migrations")
  .filter((name) => name.endsWith(".sql"))
  .sort()) {
  db.exec(readFileSync(`database/migrations/${migration}`, "utf8"));
}

const nowMs = 1_800_000_000_000;
db.prepare(
  `INSERT INTO installation (id, shop_name, created_at_ms, updated_at_ms)
   VALUES (1, 'Synthetic query-plan shop', 0, 0)`,
).run();
const agentId = randomUUID();
const printerId = randomUUID();
db.prepare(
  `INSERT INTO agents
   (id, display_name, credential_hash, is_active, paired_at_ms,
    last_heartbeat_at_ms, created_at_ms, updated_at_ms)
   VALUES (?, 'Synthetic Agent', 'synthetic-hash', 1, 0, ?, 0, ?)`,
).run(agentId, nowMs, nowMs);
db.prepare(
  `INSERT INTO printers
   (id, agent_id, display_name, windows_printer_name, enabled, status,
    last_status_at_ms, created_at_ms, updated_at_ms)
   VALUES (?, ?, 'Synthetic Printer', 'Synthetic Printer', 1, 'ONLINE', ?, 0, ?)`,
).run(printerId, agentId, nowMs, nowMs);

const insertOrder = db.prepare(
  `INSERT INTO orders
   (id, customer_name, customer_phone, original_filename, selected_pages,
    copies, color_mode, paper_size, sides, status, claimed_by_agent_id,
    claim_id, claim_expires_at_ms, claimed_at_ms, printer_id, created_at_ms, updated_at_ms,
    draft_expires_at_ms, completed_at_ms, purge_at_ms)
   VALUES (?, 'Synthetic', '0000000000', 'synthetic.pdf', 'ALL', 1, 'BW',
    'A4', 'SINGLE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const insertFile = db.prepare(
  `INSERT INTO order_files
   (id, order_id, position, original_filename, r2_object_key,
    expected_size_bytes, size_bytes, mime_type, source_page_count,
    paper_size, color_mode, sides, upload_status, print_status,
    uploaded_at_ms, printed_at_ms, created_at_ms, updated_at_ms)
   VALUES (?, ?, 1, 'synthetic.pdf', ?, 100, 100, 'application/pdf', 1,
    'A4', 'BW', 'SINGLE', 'UPLOADED', ?, 0, ?, 0, ?)`,
);

db.exec("BEGIN");
for (let index = 0; index < 600; index++) {
  const orderId = randomUUID();
  const fileId = randomUUID();
  const completed = index >= 200 && index < 400;
  const active = index >= 400;
  const status = completed ? "COMPLETED" : active ? "QUEUED" : "UPLOADED";
  const claimedAgent = completed ? agentId : null;
  const claimId = completed ? randomUUID() : null;
  const claimExpiry = completed ? nowMs + 60_000 : null;
  const claimedAt = completed ? nowMs - 20_000 : null;
  const orderPrinter = completed ? printerId : null;
  const completedAt = completed ? nowMs - 10_000 : null;
  const purgeAt = completed ? nowMs - 1_000 : null;
  insertOrder.run(
    orderId,
    status,
    claimedAgent,
    claimId,
    claimExpiry,
    claimedAt,
    orderPrinter,
    index,
    nowMs,
    active || completed ? nowMs + 60_000 : nowMs - 1_000,
    completedAt,
    purgeAt,
  );
  insertFile.run(
    fileId,
    orderId,
    `uploads/${orderId}/${fileId}.pdf`,
    completed ? "PRINTED" : "PENDING",
    completedAt,
    nowMs,
  );
}
db.exec("COMMIT");
db.exec("PRAGMA optimize");

const cloudReads = JSON.parse(
  readFileSync("docs/evidence/d1-usage-optimization/cloud/reads.json", "utf8"),
);
const expiredPreview = cloudReads.find(
  (entry) =>
    entry.query.includes("COUNT(DISTINCT CASE") &&
    entry.query.includes("draft_expires_at_ms <="),
);
const completedPreview = cloudReads.find(
  (entry) =>
    entry.query.includes("COUNT(DISTINCT CASE") &&
    entry.query.includes("purge_at_ms <="),
);
if (!expiredPreview || !completedPreview) {
  throw new Error(
    "Expected cleanup preview queries are absent from cloud evidence",
  );
}

const openRunSql = `SELECT 1 open_run FROM cleanup_runs
  WHERE scope = ? AND source = ?
    AND status IN ('PENDING','RUNNING','PARTIAL')
  LIMIT 1`;
const activeGuards = `AND NOT (
    o.status IN ('PAID','QUEUED','CLAIMED','SPOOLING','PRINTING','PRINT_BLOCKED',
      'ADMIN_ACTION_REQUIRED','PRINTED')
    OR EXISTS (SELECT 1 FROM order_files active_file
      WHERE active_file.order_id = o.id
        AND active_file.print_status IN ('SUBMISSION_STARTED','SUBMITTED','BLOCKED','UNCERTAIN'))
    OR (EXISTS (SELECT 1 FROM order_files printed_file
        WHERE printed_file.order_id = o.id AND printed_file.print_status = 'PRINTED')
      AND EXISTS (SELECT 1 FROM order_files unfinished_file
        WHERE unfinished_file.order_id = o.id AND unfinished_file.print_status <> 'PRINTED'))
  )
  AND NOT EXISTS (SELECT 1 FROM payments active_payment
    WHERE active_payment.order_id = o.id
      AND active_payment.status IN ('CREATED','PENDING'))`;
const expiredCandidateSql = `SELECT 1 candidate FROM orders o
  WHERE o.cleanup_state = 'ACTIVE'
    AND o.status IN ('CREATED','UPLOADING','UPLOADED','PAYMENT_PENDING','PAYMENT_FAILED','PAYMENT_CANCELLED')
    AND o.draft_expires_at_ms <= ?
    AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id
      AND p.status IN ('CREATED','PENDING','PAID'))
    ${activeGuards}
  LIMIT 1`;
const completedCandidateSql = `SELECT 1 candidate FROM orders o
  WHERE o.cleanup_state = 'ACTIVE' AND o.status = 'COMPLETED'
    AND o.purge_at_ms IS NOT NULL AND o.purge_at_ms <= ?
    ${activeGuards}
  LIMIT 1`;
for (const scope of ["EXPIRED_UNPAID", "COMPLETED_DUE"]) {
  db.prepare(
    `INSERT INTO cleanup_runs
     (id, scope, source, status, orders_selected, files_selected,
      bytes_selected, active_skipped, cutoff_at_ms, created_at_ms, updated_at_ms)
     VALUES (?, ?, 'SCHEDULED', 'PARTIAL', 1, 1, 100, 0, ?, ?, ?)`,
  ).run(randomUUID(), scope, nowMs, nowMs, nowMs);
}

function plan(sql, values) {
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values);
}

function benchmark(label, iterations, operation) {
  const start = performance.now();
  for (let index = 0; index < iterations; index++) operation();
  const durationMs = performance.now() - start;
  return { label, iterations, durationMs, averageMs: durationMs / iterations };
}

const iterations = 200;
const benchmarks = [
  benchmark(
    "before: repeated expired preview despite open run",
    iterations,
    () => db.prepare(expiredPreview.query).get(nowMs),
  ),
  benchmark(
    "before: repeated completed preview despite open run",
    iterations,
    () => db.prepare(completedPreview.query).get(nowMs),
  ),
  benchmark(
    "after: indexed open-run gate for expired cleanup",
    iterations,
    () => db.prepare(openRunSql).get("EXPIRED_UNPAID", "SCHEDULED"),
  ),
  benchmark(
    "after: indexed open-run gate for completed cleanup",
    iterations,
    () => db.prepare(openRunSql).get("COMPLETED_DUE", "SCHEDULED"),
  ),
];

const result = {
  generatedAt: new Date().toISOString(),
  evidence: "MEASURED LOCAL",
  warning:
    "SQLite timings and plans provide relative/query-plan evidence only; they are not Cloudflare billed rows_read or rows_written.",
  fixture: {
    orders: 600,
    expiredUnpaid: 200,
    completedDue: 200,
    activeQueued: 200,
    files: 600,
    openScheduledRuns: 2,
  },
  cloudBeforeReference: {
    expiredPreview: {
      avgRowsRead: expiredPreview.avgRowsRead,
      totalRowsRead: expiredPreview.totalRowsRead,
      executions: expiredPreview.numberOfTimesRun,
    },
    completedPreview: {
      avgRowsRead: completedPreview.avgRowsRead,
      totalRowsRead: completedPreview.totalRowsRead,
      executions: completedPreview.numberOfTimesRun,
    },
  },
  plans: {
    expiredPreview: plan(expiredPreview.query, [nowMs]),
    completedPreview: plan(completedPreview.query, [nowMs]),
    openRunGate: plan(openRunSql, ["EXPIRED_UNPAID", "SCHEDULED"]),
    expiredCandidateGate: plan(expiredCandidateSql, [nowMs]),
    completedCandidateGate: plan(completedCandidateSql, [nowMs]),
  },
  benchmarks,
};

writeFileSync(
  `${outputDirectory}/query-plan-and-gate-benchmark.json`,
  `${JSON.stringify(result, null, 2)}\n`,
);
console.log(JSON.stringify(result, null, 2));
db.close();
