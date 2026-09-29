// Real local handlers and SQLite row triggers. No provider billing or physical printing.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRuntime } from "./stress-runtime.mjs";
import { workload } from "./stress-workload.mjs";
const phase = process.argv[2];
if (!["before", "after"].includes(phase))
  throw new Error("Choose before or after");
const output = "docs/evidence/efficiency-v2";
mkdirSync(output, { recursive: true });
if (phase === "before" && existsSync(`${output}/write-breakdown-before.json`))
  throw new Error(
    "Baseline is already captured. Run 'after' against changed source.",
  );
const realNow = Date.now;
const scenarios = [];
for (const target of [1, 10, 60, 800]) {
  const r = await createRuntime(
    `.tmp/efficiency-v2/profile-${phase}-${target}-${realNow()}`,
    { profileWrites: true },
  );
  let now = realNow(),
    requests = 0;
  Date.now = () => now;
  const request = async (endpoint, path, options = {}) => {
    const stats = {
      endpoint,
      statements: 0,
      returnedRows: 0,
      changedRows: 0,
      queryMs: 0,
    };
    const res = await r.context.run(stats, () =>
      r.api.routeRequest(
        new Request("https://api.audit.invalid" + path, {
          method: options.method ?? "GET",
          headers: {
            Origin: r.env.CUSTOMER_ALLOWED_ORIGIN,
            ...(options.token
              ? { Authorization: `Bearer ${options.token}` }
              : {}),
            ...(options.body ? { "Content-Type": "application/json" } : {}),
            ...options.headers,
          },
          ...(options.body
            ? {
                body: options.raw ? options.body : JSON.stringify(options.body),
              }
            : {}),
        }),
        r.env,
      ),
    );
    requests++;
    assert.ok(
      (options.expected ?? [200]).includes(res.status),
      `${endpoint}: ${res.status}`,
    );
    return res.json();
  };
  const work = workload(r, request);
  try {
    const printer = r.db
      .prepare(
        "SELECT id FROM printers WHERE windows_printer_name='Synthetic 0'",
      )
      .get();
    r.db
      .prepare(
        "UPDATE installation SET default_production_printer_id=?,identification_sheet_enabled=1 WHERE id=1",
      )
      .run(printer.id);
    r.db.exec("DELETE FROM write_observations");
    for (let n = 0; n < target; n++) {
      now += 60000;
      // Liveness is explicitly attributed to the background, separate from order flow.
      await request("idle-liveness", "/api/agent/pulse", {
        method: "POST",
        token: r.agentTokens[0],
        body: { agentVersion: "audit", operationalState: "ONLINE" },
      });
      await work.customer("paid");
      await work.heartbeat(0);
      await work.heartbeat(0);
    }
    const retention = new r.api.RetentionService(
      new r.api.D1RetentionRepository(r.env.DB),
      r.env.PDF_BUCKET,
      () => now + 6 * 3600000,
    );
    for (let n = 0; n < Math.ceil(target / 5); n++)
      await r.context.run(
        {
          endpoint: "retention-cleanup",
          statements: 0,
          returnedRows: 0,
          changedRows: 0,
          queryMs: 0,
        },
        () => retention.runCleanup({ batchLimit: 5 }),
      );
    assert.equal(
      r.db
        .prepare("SELECT COUNT(*) n FROM orders WHERE status='COMPLETED'")
        .get().n,
      target,
    );
    const writes = [...r.writeProfile.values()];
    const tables = Object.fromEntries(
      [
        "orders",
        "order_events",
        "payments",
        "uploads",
        "print_attempts",
        "print_attempt_steps",
        "agents",
        "printers",
        "admins",
        "admin_sessions",
        "payment_provider_events",
      ].map((t) => [t, 0]),
    );
    const categories = {};
    for (const w of writes) {
      tables[w.table] = (tables[w.table] ?? 0) + w.tableRowsWritten;
      categories[w.category] =
        (categories[w.category] ?? 0) + w.tableRowsWritten;
    }
    const plans = [...r.queries.values()].map((q) => ({
      sql: q.sql,
      plan: r.db
        .prepare("EXPLAIN QUERY PLAN " + q.sql)
        .all(...Array((q.sql.match(/\?/g) || []).length).fill(null)),
    }));
    const scenario = {
      orders: target,
      requests,
      requestsPerOrder: requests / target,
      returnedRows: r.totals.returnedRows,
      returnedRowsPerOrder: r.totals.returnedRows / target,
      tableRowsWritten: r.totals.changedRows,
      writesPerOrderExcludingBackground:
        ((categories["per-order"] ?? 0) + (categories.retention ?? 0)) / target,
      tables,
      categories,
      statements: writes.sort(
        (a, b) => b.tableRowsWritten - a.tableRowsWritten,
      ),
    };
    if (phase === "after") {
      assert.ok(
        scenario.writesPerOrderExcludingBackground <= 45,
        "Write amplification regression",
      );
      assert.equal(
        tables.order_events,
        11 * target,
        "Meaningful forensic events must survive optimization",
      );
      assert.equal(
        tables.print_attempt_steps,
        8 * target,
        "Keep each durable boundary for both steps",
      );
      const idlePlan = plans.find((q) => q.sql.includes("has_print_work"));
      assert.ok(
        idlePlan && idlePlan.plan.every((p) => !p.detail.startsWith("SCAN")),
        "No-work pulse must remain indexed",
      );
    }
    scenarios.push(scenario);
    if (target === 1)
      writeFileSync(
        `${output}/writes-per-order-${phase}.json`,
        JSON.stringify(scenario, null, 2) + "\n",
      );
    if (target === 800)
      writeFileSync(
        `${output}/query-plans-${phase}.json`,
        JSON.stringify(plans, null, 2) + "\n",
      );
    console.log(
      JSON.stringify({
        phase,
        orders: target,
        tables,
        writesPerOrder: scenario.writesPerOrderExcludingBackground,
      }),
    );
  } finally {
    Date.now = realNow;
    r.close();
  }
}
writeFileSync(
  `${output}/write-breakdown-${phase}.json`,
  JSON.stringify(
    {
      label:
        "MEASURED SQLite table-row mutations for SIMULATED two-step paid orders, including retention. Index writes and billing rows are not measured. Setup excluded. One heartbeat/minute attributed separately.",
      scenarios,
    },
    null,
    2,
  ) + "\n",
);
