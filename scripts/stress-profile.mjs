import { createRuntime } from "./stress-runtime.mjs";
import { workload } from "./stress-workload.mjs";
import { Histogram } from "./stress-metrics.mjs";
import { writeFileSync } from "node:fs";
const runtime = await createRuntime(`.tmp/stress/profile-${Date.now()}`),
  routes = new Map();
async function request(name, path, options = {}) {
  const route = routes.get(name) ?? {
    wall: new Histogram(),
    cpu: new Histogram(),
    statements: 0,
    returnedRows: 0,
    changedRows: 0,
    queryMs: 0,
    errors: 0,
  };
  routes.set(name, route);
  const start = performance.now(),
    cpu = process.cpuUsage();
  const response = await runtime.context.run(route, () =>
    runtime.api.routeRequest(
      new Request("https://api.audit.invalid" + path, {
        method: options.method ?? "GET",
        headers: {
          Origin: options.admin
            ? runtime.env.ADMIN_ALLOWED_ORIGIN
            : runtime.env.CUSTOMER_ALLOWED_ORIGIN,
          "Content-Type": "application/json",
          ...(options.token
            ? { Authorization: `Bearer ${options.token}` }
            : {}),
          ...(options.admin
            ? { Cookie: `__Host-printgo_admin=${runtime.adminToken}` }
            : {}),
          ...options.headers,
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      }),
      runtime.env,
    ),
  );
  const body = await response.json();
  route.wall.add(performance.now() - start);
  const used = process.cpuUsage(cpu);
  route.cpu.add((used.user + used.system) / 1000);
  if (!(options.expected ?? [200]).includes(response.status)) route.errors++;
  return body;
}
const work = workload(runtime, request);
const delta = (a, b) =>
  Object.fromEntries(
    Object.keys(b).map((k) => [
      k,
      typeof b[k] === "object" ? delta(a[k], b[k]) : b[k] - a[k],
    ]),
  );
const observations = {};
for (const [name, fn] of [
  ["browse", () => work.customer("browse")],
  ["heartbeatIdle", () => work.heartbeat(0)],
  ["uploadAbandon", () => work.customer("abandon")],
  ["paymentCancel", () => work.customer("cancel")],
  [
    "paidThenPrint",
    async () => {
      await work.customer("paid");
      await work.heartbeat(0);
    },
  ],
  [
    "adminLive",
    () => request("admin-live", "/api/admin/orders/live", { admin: true }),
  ],
]) {
  const before = structuredClone(runtime.totals);
  await fn();
  observations[name] = delta(before, runtime.totals);
}
for (let n = 0; n < 100; n++) {
  await work.customer("paid");
  await work.heartbeat(0);
  await request("admin-live", "/api/admin/orders/live", { admin: true });
  await work.abuse(2);
  await work.abuse(3);
}
writeFileSync(
  "artifacts/profile-results.json",
  JSON.stringify(
    {
      label:
        "MEASURED LOCAL: sequential process CPU includes SQLite, Request construction, body serialization and mocked services; not Cloudflare Worker CPU",
      observations,
      routes: Object.fromEntries(
        [...routes].map(([k, r]) => [
          k,
          {
            wall: r.wall.snapshot(),
            cpu: r.cpu.snapshot(),
            statements: r.statements,
            returnedRows: r.returnedRows,
            changedRows: r.changedRows,
            queryMs: r.queryMs,
            errors: r.errors,
          },
        ]),
      ),
      queries: [...runtime.queries.values()],
      operations: runtime.totals,
    },
    null,
    2,
  ) + "\n",
);
runtime.close();
