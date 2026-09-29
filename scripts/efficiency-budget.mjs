import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
// MODELED envelopes, not Cloudflare quota telemetry. Defaults cover a 15h shop day.
export function efficiencyBudget(ordersPerDay = 60) {
  const hours = 15,
    days = 30,
    visits = ordersPerDay * 4,
    failed = ordersPerDay * 0.05;
  const agentPulses = (hours * 3600) / 5,
    heartbeatWrites = hours * 60;
  // Worst case: dashboard AND Live Orders visible for the whole day.
  const dashboard = (hours * 3600) / 30,
    live = (hours * 3600) / 20;
  // 25/order includes draft/quote/payment + webhook, two print steps, eight tracking reads,
  // and a modest retry allowance; add CORS preflights explicitly below.
  const workers = Math.ceil(
    agentPulses +
      dashboard +
      live +
      25 * ordersPerDay +
      3 * ordersPerDay +
      visits +
      failed * 5 +
      15 * 90,
  );
  // A deliberately padded row-read allowance includes current queue/history and index visits.
  // The workload measured ~130 returned rows/order; that is NOT billable rows scanned.
  const reads = Math.ceil(
    agentPulses * 12 +
      dashboard * (ordersPerDay + 30) +
      live * 110 +
      ordersPerDay * 400 +
      visits * 12 +
      288 * (30 + ordersPerDay),
  );
  // V2 measured two-step table writes fell 52 -> 45, retaining all forensic events.
  // Preserve the previous index/variation multiplier: ceil(250 * 45/52) = 217; add 4 for two new FK indexes across event insert/update.
  // This remains a modeled allowance, NOT measured D1 billing or a proven bound.
  const writes = Math.ceil(
    heartbeatWrites * 3 + ordersPerDay * 221 + failed * 80 + 500,
  );
  const classA = Math.ceil((ordersPerDay + failed) * days + 30);
  // Upload HEAD+range GET, payment HEAD, document GET; identification sheets never touch R2.
  const classB = Math.ceil((ordersPerDay * 4 + failed * 3 + visits) * days);
  const normalGb =
    ((ordersPerDay / 15) * 2 +
      (failed / 15) * 0.5 * 2 +
      ordersPerDay * 0.01 * 2) /
    1024;
  const backlogGb = (ordersPerDay * 2) / 1024;
  const limits = {
    workers: 100000,
    reads: 5000000,
    writes: 100000,
    classA: 1000000,
    classB: 10000000,
    r2GB: 10,
  };
  const use = {
    workers,
    reads,
    writes,
    classA,
    classB,
    r2GB: Number(normalGb.toFixed(4)),
  };
  return {
    label:
      "MODELED (read/write envelopes require deployed D1 metadata validation)",
    ordersPerDay,
    hours,
    assumptions: {
      visits,
      failed,
      averagePdfMiB: 2,
      trackingPolls: 8,
      activeQueueRowsAtMost: 100,
      dashboardAndLiveBothVisible: true,
      preflightRequests: 15 * 90,
      retentionCronRuns: 288,
      modeledIndexedWritesPerOrder: 221,
      measuredTableWritesPerTwoStepOrder: 45,
      baselineTableWritesPerTwoStepOrder: 52,
    },
    agentPulses,
    heartbeatTableWrites: heartbeatWrites,
    metrics: use,
    headroomPercent: Object.fromEntries(
      Object.entries(use).map(([k, v]) => [
        k,
        Number(((1 - v / limits[k]) * 100).toFixed(2)),
      ]),
    ),
    operatorWarnings: ["workers", "reads", "writes"].map((resource) => ({
      resource,
      thresholdPercent: 65,
      modeledUsagePercent: Number(
        ((use[resource] / limits[resource]) * 100).toFixed(2),
      ),
      triggered: use[resource] >= limits[resource] * 0.65,
      action:
        "Developer: compare production counters, subtract background/CLI traffic, and review capacity before growth. Never remove durable print boundaries to meet quotas.",
    })),
    twentyFourHourBacklogGB: Number(backlogGb.toFixed(4)),
    database: {
      perDatabaseLimitMiB: 500,
      modeledRetainedKiBPerOrder: 8,
      approxDaysToLimit: Math.floor((500 * 1024) / (ordersPerDay * 8)),
      warning:
        "Financial and audit history accumulates; no indefinite storage guarantee.",
    },
  };
}
if (process.argv[1]?.endsWith("efficiency-budget.mjs")) {
  const results = [60, 800, 1000].map((n) => efficiencyBudget(n));
  mkdirSync("docs/evidence/efficiency-v2", { recursive: true });
  const measured = JSON.parse(
    readFileSync("docs/evidence/efficiency-v2/idle-api.json", "utf8"),
  );
  writeFileSync(
    "docs/evidence/efficiency-v2/capacity-model.json",
    JSON.stringify(
      {
        idleMeasured: {
          requests: measured.httpRequests,
          changedTableRows: measured.tableRowsChanged,
          statements: measured.statements,
        },
        scenarios: results,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify(results, null, 2));
}
