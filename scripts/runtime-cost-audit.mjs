// Local attribution only: actual Worker handlers with SQLite, mocked providers,
// no Cloudflare, Windows process, printer, real payment or production traffic.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRuntime } from "./stress-runtime.mjs";

const realNow = Date.now;
const outputDir = "docs/evidence/runtime-cost";
mkdirSync(outputDir, { recursive: true });

function totals(runtime) {
  return {
    statements: runtime.totals.statements,
    returnedRows: runtime.totals.returnedRows,
    changedRows: runtime.totals.changedRows,
    r2: { ...runtime.totals.r2 },
  };
}

function subtract(after, before) {
  return {
    statements: after.statements - before.statements,
    returnedRows: after.returnedRows - before.returnedRows,
    changedRows: after.changedRows - before.changedRows,
    r2: Object.fromEntries(
      Object.keys(after.r2).map((key) => [key, after.r2[key] - before.r2[key]]),
    ),
  };
}

function requestHarness(runtime) {
  const routes = new Map();
  let httpRequests = 0;
  async function request(operation, path, options = {}) {
    const stats = routes.get(operation) ?? {
      endpoint: operation,
      calls: 0,
      statements: 0,
      returnedRows: 0,
      changedRows: 0,
      queryMs: 0,
    };
    routes.set(operation, stats);
    const response = await runtime.context.run(stats, () =>
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
            ...(options.body ? { "Content-Type": "application/json" } : {}),
          },
          ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        }),
        runtime.env,
      ),
    );
    httpRequests++;
    stats.calls++;
    assert.ok(
      (options.expected ?? [200]).includes(response.status),
      `${operation}: unexpected HTTP ${response.status}`,
    );
    return response.json();
  }
  return {
    request,
    snapshot: () => ({
      httpRequests,
      routes: Object.fromEntries(
        [...routes].map(([name, value]) => [name, { ...value }]),
      ),
    }),
  };
}

async function simulateIdle(seconds, cadence) {
  const runtime = await createRuntime(
    `.tmp/runtime-cost/idle-${cadence}-${seconds}-${realNow()}`,
    { profileWrites: true },
  );
  const { request, snapshot } = requestHarness(runtime);
  let now = realNow();
  Date.now = () => now;
  try {
    const before = totals(runtime);
    const cleanupRuns = Math.floor(seconds / 300);
    let nextCleanupMs = 300_000;
    let nextPulseMs = 5_000;
    let idlePolls = 0;
    let pulses = 0;
    let elapsedMs = 0;
    while (Math.min(nextPulseMs, nextCleanupMs) <= seconds * 1_000) {
      const eventMs = Math.min(nextPulseMs, nextCleanupMs);
      now += eventMs - elapsedMs;
      elapsedMs = eventMs;
      if (eventMs === nextPulseMs) {
        await request("agent-job-poll", "/api/agent/pulse", {
          method: "POST",
          token: runtime.agentTokens[0],
          body: { agentVersion: "audit", operationalState: "ONLINE" },
        });
        pulses++;
        idlePolls = Math.min(idlePolls + 1, 4);
        nextPulseMs +=
          cadence === "adaptive"
            ? Math.min(30_000, 5_000 * 2 ** Math.max(0, idlePolls - 1))
            : 5_000;
      }
      if (eventMs === nextCleanupMs) {
        const stats = {
          endpoint: "retention-cleanup",
          calls: 1,
          statements: 0,
          returnedRows: 0,
          changedRows: 0,
          queryMs: 0,
        };
        const service = new runtime.api.RetentionService(
          new runtime.api.D1RetentionRepository(runtime.env.DB),
          runtime.env.PDF_BUCKET,
          () => now,
        );
        await runtime.context.run(stats, () => service.runCleanup());
        nextCleanupMs += 300_000;
      }
    }
    const delta = subtract(totals(runtime), before);
    if (cadence === "fixed") {
      const expected65 = Math.floor(seconds / 65);
      const expected60 = Math.floor(seconds / 60);
      assert.ok(
        delta.changedRows === expected65 || delta.changedRows === expected60,
        `Expected ${expected65} or ${expected60} changed rows for ${seconds}s fixed cadence, got ${delta.changedRows}`,
      );
    }
    assert.equal(snapshot().httpRequests, pulses);
    return {
      label:
        "MODELED Agent schedule through MEASURED local Worker handlers; rows are SQLite returned/changed table rows, not Cloudflare D1 billed rows",
      cadence,
      seconds,
      agentHttpRequests: pulses,
      scheduledInvocations: cleanupRuns,
      totalWorkerInvocationsIfCronIsCounted: pulses + cleanupRuns,
      ...delta,
      ...snapshot(),
    };
  } finally {
    Date.now = realNow;
    runtime.close();
  }
}

