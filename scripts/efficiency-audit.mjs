// Local only: real handlers/SQLite, mocked R2/payment provider, no printer access.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { createRuntime } from "./stress-runtime.mjs";
import { workload } from "./stress-workload.mjs";
import { Histogram } from "./stress-metrics.mjs";
const output = "docs/evidence/efficiency-v2";
mkdirSync(output, { recursive: true });
const thresholds = {
  duplicateAttempts: 0,
  lostJobs: 0,
  incorrectStates: 0,
  unexpectedResponses: 0,
  peakRSSMB: 512,
  p95LocalApiMs: 250,
};
writeFileSync(
  `${output}/thresholds.json`,
  JSON.stringify(thresholds, null, 2) + "\n",
);
const results = [];
const originalNow = Date.now;

function harness(runtime) {
  const routes = new Map();
  const latency = new Histogram();
  let requests = 0;
  async function request(name, path, options = {}) {
    const stats = routes.get(name) ?? {
      hist: new Histogram(),
      statements: 0,
      returnedRows: 0,
      changedRows: 0,
      queryMs: 0,
    };
    routes.set(name, stats);
    const start = performance.now();
    const res = await runtime.context.run(stats, () =>
      runtime.api.routeRequest(
        new Request("https://api.audit.invalid" + path, {
          method: options.method ?? "GET",
          headers: {
            Origin:
              options.origin ??
              (options.admin
                ? runtime.env.ADMIN_ALLOWED_ORIGIN
                : runtime.env.CUSTOMER_ALLOWED_ORIGIN),
            ...(options.token
              ? { Authorization: `Bearer ${options.token}` }
              : {}),
            ...(options.admin
              ? { Cookie: `__Host-printgo_admin=${runtime.adminToken}` }
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
        runtime.env,
      ),
    );
    requests++;
    const elapsed = performance.now() - start;
    stats.hist.add(elapsed);
    latency.add(elapsed);
    assert.ok(
      (options.expected ?? [200]).includes(res.status),
      `${name}: unexpected HTTP ${res.status} ${await (res.status >= 400 ? res.clone().text() : Promise.resolve(""))}`,
    );
    if (options.response) return res;
    return res.json();
  }
  return {
    request,
    snapshot: () => ({
      requests,
      latency: latency.snapshot(),
      routes: Object.fromEntries(
        [...routes].map(([k, r]) => [k, { ...r, hist: r.hist.snapshot() }]),
      ),
    }),
  };
}

async function regressions() {
  const r = await createRuntime(
    `.tmp/stress/efficiency-regressions-${originalNow()}`,
  );
  const { request } = harness(r);
  try {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS2kAAAAASUVORK5CYII=",
      "base64",
    );
    const upload = () =>
      request("logo-upload", "/api/admin/branding/logo", {
        admin: true,
        method: "PUT",
        body: png,
        raw: true,
        headers: { "Content-Type": "image/png" },
      });
    await request("logo-auth", "/api/admin/branding/logo", {
      method: "PUT",
      origin: r.env.ADMIN_ALLOWED_ORIGIN,
      body: png,
      raw: true,
      headers: { "Content-Type": "image/png" },
      expected: [401],
    });
    await request("logo-origin", "/api/admin/branding/logo", {
      admin: true,
      origin: "https://evil.invalid",
      method: "PUT",
      body: png,
      raw: true,
      expected: [403],
    });
    for (const [name, body, mime, status] of [
      ["mime", png, "image/svg+xml", 400],
      ["signature", Buffer.from("<svg/>"), "image/png", 400],
      ["oversize", Buffer.alloc(262145), "image/png", 413],
    ]) {
      await request(name, "/api/admin/branding/logo", {
        admin: true,
        method: "PUT",
        body,
        raw: true,
        headers: { "Content-Type": mime },
        expected: [status],
      });
    }
    const first = await upload();
    const image = await request("logo-public", first.data.logoUrl, {
      response: true,
    });
    assert.equal(image.headers.get("Content-Type"), "image/png");
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
    const getBefore = r.totals.r2.GET;
    await request("logo-etag", first.data.logoUrl, {
      headers: { "If-None-Match": image.headers.get("ETag") },
      expected: [304],
      response: true,
    });
    assert.equal(r.totals.r2.GET, getBefore);
    const second = await upload();
    assert.notEqual(first.data.logoUrl, second.data.logoUrl);
    await request("old-logo", first.data.logoUrl, { expected: [404] });
    assert.equal(r.objects.size, 1);
    const cleanup = new r.api.RetentionService(
      new r.api.D1RetentionRepository(r.env.DB),
      r.env.PDF_BUCKET,
      () => originalNow() + 86_400_000,
    );
    await cleanup.runCleanup();
    assert.equal(r.objects.size, 1);
    const config = await request("public-config", "/api/customer/config");
    assert.equal(config.data.logoUrl, second.data.logoUrl);
    assert.equal(JSON.stringify(config).includes("logo_key"), false);
    await request("remove", "/api/admin/branding/logo/remove", {
      admin: true,
      method: "POST",
      body: {},
    });
    assert.equal(r.objects.size, 0);
    const settings = (
      await request("settings", "/api/admin/settings", { admin: true })
    ).data.settings;
    await request("name-required", "/api/admin/settings", {
      admin: true,
      method: "PUT",
      body: { ...settings, shopName: " " },
      expected: [400],
    });
    await request("optional-logo", "/api/admin/settings", {
      admin: true,
      method: "PUT",
      body: { ...settings, shopName: "Synthetic shop" },
    });
    return {
      status: "PASS",
      checks: [
        "authentication",
        "origin",
        "MIME",
        "signature",
        "size",
        "public bytes",
        "ETag avoids R2 GET",
        "replacement",
        "removal",
        "retention excludes branding",
        "name required",
        "logo optional",
      ],
    };
  } finally {
    r.close();
  }
}

async function idleDay() {
  const r = await createRuntime(`.tmp/stress/efficiency-idle-${originalNow()}`);
  const { request, snapshot } = harness(r);
  const work = workload(r, request);
  let now = originalNow();
  Date.now = () => now;
  try {
    // Register changed startup state, then measure a steady 15-hour idle day.
    await work.heartbeat(0);
    const before = structuredClone(r.totals),
      start = performance.now();
    for (let i = 1; i <= 10800; i++) {
      now += 5000;
      await request("agent-pulse", "/api/agent/pulse", {
        method: "POST",
        token: r.agentTokens[0],
        body: { agentVersion: "audit", operationalState: "ONLINE" },
      });
    }
    const measured = {
      httpRequests: 10800,
      tableRowsChanged: r.totals.changedRows - before.changedRows,
      statements: r.totals.statements - before.statements,
      returnedRows: r.totals.returnedRows - before.returnedRows,
      localWallMs: performance.now() - start,
      ...snapshot(),
    };
    assert.equal(
      measured.tableRowsChanged,
      900,
      "Only once/minute liveness writes during stable idle",
    );
    assert.equal(
      measured.statements,
      11700,
      "One indexed auth/work query per pulse plus minute liveness",
    );
    return measured;
  } finally {
    Date.now = originalNow;
    r.close();
  }
}

async function scale(target) {
  const r = await createRuntime(
    `.tmp/stress/efficiency-scale-${target}-${originalNow()}`,
  );
  const { request, snapshot } = harness(r),
    work = workload(r, request);
  const start = performance.now(),
    cpu = process.cpuUsage();
  let peakRSS = 0,
    paid = 0;
  const completedPayments = [];
  let simulatedNow = originalNow();
  Date.now = () => simulatedNow;
  try {
    const printerId = r.db
      .prepare("SELECT id FROM printers WHERE windows_printer_name = ?")
      .get("Synthetic 0").id;
    await request(
      "select-printer",
      `/api/admin/printers/${printerId}/default`,
      { admin: true, method: "POST", body: {} },
    );
    await work.heartbeat(0);
    // Use both two-step orders and document-only orders. One Agent owns the queue.
    for (const requestedBurst of [10, 25, 50]) {
      const burst = Math.min(requestedBurst, target - paid);
      if (burst <= 0) break;
      simulatedNow += Math.floor((15 * 3600_000 * burst) / target);
      await work.heartbeat(0);
      r.db
        .prepare(
          "UPDATE installation SET identification_sheet_enabled=1,identification_sheet_placement=? WHERE id=1",
        )
        .run(burst === 25 ? "FIRST" : "LAST");
      const batch = await Promise.all(
        Array.from({ length: burst }, () => work.customer("paid")),
      );
      completedPayments.push(...batch);
      paid += burst;
      const contention = await Promise.all(
        Array.from({ length: burst }, () =>
          request("claim-contention", "/api/agent/pulse", {
            method: "POST",
            token: r.agentTokens[0],
            body: { agentVersion: "audit", operationalState: "ONLINE" },
          }),
        ),
      );
      const attempts = new Set(
        contention.map((x) => x.data?.printJob?.attemptId).filter(Boolean),
      );
      assert.ok(
        attempts.size <= 1,
        "Concurrent pulses cannot create multiple active attempts",
      );
      for (let i = 0; i < burst * 2; i++) await work.heartbeat(0);
      peakRSS = Math.max(peakRSS, process.memoryUsage().rss / 1048576);
      assert.equal(
        r.db
          .prepare("SELECT COUNT(*) n FROM orders WHERE status='COMPLETED'")
          .get().n,
        paid,
      );
    }
    while (paid < target) {
      const batch = Math.min(25, target - paid);
      simulatedNow += Math.floor((15 * 3600_000 * batch) / target);
      r.db
        .prepare(
          "UPDATE installation SET identification_sheet_enabled=?,identification_sheet_placement=? WHERE id=1",
        )
        .run(paid % 2, paid % 3 ? "LAST" : "FIRST");
      // Paired agents remain live; only agent 0 processes the queue.
      await work.heartbeat(0);
      await Promise.all(
        Array.from({ length: batch }, () => work.customer("paid")),
      );
      paid += batch;
      for (let i = 0; i < batch * ((paid - batch) % 2 ? 2 : 1); i++)
        await work.heartbeat(0);
      await request("dashboard", "/api/admin/dashboard", { admin: true });
      await request("admin-live", "/api/admin/orders/live", { admin: true });
      peakRSS = Math.max(peakRSS, process.memoryUsage().rss / 1048576);
    }
    // Verify provider webhook replay after browser verification remains idempotent.
    const payment = completedPayments[0];
    const event = {
      id: `evt_${target}`,
      event: "payment.captured",
      payload: {
        payment: {
          entity: {
            id: payment.paymentId,
            order_id: payment.orderId,
            amount: r.providerOrders.get(payment.orderId).amount,
            currency: "INR",
            status: "captured",
          },
        },
      },
    };
    const body = JSON.stringify(event);
    for (let i = 0; i < 2; i++)
      await request("webhook-replay", "/api/webhooks/razorpay", {
        method: "POST",
        raw: true,
        body,
        headers: {
          "X-Razorpay-Event-Id": event.id,
          "X-Razorpay-Signature": createHmac(
            "sha256",
            r.env.RAZORPAY_WEBHOOK_SECRET,
          )
            .update(body)
            .digest("hex"),
        },
      });
    const state = r.db
      .prepare("SELECT status,COUNT(*) n FROM orders GROUP BY status")
      .all();
    const completed = r.db
      .prepare("SELECT COUNT(*) n FROM orders WHERE status='COMPLETED'")
      .get().n;
    const duplicates = r.db
      .prepare(
        "SELECT COUNT(*) n FROM (SELECT order_id FROM print_attempts GROUP BY order_id HAVING COUNT(*)>1)",
      )
      .get().n;
    assert.equal(completed, target);
    assert.equal(duplicates, 0);
    assert.equal(
      r.db
        .prepare(
          "SELECT COUNT(*) n FROM print_attempt_steps WHERE status<>'SUCCEEDED'",
        )
        .get().n,
      0,
    );
    // Pricing must be identical with ID ON FIRST/LAST/OFF in this fixed one-page workload.
    assert.equal(
      r.db
        .prepare("SELECT COUNT(DISTINCT total_amount_paise) n FROM orders")
        .get().n,
      1,
    );
    const tableBytes =
      r.db.prepare("PRAGMA page_count").get().page_count *
      r.db.prepare("PRAGMA page_size").get().page_size;
    const measured = snapshot();
    const cleanupStart = structuredClone(r.totals);
    const retention = new r.api.RetentionService(
      new r.api.D1RetentionRepository(r.env.DB),
      r.env.PDF_BUCKET,
      () => simulatedNow + 6 * 3600000,
    );
    for (let i = 0; i < Math.ceil(target / 5); i++) {
      const beforeQueries = r.totals.statements;
      const beforeDeletes = r.totals.r2.DELETE;
      await retention.runCleanup({ batchLimit: 100 });
      assert.ok(r.totals.statements - beforeQueries <= 32);
      assert.ok(r.totals.r2.DELETE - beforeDeletes <= 5);
    }
    assert.equal(
      r.db
        .prepare(
          "SELECT COUNT(*) n FROM uploads WHERE storage_status<>'DELETED'",
        )
        .get().n,
      0,
    );
    assert.equal(
      r.db
        .prepare(
          "SELECT COUNT(*) n FROM orders WHERE customer_phone <> '' AND customer_phone <> 'REDACTED' ",
        )
        .get().n,
      0,
    );
    const plans = [...r.queries.values()].map((q) => ({
      sql: q.sql,
      calls: q.calls,
      plan: r.db
        .prepare("EXPLAIN QUERY PLAN " + q.sql)
        .all(...Array((q.sql.match(/\?/g) || []).length).fill(null)),
    }));
    writeFileSync(
      `${output}/query-plans-${target}.json`,
      JSON.stringify(plans, null, 2) + "\n",
    );
    const used = process.cpuUsage(cpu),
      wall = (performance.now() - start) / 1000;
    assert.ok(peakRSS < thresholds.peakRSSMB);
    for (const [name, route] of Object.entries(measured.routes))
      assert.ok(
        route.hist.p95 < thresholds.p95LocalApiMs,
        `${target} orders: ${name} p95 ${route.hist.p95}ms exceeds ${thresholds.p95LocalApiMs}ms`,
      );
    return {
      target,
      status: "PASS",
      duplicateAttempts: duplicates,
      lostJobs: target - completed,
      incorrectStates: 0,
      peakRSSMB: peakRSS,
      heapMB: process.memoryUsage().heapUsed / 1048576,
      wallSeconds: wall,
      ordersPerSecond: target / wall,
      localProcessCpuMs: (used.user + used.system) / 1000,
      databaseBytes: tableBytes,
      states: state,
      measured,
      operations: r.totals,
      retentionTableChanges: r.totals.changedRows - cleanupStart.changedRows,
    };
  } finally {
    Date.now = originalNow;
    r.close();
  }
}
try {
  const branding = await regressions();
  writeFileSync(
    `${output}/branding-regression.json`,
    JSON.stringify(branding, null, 2) + "\n",
  );
  const idle = await idleDay();
  writeFileSync(
    `${output}/idle-api.json`,
    JSON.stringify(idle, null, 2) + "\n",
  );
  for (const target of [60, 800, 1000]) {
    const result = await scale(target);
    results.push(result);
    writeFileSync(
      `${output}/scale-results.json`,
      JSON.stringify(results, null, 2) + "\n",
    );
    console.log(
      JSON.stringify({
        target,
        status: result.status,
        duplicateAttempts: result.duplicateAttempts,
        lostJobs: result.lostJobs,
        peakRSSMB: result.peakRSSMB,
      }),
    );
  }
} finally {
  Date.now = originalNow;
}
