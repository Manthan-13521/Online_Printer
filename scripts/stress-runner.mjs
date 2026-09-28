#!/usr/bin/env node
import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync, appendFileSync, renameSync } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { execFileSync } from "node:child_process";
import { createRuntime } from "./stress-runtime.mjs";
import { Histogram } from "./stress-metrics.mjs";
import { workload } from "./stress-workload.mjs";
const { values } = parseArgs({
  options: {
    duration: { type: "string", default: "7200" },
    concurrency: { type: "string", default: "8" },
    rps: { type: "string", default: "1" },
    scenario: { type: "string", default: "soak" },
    "base-url": { type: "string", default: "https://api.audit.invalid" },
    local: { type: "boolean", default: true },
    staging: { type: "boolean", default: false },
    output: { type: "string", default: "artifacts/soak" },
    agents: { type: "string", default: "1" },
  },
});
if (values.staging || values["base-url"] !== "https://api.audit.invalid")
  throw new Error(
    "Remote mode deliberately locked: isolated target and explicit remote budget must be reviewed first.",
  );
const duration = Number(values.duration),
  concurrency = Number(values.concurrency),
  baseRps = Number(values.rps),
  agentCount = Number(values.agents);
if (
  !Number.isFinite(duration) ||
  duration <= 0 ||
  duration > 14400 ||
  !Number.isInteger(concurrency) ||
  concurrency < 1 ||
  concurrency > 250 ||
  !Number.isFinite(baseRps) ||
  baseRps <= 0 ||
  baseRps > 100 ||
  !Number.isInteger(agentCount) ||
  agentCount < 1 ||
  agentCount > 5
)
  throw new Error("Invalid bounded workload settings");
mkdirSync("artifacts", { recursive: true });
const runtime = await createRuntime(`.tmp/stress/${Date.now()}`);
const hist = new Histogram(),
  routes = new Map(),
  statuses = {};
let requests = 0,
  successes = 0,
  failures = 0,
  timeouts = 0,
  flows = 0,
  flowErrors = 0,
  inFlight = 0,
  peakConcurrency = 0,
  skipped = 0,
  sequence = 0,
  currentScenario = "warm-up",
  peakMemoryMB = 0;
const failureSamples = [];
const start = performance.now();
const startTime = new Date().toISOString();
const cpuStart = process.cpuUsage();
const heapStart = process.memoryUsage().heapUsed;
const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();
const pending = new Set();
async function request(name, path, options = {}) {
  const route = routes.get(name) ?? {
    hist: new Histogram(),
    statements: 0,
    returnedRows: 0,
    changedRows: 0,
    queryMs: 0,
    cpuUs: 0,
    failures: 0,
  };
  routes.set(name, route);
  const t = performance.now();
  const cpu = process.cpuUsage();
  let status = 0;
  let result = {};
  try {
    const response = await runtime.context.run(route, () =>
      runtime.api.routeRequest(
        new Request(values["base-url"] + path, {
          method: options.method ?? "GET",
          headers: {
            Origin: options.admin
              ? runtime.env.ADMIN_ALLOWED_ORIGIN
              : runtime.env.CUSTOMER_ALLOWED_ORIGIN,
            ...(options.token
              ? { Authorization: `Bearer ${options.token}` }
              : {}),
            ...(options.admin
              ? { Cookie: `__Host-printgo_admin=${runtime.adminToken}` }
              : {}),
            ...(options.body ? { "Content-Type": "application/json" } : {}),
            ...options.headers,
          },
          ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        }),
        runtime.env,
      ),
    );
    status = response.status;
    result = await response.json();
    if (!(options.expected ?? [200]).includes(status)) {
      failures++;
      route.failures++;
      if (failureSamples.length < 30)
        failureSamples.push({ route: name, status, code: result.error?.code });
    } else successes++;
  } catch (error) {
    failures++;
    route.failures++;
    if (failureSamples.length < 30)
      failureSamples.push({ route: name, status, error: error.name });
  }
  const elapsed = performance.now() - t;
  if (elapsed > 30000) timeouts++;
  route.hist.add(elapsed);
  hist.add(elapsed);
  const used = process.cpuUsage(cpu);
  route.cpuUs += used.user + used.system;
  statuses[status] = (statuses[status] ?? 0) + 1;
  requests++;
  return result;
}
const work = workload(runtime, request);
function schedule(fn) {
  if (inFlight >= concurrency) {
    skipped++;
    return;
  }
  inFlight++;
  peakConcurrency = Math.max(peakConcurrency, inFlight);
  const task = fn()
    .catch((error) => {
      flowErrors++;
      if (failureSamples.length < 30)
        failureSamples.push({ flow: currentScenario, error: error.message });
    })
    .finally(() => {
      inFlight--;
      pending.delete(task);
    });
  pending.add(task);
}
let longestLoopGapMs = 0;
let previousLoopTime = start;
let lastRequests = 0,
  lastSnapshot = start,
  lastCpu = cpuStart;