async function measureTestPrint() {
  const runtime = await createRuntime(
    `.tmp/runtime-cost/test-print-${realNow()}`,
    { profileWrites: true },
  );
  const { request, snapshot } = requestHarness(runtime);
  let now = realNow();
  Date.now = () => now;
  try {
    const printer = runtime.db
      .prepare(
        "SELECT id FROM printers WHERE windows_printer_name = 'Synthetic 0'",
      )
      .get();
    const before = totals(runtime);
    const created = await request(
      "test-print-request",
      `/api/admin/printers/${printer.id}/test-print`,
      { admin: true, method: "POST", body: {}, expected: [201] },
    );
    now += 5_000;
    const claimed = await request(
      "test-print-claim-with-next-poll",
      "/api/agent/pulse",
      {
        method: "POST",
        token: runtime.agentTokens[0],
        body: { agentVersion: "audit", operationalState: "ONLINE" },
      },
    );
    assert.equal(
      claimed.data.nextCommand.commandId,
      created.data.testPrint.commandId,
    );
    const reportPath = `/api/agent/commands/${created.data.testPrint.commandId}/report`;
    await request("test-print-submitted", reportPath, {
      method: "POST",
      token: runtime.agentTokens[0],
      body: { status: "SUBMITTED", spoolerJobId: "451" },
    });
    await request("test-print-result", reportPath, {
      method: "POST",
      token: runtime.agentTokens[0],
      body: { status: "SUCCEEDED", spoolerJobId: "451" },
    });
    await request(
      "test-print-admin-status",
      `/api/admin/printers/${printer.id}/test-print`,
      { admin: true },
    );
    const delta = subtract(totals(runtime), before);
    assert.equal(delta.changedRows, 5);
    assert.deepEqual(delta.r2, { PUT: 0, HEAD: 0, GET: 0, DELETE: 0 });
    return {
      label:
        "MEASURED local current handlers; excludes the already-scheduled Agent poll and optional repeated Admin status polls",
      commandId: created.data.testPrint.commandId,
      additionalHttpRequestsBeyondNormalAgentPolling: 4,
      normalPollUsedToClaim: 1,
      ...delta,
      ...snapshot(),
    };
  } finally {
    Date.now = realNow;
    runtime.close();
  }
}

async function measureUiPolls() {
  const runtime = await createRuntime(
    `.tmp/runtime-cost/ui-polls-${realNow()}`,
    { profileWrites: true },
  );
  const { request, snapshot } = requestHarness(runtime);
  try {
    const before = totals(runtime);
    await request("admin-dashboard-poll", "/api/admin/dashboard", {
      admin: true,
    });
    await request("admin-printer-page-poll", "/api/admin/printers", {
      admin: true,
    });
    await request("admin-live-orders-poll", "/api/admin/orders/live", {
      admin: true,
    });
    return {
      label:
        "MEASURED local empty-shop handler samples; visible tabs only, hidden tabs make zero calls",
      ...subtract(totals(runtime), before),
      ...snapshot(),
    };
  } finally {
    runtime.close();
  }
}

async function measurePrinterSync() {
  const runtime = await createRuntime(
    `.tmp/runtime-cost/printer-sync-${realNow()}`,
    { profileWrites: true },
  );
  const { request, snapshot } = requestHarness(runtime);
  let now = realNow() + 60_000;
  Date.now = () => now;
  try {
    const printer = runtime.db
      .prepare(
        "SELECT id FROM printers WHERE windows_printer_name = 'Synthetic 0'",
      )
      .get();
    runtime.db
      .prepare(
        "UPDATE installation SET default_production_printer_id = ? WHERE id = 1",
      )
      .run(printer.id);
    const before = totals(runtime);
    await request("printer-state-sync", "/api/agent/heartbeat", {
      method: "POST",
      token: runtime.agentTokens[0],
      body: {
        agentVersion: "audit",
        operationalState: "ONLINE",
        printers: [
          {
            windowsPrinterName: "Synthetic 0",
            displayName: "Synthetic 0",
            isDefault: true,
            status: "ONLINE",
            statusReason: null,
            capabilities: {
              colour: false,
              duplex: false,
              paperSizes: ["A4"],
            },
            isEligibleForProductionPrint: true,
            isVirtual: false,
            portName: null,
            driverName: null,
          },
        ],
      },
    });
    return {
      label:
        "MEASURED local unchanged full printer report after one minute; stable cycles use /pulse instead",
      ...subtract(totals(runtime), before),
      ...snapshot(),
    };
  } finally {
    Date.now = realNow;
    runtime.close();
  }
}

const idleBefore = [];
const idleAfter = [];
for (const seconds of [600, 3_600, 54_000]) {
  idleBefore.push(await simulateIdle(seconds, "fixed"));
  idleAfter.push(await simulateIdle(seconds, "adaptive"));
}
const testPrint = await measureTestPrint();
const uiPolls = await measureUiPolls();
const printerSync = await measurePrinterSync();
const result = {
  generatedAt: new Date().toISOString(),
  scope:
    "Local actual Worker routes with SQLite and mocked providers. No Cloudflare telemetry, Windows, physical printer, R2 network or payment provider.",
  idleBefore,
  idleAfter,
  testPrint,
  uiPolls,
  printerSync,
};
writeFileSync(
  `${outputDir}/runtime-cost.json`,
  `${JSON.stringify(result, null, 2)}\n`,
);
console.log(JSON.stringify(result, null, 2));
