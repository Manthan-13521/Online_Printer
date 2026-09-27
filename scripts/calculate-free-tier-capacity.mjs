#!/usr/bin/env node
/**
 * PrintGo V2 — Free-Tier Capacity and Resource Calculator
 * Evaluates shop workloads against Cloudflare Free-tier resource limits.
 */

export const CLOUDFLARE_FREE_LIMITS = {
  workersRequestsPerDay: 100_000,
  workersCpuMsPerRequest: 10,
  d1RowsReadPerDay: 5_000_000,
  d1RowsWrittenPerDay: 100_000,
  d1StorageGb: 5,
  r2ClassAOpsPerMonth: 1_000_000,
  r2ClassBOpsPerMonth: 10_000_000,
  r2StorageGbMonth: 10,
};

export function calculateCapacity(input) {
  const {
    completedJobsPerMonth = 1500,
    abandonedSessionsPerMonth = 4500,
    customerConfigCallsPerSession = 1,
    trackingPollsPerJob = 6,
    adminVisibleHoursPerDay = 12,
    adminPollIntervalSeconds = 20,
    agentCount = 1,
    agentHeartbeatSeconds = 30,
    averagePdfMb = 2,
    failedPaymentPercent = 5,
    unresolvedFailurePercent = 1,
  } = input;

  const daysPerMonth = 30;
  const completedJobsPerDay = completedJobsPerMonth / daysPerMonth;
  const abandonedSessionsPerDay = abandonedSessionsPerMonth / daysPerMonth;
  const failedJobsPerDay = completedJobsPerDay * (failedPaymentPercent / 100);
  const unresolvedFailuresPerDay =
    completedJobsPerDay * (unresolvedFailurePercent / 100);

  // 1. Customer dynamic requests
  // Abandoned session: 1 config call (if not cached at edge/browser)
  const customerAbandonedWorkerReqPerDay =
    abandonedSessionsPerDay * customerConfigCallsPerSession;

  // Completed job requests:
  // config (1) + createDraft (1) + authorizeUpload (1) + completeUpload (1) + quote (1) +
  // createPayment (1) + verifyPayment (1) + trackingPolls
  const customerJobWorkerReqPerDay =
    completedJobsPerDay * (7 + trackingPollsPerJob) + failedJobsPerDay * 3;

  // 2. Admin dynamic requests
  // Live orders polling only when visible
  const adminPollsPerHour = 3600 / adminPollIntervalSeconds;
  const adminWorkerReqPerDay = adminVisibleHoursPerDay * adminPollsPerHour;

  // 3. Agent dynamic requests
  // Heartbeat runs 24 hours (or 16h)
  const agentHeartbeatsPerHour = 3600 / agentHeartbeatSeconds;
  const agentHoursPerDay = 24;
  const agentWorkerReqPerDay =
    agentCount * agentHoursPerDay * agentHeartbeatsPerHour;

  // Total Worker requests
  const totalWorkerRequestsPerDay = Math.round(
    customerAbandonedWorkerReqPerDay +
      customerJobWorkerReqPerDay +
      adminWorkerReqPerDay +
      agentWorkerReqPerDay,
  );
  const totalWorkerRequestsPerMonth = totalWorkerRequestsPerDay * daysPerMonth;

  // 4. D1 reads and writes
  // D1 reads:
  // Abandoned: ~2 reads per session (config + rates)
  // Completed job: ~20 reads total (draft, upload check, quote bands, payment read, tracking, claim)
  // Admin Live Orders: ~25 rows scanned per bounded poll
  // Agent Heartbeat: ~2 rows read per heartbeat (agent + printer)
  const d1ReadsPerDay = Math.round(
    abandonedSessionsPerDay * 2 +
      completedJobsPerDay * 20 +
      failedJobsPerDay * 4 +
      adminWorkerReqPerDay * 25 +
      agentWorkerReqPerDay * 2,
  );

  // D1 writes:
  // Completed job: ~9 writes (order draft, upload, quote, payment attempt, payment verified, order queued, claim step, finish, event)
  // Failed job: ~3 writes
  // Agent Heartbeat: 1 write per heartbeat when unchanged (agents.last_heartbeat_at_ms)
  const d1WritesPerDay = Math.round(
    completedJobsPerDay * 9 + failedJobsPerDay * 3 + agentWorkerReqPerDay * 1,
  );

  // 5. R2 operations per month
  // Class A (PUT):
  // Direct client PUT per uploaded PDF (completed + failed)
  const r2ClassAOpsPerMonth = Math.round(
    (completedJobsPerDay + failedJobsPerDay) * daysPerMonth,
  );

  // Class B (HEAD, GET):
  // Verification HEAD (1) + Agent download GET (1)
  const r2ClassBOpsPerMonth = Math.round(
    completedJobsPerDay * 2 * daysPerMonth,
  );

  // 6. R2 storage
  // Active transient storage:
  // Completed PDFs deleted after 1 hour: (completedJobsPerDay / 12 hours) * averagePdfMb
  // Unresolved failures retained for up to 24 hours: unresolvedFailuresPerDay * averagePdfMb
  // Transient uploads (10-30 min): ~2 * averagePdfMb
  const steadyStateJobsPerHour = completedJobsPerDay / 12;
  const activeCompletedPdfMb = steadyStateJobsPerHour * 1 * averagePdfMb;
  const activeUnresolvedFailurePdfMb =
    unresolvedFailuresPerDay * 1 * averagePdfMb;
  const activeTransientUploadMb = 2 * averagePdfMb;
  const totalSteadyStateStorageMb =
    activeCompletedPdfMb +
    activeUnresolvedFailurePdfMb +
    activeTransientUploadMb;
  const totalSteadyStateStorageGb = totalSteadyStateStorageMb / 1024;

  // Stress burst storage (e.g. 5x active queue or multiple large files)
  const stressStorageMb = totalSteadyStateStorageMb * 5;

  function evaluate(used, limit) {
    const ratio = used / limit;
    const percentage = (ratio * 100).toFixed(2);
    let status = "SAFE";
    if (ratio > 0.7) status = "OVER_BUDGET";
    else if (ratio > 0.4) status = "WARNING";
    return { used, limit, percentage: `${percentage}%`, status };
  }

  return {
    metrics: {
      workerRequestsPerDay: evaluate(
        totalWorkerRequestsPerDay,
        CLOUDFLARE_FREE_LIMITS.workersRequestsPerDay,
      ),
      d1RowsReadPerDay: evaluate(
        d1ReadsPerDay,
        CLOUDFLARE_FREE_LIMITS.d1RowsReadPerDay,
      ),
      d1RowsWrittenPerDay: evaluate(
        d1WritesPerDay,
        CLOUDFLARE_FREE_LIMITS.d1RowsWrittenPerDay,
      ),
      r2ClassAOpsPerMonth: evaluate(
        r2ClassAOpsPerMonth,
        CLOUDFLARE_FREE_LIMITS.r2ClassAOpsPerMonth,
      ),
      r2ClassBOpsPerMonth: evaluate(
        r2ClassBOpsPerMonth,
        CLOUDFLARE_FREE_LIMITS.r2ClassBOpsPerMonth,
      ),
      r2StorageGbMonth: evaluate(
        Number(totalSteadyStateStorageGb.toFixed(4)),
        CLOUDFLARE_FREE_LIMITS.r2StorageGbMonth,
      ),
    },
    raw: {
      totalWorkerRequestsPerDay,
      totalWorkerRequestsPerMonth,
      d1ReadsPerDay,
      d1WritesPerDay,
      r2ClassAOpsPerMonth,
      r2ClassBOpsPerMonth,
      totalSteadyStateStorageMb: Number(totalSteadyStateStorageMb.toFixed(2)),
      stressStorageMb: Number(stressStorageMb.toFixed(2)),
    },
  };
}