function snapshot(final = false) {
  const now = performance.now(),
    elapsedSeconds = (now - start) / 1000,
    mem = process.memoryUsage(),
    cpu = process.cpuUsage(),
    delta = cpu.user - lastCpu.user + cpu.system - lastCpu.system;
  peakMemoryMB = Math.max(peakMemoryMB, mem.rss / 1048576);
  const output = {
    startTime,
    endTime: final ? new Date().toISOString() : null,
    elapsedSeconds,
    requests,
    successes,
    failures,
    timeouts,
    flows,
    flowErrors,
    ...hist.snapshot(),
    currentRps: (requests - lastRequests) / ((now - lastSnapshot) / 1000),
    memoryMB: mem.rss / 1048576,
    heapUsedMB: mem.heapUsed / 1048576,
    heapGrowthMB: (mem.heapUsed - heapStart) / 1048576,
    peakMemoryMB,
    cpuPercent: delta / ((now - lastSnapshot) * 10),
    cpuMsPerRequest: requests
      ? (cpu.user - cpuStart.user + cpu.system - cpuStart.system) /
        1000 /
        requests
      : 0,
    eventLoopDelayMs: {
      p95: loop.percentile(95) / 1e6,
      p99: loop.percentile(99) / 1e6,
      max: loop.max / 1e6,
    },
    activeResources: process
      .getActiveResourcesInfo()
      .reduce((a, x) => ((a[x] = (a[x] ?? 0) + 1), a), {}),
    inFlight,
    peakConcurrency,
    longestLoopGapMs,
    skipped,
    scenario: currentScenario,
    statuses,
    operations: runtime.totals,
    workerCpu:
      "NOT VERIFIED: Node CPU includes SQLite, load generator and mocks",
    d1RowsScanned: "NOT VERIFIED: returnedRows are not billable rows scanned",
    gitCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
  };
  writeFileSync(
    `${values.output}-progress.json.tmp`,
    JSON.stringify(output, null, 2) + "\n",
  );
  renameSync(
    `${values.output}-progress.json.tmp`,
    `${values.output}-progress.json`,
  );
  lastRequests = requests;
  lastSnapshot = now;
  lastCpu = cpu;
  return output;
}
writeFileSync(`${values.output}-checkpoints.jsonl`, "");
// Thresholds are frozen before first request; expected rejection responses are successes.
writeFileSync(
  `${values.output}-acceptance.json`,
  JSON.stringify(
    {
      duration,
      unexpectedErrorRateMaximum: 0.001,
      noCrashes: true,
      noDuplicateActiveAttempts: true,
      latency: "Report per route; no universal threshold",
      memory:
        "Investigate recovery-period growth; retained SQLite data is expected",
      concurrency,
      baseFlowStartsPerSecond: baseRps,
      agentCount,
      remoteRequests: 0,
    },
    null,
    2,
  ) + "\n",
);
let nextFlow = start,
  nextAdmin = start,
  nextHeartbeat = start,
  nextSnapshot = start + 10000,
  nextCheckpoint = start + 300000;
while (performance.now() - start < duration * 1000) {
  const now = performance.now();
  longestLoopGapMs = Math.max(longestLoopGapMs, now - previousLoopTime);
  previousLoopTime = now;
  const elapsed = (now - start) / 1000;
  currentScenario =
    values.scenario === "soak"
      ? elapsed < 600
        ? "warm-up"
        : elapsed < 6000
          ? "steady"
          : elapsed < 6600
            ? "burst"
            : elapsed < 6900
              ? "abuse"
              : "recovery"
      : values.scenario;
  const rate =
    baseRps *
    (currentScenario === "burst" ? 10 : currentScenario === "abuse" ? 20 : 1);
  if (now >= nextFlow) {
    const n = sequence++;
    schedule(async () => {
      if (currentScenario === "abuse" || values.scenario === "abuse")
        await work.abuse(n);
      else {
        await work.customer(
          n % 10 < 5
            ? "browse"
            : n % 10 < 7
              ? "abandon"
              : n % 10 === 7
                ? "cancel"
                : "paid",
        );
        flows++;
      }
    });
    nextFlow = now + 1000 / rate;
  }
  if (now >= nextAdmin) {
    schedule(() =>
      request("admin-live", "/api/admin/orders/live", { admin: true }),
    );
    nextAdmin = now + 20000;
  }
  if (now >= nextHeartbeat) {
    for (let i = 0; i < agentCount; i++) schedule(() => work.heartbeat(i));
    nextHeartbeat = now + 30000;
  }
  if (now >= nextSnapshot) {
    snapshot();
    nextSnapshot = now + 10000;
  }
  if (now >= nextCheckpoint) {
    const point = snapshot();
    appendFileSync(
      `${values.output}-checkpoints.jsonl`,
      JSON.stringify(point) + "\n",
    );
    console.log(
      JSON.stringify({
        elapsedSeconds: point.elapsedSeconds,
        requests,
        failures,
        flowErrors,
        scenario: currentScenario,
      }),
    );
    nextCheckpoint += 300000;
  }
  await delay(Math.min(25, Math.max(1, nextFlow - performance.now())));
}
await Promise.all(pending);
loop.disable();
const final = snapshot(true);
appendFileSync(
  `${values.output}-checkpoints.jsonl`,
  JSON.stringify(final) + "\n",
);
const duplicateAttempts = runtime.db
  .prepare(
    "SELECT COUNT(*) AS count FROM (SELECT order_id FROM print_attempts WHERE status IN ('CREATED','SUBMITTING','SPOOLING','PRINTING','BLOCKED') GROUP BY order_id HAVING COUNT(*)>1)",
  )
  .get();
const orderStates = runtime.db
  .prepare("SELECT status,COUNT(*) AS count FROM orders GROUP BY status")
  .all();
writeFileSync(
  `${values.output}-results.json`,
  JSON.stringify(
    {
      ...final,
      failureSamples,
      duplicateAttempts,
      orderStates,
      routes: Object.fromEntries(
        [...routes].map(([key, r]) => [
          key,
          {
            ...r,
            hist: r.hist.snapshot(),
            overlappingProcessCpuMs: r.cpuUs / 1000,
          },
        ]),
      ),
      queries: [...runtime.queries.values()],
    },
    null,
    2,
  ) + "\n",
);
runtime.close();
console.log(
  JSON.stringify({
    complete: true,
    elapsedSeconds: final.elapsedSeconds,
    requests,
    failures,
    flowErrors,
  }),
);
if (failures || flowErrors) process.exitCode = 1;
