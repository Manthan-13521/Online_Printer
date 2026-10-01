// Controlled local Tests D/E. Uses SQLite, an in-memory R2 implementation,
// mocked Razorpay responses, and synthetic spool IDs. It does not contact
// Cloudflare, Razorpay, Windows, or a physical printer.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRuntime } from "./stress-runtime.mjs";
import { workload } from "./stress-workload.mjs";

const outputDirectory = "docs/evidence/d1-usage-optimization/local";
mkdirSync(outputDirectory, { recursive: true });

function snapshot(runtime, httpRequests) {
  return {
    httpRequests,
    statements: runtime.totals.statements,
    returnedRows: runtime.totals.returnedRows,
    changedTableRows: runtime.totals.changedRows,
    r2: { ...runtime.totals.r2 },
    provider: { ...runtime.totals.provider },
  };
}

function subtract(after, before) {
  return {
    httpRequests: after.httpRequests - before.httpRequests,
    statements: after.statements - before.statements,
    returnedRows: after.returnedRows - before.returnedRows,
    changedTableRows: after.changedTableRows - before.changedTableRows,
    r2: Object.fromEntries(
      Object.keys(after.r2).map((key) => [key, after.r2[key] - before.r2[key]]),
    ),
    provider: Object.fromEntries(
      Object.keys(after.provider).map((key) => [
        key,
        after.provider[key] - before.provider[key],
      ]),
    ),
  };
}

function writeProfile(runtime) {
  const grouped = new Map();
  for (const item of runtime.writeProfile.values()) {
    const key = `${item.table}:${item.operation}:${item.transition}`;
    grouped.set(key, (grouped.get(key) ?? 0) + item.tableRowsWritten);
  }
  return grouped;
}

function subtractProfile(after, before) {
  return [...after]
    .map(([key, rows]) => ({ key, rows: rows - (before.get(key) ?? 0) }))
    .filter((item) => item.rows > 0)
    .sort((left, right) => right.rows - left.rows);
}

async function run(orderCount) {
  const runtime = await createRuntime(
    `.tmp/d1-controlled-usage/${orderCount}-${Date.now()}`,
    { profileWrites: true },
  );
  let httpRequests = 0;
  async function request(operation, path, options = {}) {
    const route = {
      endpoint: operation,
      calls: 1,
      statements: 0,
      returnedRows: 0,
      changedRows: 0,
      queryMs: 0,
    };
    const response = await runtime.context.run(route, () =>
      runtime.api.routeRequest(
        new Request(`https://api.audit.invalid${path}`, {
          method: options.method ?? "GET",
          headers: {
            Origin: options.admin
              ? runtime.env.ADMIN_ALLOWED_ORIGIN
              : runtime.env.CUSTOMER_ALLOWED_ORIGIN,
            ...(options.admin
              ? { Cookie: `__Host-printgo_admin=${runtime.adminToken}` }
              : {}),
            ...(options.token
              ? { Authorization: `Bearer ${options.token}` }
              : {}),
            ...(options.headers ?? {}),
            ...(options.body ? { "Content-Type": "application/json" } : {}),
          },
          ...(options.body
            ? {
                body: options.raw
                  ? String(options.body)
                  : JSON.stringify(options.body),
              }
            : {}),
        }),
        runtime.env,
      ),
    );
    httpRequests++;
    const payload = await response.json();
    assert.ok(
      (options.expected ?? [200]).includes(response.status),
      `${operation}: unexpected HTTP ${response.status} ${JSON.stringify(payload)}`,
    );
    return payload;
  }

  const work = workload(runtime, request);
  try {
    await work.heartbeat(0);
    const printerId = runtime.db
      .prepare(
        "SELECT id FROM printers WHERE windows_printer_name = 'Synthetic 0'",
      )
      .get().id;
    await request(
      "select-default-printer",
      `/api/admin/printers/${printerId}/default`,
      { admin: true, method: "POST", body: {} },
    );
    const before = snapshot(runtime, httpRequests);
    const beforeProfile = writeProfile(runtime);
    for (let index = 0; index < orderCount; index++) {
      await work.customer("paid");
    }
    for (let index = 0; index < orderCount; index++) {
      await work.heartbeat(0);
    }
    const completed = Number(
      runtime.db
        .prepare("SELECT COUNT(*) count FROM orders WHERE status = 'COMPLETED'")
        .get().count,
    );
    const duplicateAttempts = Number(
      runtime.db
        .prepare(
          `SELECT COUNT(*) count FROM (
             SELECT order_id FROM print_attempts
             GROUP BY order_id HAVING COUNT(*) > 1
           )`,
        )
        .get().count,
    );
    assert.equal(completed, orderCount);
    assert.equal(duplicateAttempts, 0);
    return {
      evidence: "MEASURED LOCAL",
      warning:
        "SQLite returned/changed rows are not Cloudflare rows_read/rows_written.",
      orderCount,
      completed,
      duplicateAttempts,
      tableWriteProfile: subtractProfile(writeProfile(runtime), beforeProfile),
      ...subtract(snapshot(runtime, httpRequests), before),
    };
  } finally {
    runtime.close();
  }
}

const result = {
  generatedAt: new Date().toISOString(),
  scope:
    "Controlled local handlers with SQLite, in-memory R2, mocked Razorpay and synthetic spool IDs.",
  testD: await run(1),
  testE: await run(10),
};
writeFileSync(
  `${outputDirectory}/controlled-orders.json`,
  `${JSON.stringify(result, null, 2)}\n`,
);
console.log(JSON.stringify(result, null, 2));