export function formatScenarioReport(name, input) {
  const result = calculateCapacity(input);
  const m = result.metrics;

  let out = `================================================================================\n`;
  out += `CAPACITY REPORT: ${name}\n`;
  out += `================================================================================\n`;
  out += `Inputs: ${JSON.stringify(input, null, 2)}\n\n`;
  out += `RESOURCE                    ESTIMATED USAGE     FREE LIMIT       % QUOTA   STATUS\n`;
  out += `--------------------------------------------------------------------------------\n`;
  out += `Workers Requests/day:       ${String(m.workerRequestsPerDay.used).padEnd(19)} ${String(m.workerRequestsPerDay.limit).padEnd(16)} ${m.workerRequestsPerDay.percentage.padEnd(9)} ${m.workerRequestsPerDay.status}\n`;
  out += `D1 Rows Read/day:           ${String(m.d1RowsReadPerDay.used).padEnd(19)} ${String(m.d1RowsReadPerDay.limit).padEnd(16)} ${m.d1RowsReadPerDay.percentage.padEnd(9)} ${m.d1RowsReadPerDay.status}\n`;
  out += `D1 Rows Written/day:        ${String(m.d1RowsWrittenPerDay.used).padEnd(19)} ${String(m.d1RowsWrittenPerDay.limit).padEnd(16)} ${m.d1RowsWrittenPerDay.percentage.padEnd(9)} ${m.d1RowsWrittenPerDay.status}\n`;
  out += `R2 Class A Ops/month:       ${String(m.r2ClassAOpsPerMonth.used).padEnd(19)} ${String(m.r2ClassAOpsPerMonth.limit).padEnd(16)} ${m.r2ClassAOpsPerMonth.percentage.padEnd(9)} ${m.r2ClassAOpsPerMonth.status}\n`;
  out += `R2 Class B Ops/month:       ${String(m.r2ClassBOpsPerMonth.used).padEnd(19)} ${String(m.r2ClassBOpsPerMonth.limit).padEnd(16)} ${m.r2ClassBOpsPerMonth.percentage.padEnd(9)} ${m.r2ClassBOpsPerMonth.status}\n`;
  out += `R2 Storage (GB-month):      ${String(m.r2StorageGbMonth.used).padEnd(19)} ${String(m.r2StorageGbMonth.limit).padEnd(16)} ${m.r2StorageGbMonth.percentage.padEnd(9)} ${m.r2StorageGbMonth.status}\n`;
  out += `--------------------------------------------------------------------------------\n`;
  out += `Steady-State R2 Storage:    ${result.raw.totalSteadyStateStorageMb} MB\n`;
  out += `Stress Burst R2 Storage:    ${result.raw.stressStorageMb} MB\n`;
  out += `================================================================================\n\n`;
  return out;
}

