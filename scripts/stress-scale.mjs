import { writeFileSync } from "node:fs";
import { createRuntime } from "./stress-runtime.mjs";
import { workload } from "./stress-workload.mjs";
import { Histogram } from "./stress-metrics.mjs";
const runtime = await createRuntime(`.tmp/stress/scale-${Date.now()}`);
const routes = new Map(),
  claims = new Map(),
  failures = [];
let count = 0,
  duplicateClaims = 0,
  peakRSS = 0;
async function request(name, path, options = {}) {
  const start = performance.now();
  const response = await runtime.api.routeRequest(
    new Request("https://api.audit.invalid" + path, {
      method: options.method ?? "GET",
      headers: {
        Origin: options.admin
          ? runtime.env.ADMIN_ALLOWED_ORIGIN
          : runtime.env.CUSTOMER_ALLOWED_ORIGIN,
        "Content-Type": "application/json",
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.admin
          ? { Cookie: `__Host-printgo_admin=${runtime.adminToken}` }
          : {}),
        ...options.headers,
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    }),
    runtime.env,
  );
  const body = await response.json();
  const h = routes.get(name) ?? new Histogram();
  h.add(performance.now() - start);
  routes.set(name, h);
  count++;
  if (
    !(options.expected ?? [200]).includes(response.status) &&
    failures.length < 50
  )
    failures.push({
      route: name,
      status: response.status,
      code: body.error?.code,
    });
  if (body.data?.printJob) {
    const job = body.data.printJob,
      owner = runtime.agentTokens.indexOf(options.token);
    const old = claims.get(job.orderId);
    if (old !== undefined && old !== owner) duplicateClaims++;
    claims.set(job.orderId, owner);
  }
  return body;
}
const work = workload(runtime, request),
  levels = [],
  startTime = new Date().toISOString();
let completed = 0;
for (const target of [1000, 2500, 5000, 10000]) {
  const start = performance.now(),
    cpuStart = process.cpuUsage(),
    requestsStart = count;
  while (completed < target) {
    const batch = Math.min(25, target - completed);
    // Refresh simulated agents before creating payments; then pay concurrently.
    await Promise.all(Array.from({ length: 5 }, (_, i) => work.heartbeat(i)));
    await Promise.all(
      Array.from({ length: batch }, () => work.customer("paid")),
    );
    await Promise.all(
      Array.from({ length: batch * 3 }, () => work.customer("browse")),
    );
    for (let j = 0; j < Math.ceil(batch / 5); j++)
      await Promise.all(Array.from({ length: 5 }, (_, i) => work.heartbeat(i)));
    completed += batch;
    peakRSS = Math.max(peakRSS, process.memoryUsage().rss / 1048576);
    await request("admin-live", "/api/admin/orders/live", { admin: true });
    if (completed % 1000 === 0)
      console.log(
        JSON.stringify({
          completed,
          requests: count,
          failures: failures.length,
          duplicateClaims,
          peakRSS,
        }),
      );
  }
  const cpu = process.cpuUsage(cpuStart),
    elapsed = (performance.now() - start) / 1000;
  levels.push({
    targetJobsPerDay: target,
    incrementalWallSeconds: elapsed,
    incrementalRequests: count - requestsStart,
    incrementalRps: (count - requestsStart) / elapsed,
    processCpuMs: (cpu.user + cpu.system) / 1000,
    peakRSSMB: peakRSS,
    states: runtime.db
      .prepare("SELECT status,COUNT(*) n FROM orders GROUP BY status")
      .all(),
    routes: Object.fromEntries([...routes].map(([k, h]) => [k, h.snapshot()])),
    databaseBytes:
      Number(runtime.db.prepare("PRAGMA page_count").get().page_count) *
      Number(runtime.db.prepare("PRAGMA page_size").get().page_size),
  });
  writeFileSync(
    "artifacts/scale-progress.json",
    JSON.stringify(
      { completed, count, failures, duplicateClaims, levels },
      null,
      2,
    ) + "\n",
  );
  if (duplicateClaims) break;
}
writeFileSync(
  "artifacts/scale-results.json",
  JSON.stringify(
    {
      startTime,
      endTime: new Date().toISOString(),
      completed,
      count,
      failures,
      duplicateClaims,
      levels,
      operations: runtime.totals,
      limits:
        "In-process Node plus SQLite; 5 simulated agents claim immediately to measure code throughput. This compresses heartbeat cadence and excludes real printer/provider/network time.",
    },
    null,
    2,
  ) + "\n",
);
runtime.close();
