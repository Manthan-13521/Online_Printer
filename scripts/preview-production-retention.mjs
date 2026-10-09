import { execSync } from "node:child_process";

function queryD1(sql) {
  const cmd = `pnpm --filter @printgo/worker exec wrangler d1 execute printgo-production --remote --config wrangler.jsonc --command "${sql.replace(/"/g, '\\"')}" --json`;
  const raw = execSync(cmd, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  const parsed = JSON.parse(raw);
  return parsed[0]?.results ?? [];
}

console.log("=== PRINTGO PRODUCTION READ-ONLY RETENTION PREVIEW ===");
const nowMs = Date.now();
console.log(
  `Report Generated At: ${new Date(nowMs).toISOString()} (nowMs: ${nowMs})`,
);

// 1. Installation Settings
const installation = queryD1(
  "SELECT id, shop_name, order_retention_hours, last_cleanup_at_ms, last_cleanup_result FROM installation WHERE id = 1",
);
console.log("\n1. Installation Configuration:");
console.log(JSON.stringify(installation, null, 2));

// 2. Orders Status & Cleanup State Breakdown
const orderSummary = queryD1(`
  SELECT status, cleanup_state, count(*) as count,
         min(created_at_ms) as oldest_created_at_ms,
         max(created_at_ms) as newest_created_at_ms
  FROM orders
  GROUP BY status, cleanup_state
  ORDER BY count DESC
`);
console.log("\n2. Orders Status & Cleanup State Breakdown:");
console.table(orderSummary);

// 3. Eligible Completed Orders
const retentionHours = installation[0]?.order_retention_hours ?? 2;
const eligibleCompleted = queryD1(`
  SELECT count(*) as eligible_orders,
         count(f.id) as eligible_files,
         coalesce(sum(f.size_bytes), 0) as eligible_bytes
  FROM orders o
  LEFT JOIN order_files f ON f.order_id = o.id
  WHERE o.status = 'COMPLETED'
    AND o.cleanup_state = 'ACTIVE'
    AND (
      (o.purge_at_ms IS NOT NULL AND o.purge_at_ms <= ${nowMs})
      OR (o.purge_at_ms IS NULL AND o.completed_at_ms IS NOT NULL AND o.completed_at_ms <= ${nowMs - retentionHours * 3600000})
    )
`);
console.log("\n3. Eligible Completed Orders for Purge:");
console.log(JSON.stringify(eligibleCompleted, null, 2));

// 4. Eligible Expired Unpaid Orders (10m deadline)
const eligibleUnpaid = queryD1(`
  SELECT count(*) as eligible_unpaid_orders,
         count(f.id) as eligible_files,
         coalesce(sum(f.size_bytes), 0) as eligible_bytes
  FROM orders o
  LEFT JOIN order_files f ON f.order_id = o.id
  WHERE o.cleanup_state = 'ACTIVE'
    AND o.status IN ('CREATED','UPLOADING','UPLOADED','PAYMENT_PENDING','PAYMENT_FAILED','PAYMENT_CANCELLED')
    AND o.draft_expires_at_ms <= ${nowMs}
`);
console.log("\n4. Eligible Expired Unpaid Orders for Purge:");
console.log(JSON.stringify(eligibleUnpaid, null, 2));

// 5. Active & Protected Orders (Must NOT be touched)
const activeProtected = queryD1(`
  SELECT id, public_job_code, status, cleanup_state, created_at_ms
  FROM orders
  WHERE status IN ('CLAIMED','SPOOLING','PRINTING','PRINT_BLOCKED','PRINT_FAILED','ADMIN_ACTION_REQUIRED','UNCERTAIN','QUEUED','RETRY_PENDING','PAID')
     OR (status = 'PAYMENT_PENDING' AND (draft_expires_at_ms IS NULL OR draft_expires_at_ms > ${nowMs}))
     OR (status = 'COMPLETED' AND (purge_at_ms > ${nowMs} OR (purge_at_ms IS NULL AND completed_at_ms > ${nowMs - retentionHours * 3600000})))
`);
console.log("\n5. Active & Protected Orders (Exempt from Deletion):");
console.log(`Count of Protected Orders: ${activeProtected.length}`);
if (activeProtected.length > 0) {
  console.table(activeProtected);
}

// 6. Payments Older than 25 Days
const cutoff25d = nowMs - 25 * 24 * 3600 * 1000;
console.log(
  `\n25-Day Cutoff Timestamp: ${new Date(cutoff25d).toISOString()} (${cutoff25d})`,
);

const payments25d = queryD1(`
  SELECT 
    (SELECT count(*) FROM payments WHERE created_at_ms <= ${cutoff25d}) as expired_payments,
    (SELECT count(*) FROM payments WHERE created_at_ms > ${cutoff25d}) as active_payments,
    (SELECT count(*) FROM payment_provider_events WHERE received_at_ms <= ${cutoff25d}) as expired_events,
    (SELECT count(*) FROM payment_provider_events WHERE received_at_ms > ${cutoff25d}) as active_events,
    (SELECT count(*) FROM retained_payment_records WHERE coalesce(payment_created_at_ms, purged_at_ms) <= ${cutoff25d}) as expired_retained_payments,
    (SELECT count(*) FROM retained_payment_records WHERE coalesce(payment_created_at_ms, purged_at_ms) > ${cutoff25d}) as active_retained_payments,
    (SELECT count(*) FROM retained_provider_events WHERE coalesce(received_at_ms, purged_at_ms) <= ${cutoff25d}) as expired_retained_events,
    (SELECT count(*) FROM retained_provider_events WHERE coalesce(received_at_ms, purged_at_ms) > ${cutoff25d}) as active_retained_events
`);
console.log("\n6. Payment Records (25-Day Eligibility Breakdown):");
console.log(JSON.stringify(payments25d, null, 2));

// 7. Audit Logs & Cleanup Runs
const auditTelemetry = queryD1(`
  SELECT
    (SELECT count(*) FROM audit_logs WHERE created_at_ms <= ${cutoff25d}) as expired_audit_logs_25d,
    (SELECT count(*) FROM audit_logs WHERE created_at_ms > ${cutoff25d}) as recent_audit_logs,
    (SELECT count(*) FROM cleanup_runs WHERE completed_at_ms IS NOT NULL AND completed_at_ms <= ${nowMs - 7 * 86400000}) as expired_cleanup_runs_7d,
    (SELECT count(*) FROM cleanup_runs WHERE status IN ('PENDING', 'RUNNING')) as open_cleanup_runs,
    (SELECT count(*) FROM cleanup_runs WHERE status = 'PARTIAL' AND completed_at_ms IS NULL) as stuck_partial_runs
`);
console.log("\n7. Audit Logs & Cleanup Runs Breakdown:");
console.log(JSON.stringify(auditTelemetry, null, 2));

// 8. Recent Cleanup Runs History
const recentRuns = queryD1(`
  SELECT id, scope, source, status, orders_selected, orders_deleted, files_deleted, failures, last_error, created_at_ms, completed_at_ms
  FROM cleanup_runs
  ORDER BY created_at_ms DESC
  LIMIT 5
`);
console.log("\n8. Last 5 Cleanup Runs in Production:");
console.table(recentRuns);