if (process.argv[1]?.endsWith("calculate-free-tier-capacity.mjs")) {
  const scenarios = [
    {
      name: "SCENARIO A — NORMAL (1,500 jobs/mo, 1 Agent, 2 MB PDF)",
      input: {
        completedJobsPerMonth: 1500,
        abandonedSessionsPerMonth: 4500,
        customerConfigCallsPerSession: 1,
        trackingPollsPerJob: 6,
        adminVisibleHoursPerDay: 12,
        adminPollIntervalSeconds: 20,
        agentCount: 1,
        agentHeartbeatSeconds: 30,
        averagePdfMb: 2,
        failedPaymentPercent: 5,
        unresolvedFailurePercent: 1,
      },
    },
    {
      name: "SCENARIO B — STRESS (1,500 jobs/mo, 7,500 abandoned, 2 Agents, 5 MB PDF, frequent tracking)",
      input: {
        completedJobsPerMonth: 1500,
        abandonedSessionsPerMonth: 7500,
        customerConfigCallsPerSession: 2,
        trackingPollsPerJob: 12,
        adminVisibleHoursPerDay: 12,
        adminPollIntervalSeconds: 20,
        agentCount: 2,
        agentHeartbeatSeconds: 30,
        averagePdfMb: 5,
        failedPaymentPercent: 10,
        unresolvedFailurePercent: 2,
      },
    },
    {
      name: "SCENARIO C — HIGH ACTIVITY DAY (100 jobs/day, heavy admin, 2 Agents)",
      input: {
        completedJobsPerMonth: 3000,
        abandonedSessionsPerMonth: 9000,
        customerConfigCallsPerSession: 1,
        trackingPollsPerJob: 8,
        adminVisibleHoursPerDay: 16,
        adminPollIntervalSeconds: 15,
        agentCount: 2,
        agentHeartbeatSeconds: 30,
        averagePdfMb: 3,
        failedPaymentPercent: 5,
        unresolvedFailurePercent: 1,
      },
    },
    {
      name: "SCENARIO D — MAX PDF BURST (25 MiB max uploads)",
      input: {
        completedJobsPerMonth: 1500,
        abandonedSessionsPerMonth: 4500,
        customerConfigCallsPerSession: 1,
        trackingPollsPerJob: 6,
        adminVisibleHoursPerDay: 12,
        adminPollIntervalSeconds: 20,
        agentCount: 1,
        agentHeartbeatSeconds: 30,
        averagePdfMb: 25,
        failedPaymentPercent: 5,
        unresolvedFailurePercent: 1,
      },
    },
  ];

  for (const s of scenarios) {
    console.log(formatScenarioReport(s.name, s.input));
  }
}
