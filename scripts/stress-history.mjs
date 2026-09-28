import { createRuntime } from "./stress-runtime.mjs";
import { writeFileSync } from "node:fs";
import { Histogram } from "./stress-metrics.mjs";
const runtime = await createRuntime(`.tmp/stress/history-${Date.now()}`),
  db = runtime.db;
const request = () =>
  runtime.api.routeRequest(
    new Request("https://api.audit.invalid/api/admin/orders/live", {
      headers: {
        Origin: runtime.env.ADMIN_ALLOWED_ORIGIN,
        Cookie: `__Host-printgo_admin=${runtime.adminToken}`,
      },
    }),
    runtime.env,
  );
await request();
const query = [...runtime.queries.values()].find((x) =>
  x.sql.includes("SELECT o.id order_id, o.public_job_code"),
).sql;
const now = Date.now();
const insert = db.prepare(
  `INSERT INTO orders (id,public_job_code,customer_name,customer_phone,original_filename,selected_pages,source_page_count,copies,color_mode,paper_size,sides,total_amount_paise,printing_amount_paise,status,created_at_ms,updated_at_ms,paid_at_ms,queued_at_ms,completed_at_ms,claimed_by_agent_id,printer_id,claim_id,claimed_at_ms,claim_expires_at_ms) VALUES (?,?,'Synthetic','9000000000','synthetic.pdf','1',1,1,'BW','A4','SINGLE',100,100,?,?,?,?,?,?,(SELECT agent_id FROM printers ORDER BY id LIMIT 1),(SELECT id FROM printers ORDER BY id LIMIT 1),?,?,?)`,
);
const idFor = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
for (let n = 1; n <= 100; n++)
  insert.run(
    idFor(n),
    `PG-H${n}`,
    "QUEUED",
    now,
    now,
    now,
    now,
    null,
    `claim-${n}`,
    now,
    now + 120000,
  );
const levels = [];
let rows = 0;
for (const target of [30000, 180000, 365000, 730000]) {
  const start = performance.now();
  while (rows < target) {
    db.exec("BEGIN");
    for (let j = 0; j < 1000 && rows < target; j++, rows++) {
      const t = now - 86400000 - (rows % 730) * 86400000;
      insert.run(
        idFor(rows + 101),
        `PG-H${rows + 101}`,
        "COMPLETED",
        t,
        t,
        t,
        t,
        t,
        `claim-${rows + 101}`,
        t,
        t + 120000,
      );
    }
    db.exec("COMMIT");
  }
  db.exec("ANALYZE");
  const histogram = new Histogram();
  for (let n = 0; n < 30; n++) {
    const t = performance.now();
    const response = await request();
    if (response.status !== 200) throw new Error("History route failed");
    await response.arrayBuffer();
    histogram.add(performance.now() - t);
  }
  const pages = db.prepare("PRAGMA page_count").get().page_count,
    size = db.prepare("PRAGMA page_size").get().page_size;
  const result = {
    historicalOrders: rows,
    atJobsPerDay: 1000,
    horizonDays: rows / 1000,
    activeOrders: 100,
    seedSeconds: (performance.now() - start) / 1000,
    databaseBytes: Number(pages) * Number(size),
    adminLiveLatencyMs: histogram.snapshot(),
    plan: db.prepare("EXPLAIN QUERY PLAN " + query).all(now - 3600000),
  };
  levels.push(result);
  writeFileSync(
    "artifacts/history-progress.json",
    JSON.stringify(levels, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      historicalOrders: rows,
      databaseMB: result.databaseBytes / 1048576,
      p95: result.adminLiveLatencyMs.p95,
    }),
  );
}
// Same historical volume, progressively larger unresolved live backlog.
const backlog = [];
for (const target of [1000, 10000, 50000]) {
  db.prepare(
    "UPDATE orders SET status='QUEUED', completed_at_ms=NULL,updated_at_ms=? WHERE id IN (SELECT id FROM orders WHERE status='COMPLETED' LIMIT ?)",
  ).run(now, target - (backlog.at(-1)?.activeOrders ?? 100));
  const h = new Histogram();
  for (let n = 0; n < 10; n++) {
    const t = performance.now();
    await (await request()).arrayBuffer();
    h.add(performance.now() - t);
  }
  backlog.push({
    activeOrders: target,
    latencyMs: h.snapshot(),
    plan: db.prepare("EXPLAIN QUERY PLAN " + query).all(now - 3600000),
  });
}
writeFileSync(
  "artifacts/history-results.json",
  JSON.stringify(
    {
      levels,
      backlog,
      scope:
        "Orders table plus real indexes; other historical child tables not synthesized. Storage is a lower bound; full-flow storage comes from scale-results. 1000 jobs/day histories are physically generated; 10000/day multi-year data is not generated.",
    },
    null,
    2,
  ) + "\n",
);
runtime.close();
