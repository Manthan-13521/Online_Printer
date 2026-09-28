import { writeFileSync, readFileSync } from "node:fs";
import { calculateCapacity } from "./calculate-free-tier-capacity.mjs";
const profile = JSON.parse(
  readFileSync("artifacts/profile-results.json", "utf8"),
);
const scale = JSON.parse(readFileSync("artifacts/scale-results.json", "utf8"));
const bytesPerFullJob =
  (scale.levels.at(-1).databaseBytes - scale.levels[0].databaseBytes) /
  (10000 - 1000);
const assumptions = {
  days: 30,
  abandonedSessionsPerJob: 3,
  uploadedFractionOfAbandoned: 0.2,
  failedPaymentsPerCompleted: 0.05,
  trackingPolls: 6,
  adminHours: 12,
  agentCount: 1,
  agentHours: 24,
  heartbeatSeconds: 30,
  adminPollSeconds: 20,
  averagePdfDecimalMB: 2,
  identificationSheet: true,
  webhooksPerCompleted: 1,
  historyMonths: 1,
  writeIndexMultiplierEstimate: 3,
};
function model(jobsPerMonth, override = {}) {
  const a = { ...assumptions, ...override },
    jobs = jobsPerMonth / 30,
    abandonUploads = a.abandonedSessionsPerJob * a.uploadedFractionOfAbandoned,
    abandonBrowse = a.abandonedSessionsPerJob - abandonUploads;
  const browserPerJob =
    6 +
    a.trackingPolls +
    abandonUploads * 4 +
    abandonBrowse +
    a.failedPaymentsPerCompleted * 6;
  const admin = 1 + 1 + 3 + (a.adminHours * 3600) / a.adminPollSeconds,
    agent = (a.agentCount * a.agentHours * 3600) / a.heartbeatSeconds;
  const printRequests = a.identificationSheet ? 6 : 3;
  const worker =
    2 * (jobs * browserPerJob + admin) +
    agent +
    jobs *
      (printRequests + a.webhooksPerCompleted + a.failedPaymentsPerCompleted) +
    (a.botDirectRps ?? 0) * 86400;
  // Local changed table rows exclude billed index writes. Additional sheet + webhook costs are estimates.
  const completedTableWrites =
    profile.observations.paidThenPrint.changedRows -
    1 +
    (a.identificationSheet ? 11 : 0) +
    2;
  const perJobTableWrites =
    completedTableWrites +
    abandonUploads * profile.observations.uploadAbandon.changedRows +
    a.failedPaymentsPerCompleted *
      profile.observations.paymentCancel.changedRows;
  const tableWrites = agent + jobs * perJobTableWrites,
    indexAwareWriteEstimate =
      agent + jobs * perJobTableWrites * a.writeIndexMultiplierEstimate;
  const uploadsPerJob = 1 + abandonUploads + a.failedPaymentsPerCompleted;
  const historyRows = jobsPerMonth * uploadsPerJob * a.historyMonths;
  const readResultFloor =
    agent * 2 +
    admin * 26 +
    jobs *
      (profile.observations.paidThenPrint.returnedRows +
        15 +
        (a.trackingPolls - 1) * 3 +
        abandonUploads * 52 +
        abandonBrowse * 9 +
        a.failedPaymentsPerCompleted * 98);
  const scanPlanReads = readResultFloor + admin * Math.max(0, historyRows - 25);
  const r2A = jobsPerMonth * uploadsPerJob,
    r2B =
      jobsPerMonth *
      (4 + abandonUploads * 2 + a.failedPaymentsPerCompleted * 3);
  const monthlyIngressGB = (r2A * a.averagePdfDecimalMB) / 1000;
  const r2GBMonthNoCleanup = monthlyIngressGB * (a.historyMonths - 1 + 31 / 60);
  return {
    jobsPerMonth,
    assumptions: a,
    workerRequestsPerDay: Math.ceil(worker),
    adminBrowserRequestsPerDay: admin,
    agentRequestsPerDay: agent,
    browserRequestsPerCompletedFlow: 6 + a.trackingPolls,
    browserRequestsPerBrowseOnly: 1,
    browserRequestsPerUploadedAbandon: 4,
    d1ReturnedRowsFloorPerDay: Math.ceil(readResultFloor),
    d1ReadsWithObservedScanPlanPerDay: Math.ceil(scanPlanReads),
    d1ChangedTableRowsPerDay: Math.ceil(tableWrites),
    d1IndexAwareWritesEstimatePerDay: Math.ceil(indexAwareWriteEstimate),
    r2ClassAPerMonth: Math.ceil(r2A),
    r2ClassBPerMonth: Math.ceil(r2B),
    r2MonthlyIngressGB: monthlyIngressGB,
    r2EndMonthOccupancyGB: monthlyIngressGB * a.historyMonths,
    r2GBMonthWithoutCleanup: r2GBMonthNoCleanup,
    d1EndMonthFullJobStorageGB:
      (jobsPerMonth * a.historyMonths * bytesPerFullJob) / 1e9,
    quotaPercent: {
      worker: worker / 1000,
      d1ReadsScanPlan: scanPlanReads / 50000,
      d1WritesEstimate: indexAwareWriteEstimate / 1000,
      r2A: r2A / 10000,
      r2B: r2B / 100000,
      r2GBMonth: r2GBMonthNoCleanup * 10,
    },
  };
}
const scenarios = [1500, 3000, 5000, 10000, 15000, 25000, 50000, 100000].map(
  (n) => model(n),
);
const cases = {
  A: scenarios[0],
  B: scenarios[1],
  C: scenarios[2],
  D: model(3000),
  E: model(1500, { abandonedSessionsPerJob: 10 }),
  F: model(1500, { agentCount: 2 }),
  G: model(1500, { botDirectRps: 1 }),
  yearAt1500: model(1500, { historyMonths: 12 }),
};
function limitAt(ratio, historyMonths = 1, withScan = true) {
  let low = 0,
    high = 1000000;
  while (high - low > 1) {
    const n = Math.floor((low + high) / 2),
      m = model(n, { historyMonths });
    const q = m.quotaPercent;
    const valid =
      q.worker <= ratio * 100 &&
      q.d1WritesEstimate <= ratio * 100 &&
      (!withScan || q.d1ReadsScanPlan <= ratio * 100) &&
      q.r2A <= ratio * 100 &&
      q.r2B <= ratio * 100 &&
      q.r2GBMonth <= ratio * 100 &&
      m.d1EndMonthFullJobStorageGB <= 0.5 * ratio;
    if (valid) low = n;
    else high = n;
  }
  return low;
}
const result = {
  labels: {
    worker:
      "MODELED; conservatively counts Pages and public-HTTPS API invocations separately. Verify actual account analytics.",
    d1Reads:
      "ESTIMATED range: returned-row floor is not billed scans; observed ANALYZE scan plan makes reads history-dependent.",
    d1Writes:
      "ESTIMATED; local table changes plus explicit 3x index sensitivity, not measured D1 billing.",
    r2: "MODELED; actual code has no cleanup. Average daily peak for evenly arriving uploads, starting empty.",
    sustainableCapacity:
      "No positive indefinite free capacity is established while R2/D1 accumulate.",
  },
  bytesPerCompletedJobMeasured: bytesPerFullJob,
  scenarios,
  cases,
  capacity: {
    theoreticalFirstMonthObservedScanPlan: limitAt(1),
    safeFirstMonthObservedScanPlan: limitAt(0.65),
    safeTwelveMonthObservedScanPlan: limitAt(0.65, 12),
    safeFirstMonthAssumingScanFixed: limitAt(0.65, 1, false),
    theoreticalSustainedInfiniteHorizon: 0,
    safeSustainedInfiniteHorizon: 0,
  },
  baseline: calculateCapacity({}),
  abuse: [0.1, 0.25, 0.5, 1].map((f) => ({
    quotaFraction: f,
    directRequests: 100000 * f,
    directRps: (100000 * f) / 86400,
    secondsBetweenDirectRequests: 86400 / (100000 * f),
    proxiedClientRequests: 50000 * f,
  })),
};
writeFileSync(
  "artifacts/capacity-observed-model.json",
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result.capacity, null, 2));
