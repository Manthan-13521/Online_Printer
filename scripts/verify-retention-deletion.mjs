// Disposable local verification of the deployed cleanup implementation.
// Uses SQLite, an in-memory R2 bucket, fake time, synthetic payment identifiers,
// and synthetic spool IDs. It never contacts Cloudflare, Razorpay, Windows, or a
// physical printer and never mutates production data.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

import { createRuntime } from "./stress-runtime.mjs";

const HOUR_MS = 60 * 60 * 1_000;
const UNPAID_MS = 10 * 60 * 1_000;
const COMPLETED_MS = 2 * HOUR_MS;
const outputDirectory = "docs/evidence/retention-deletion-verification/local";
mkdirSync(outputDirectory, { recursive: true });

function count(db, sql, ...values) {
  return Number(db.prepare(sql).get(...values)?.count ?? 0);
}

function firstAgentPrinter(db) {
  return db
    .prepare(
      `SELECT a.id agent_id, p.id printer_id
       FROM agents a JOIN printers p ON p.agent_id = a.id
       ORDER BY a.id LIMIT 1`,
    )
    .get();
}

async function seedOrder(runtime, options) {
  const {
    status,
    createdAtMs,
    draftExpiresAtMs,
    purgeAtMs = null,
    completedAtMs = null,
    fileCount = 1,
    paymentStatus = null,
    printStatus = "PENDING",
    addForensics = false,
  } = options;
  const orderId = randomUUID();
  const { agent_id: agentId, printer_id: printerId } = firstAgentPrinter(
    runtime.db,
  );
  const requiresClaim = [
    "CLAIMED",
    "SPOOLING",
    "PRINTING",
    "PRINT_BLOCKED",
    "PRINT_FAILED",
    "ADMIN_ACTION_REQUIRED",
    "PRINTED",
    "COMPLETED",
  ].includes(status);
  const paid = paymentStatus === "PAID" || requiresClaim;
  const claimId = requiresClaim ? randomUUID() : null;
  runtime.db
    .prepare(
      `INSERT INTO orders
       (id, public_job_code, tracking_token_hash, customer_name, customer_phone,
        original_filename, selected_pages, source_page_count, copies, color_mode,
        paper_size, sides, instructions, status, claimed_by_agent_id, claim_id,
        claim_expires_at_ms, printer_id, created_at_ms, updated_at_ms, paid_at_ms,
        queued_at_ms, claimed_at_ms, printed_at_ms, completed_at_ms,
        draft_token_hash, draft_expires_at_ms, purge_at_ms)
       VALUES (?, ?, ?, 'Synthetic Customer', '9000000000', 'private.pdf', 'ALL',
        1, 1, 'BW', 'A4', 'SINGLE', 'synthetic private note', ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      orderId,
      paid ? `PG-${orderId.slice(0, 6).toUpperCase()}` : null,
      paid ? `tracking-${orderId}` : null,
      status,
      requiresClaim ? agentId : null,
      claimId,
      requiresClaim ? createdAtMs + 5 * HOUR_MS : null,
      requiresClaim ? printerId : null,
      createdAtMs,
      completedAtMs ?? createdAtMs,
      paid ? createdAtMs + 1_000 : null,
      paid ? createdAtMs + 2_000 : null,
      requiresClaim ? createdAtMs + 3_000 : null,
      completedAtMs,
      completedAtMs,
      `draft-${orderId}`,
      draftExpiresAtMs,
      purgeAtMs,
    );

  const fileIds = [];
  const objectKeys = [];
  for (let position = 1; position <= fileCount; position++) {
    const fileId = randomUUID();
    const objectKey = `uploads/${orderId}/${fileId}.pdf`;
    fileIds.push(fileId);
    objectKeys.push(objectKey);
    runtime.db
      .prepare(
        `INSERT INTO order_files
         (id, order_id, position, original_filename, r2_object_key,
          expected_size_bytes, size_bytes, mime_type, source_page_count,
          selected_pages, selected_page_count, copies, paper_size, color_mode,
          sides, upload_status, print_status, spooler_job_id, uploaded_at_ms,
          printed_at_ms, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, 100, 100, 'application/pdf', 1, 'ALL', 1, 1,
          'A4', 'BW', 'SINGLE', 'UPLOADED', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fileId,
        orderId,
        position,
        `private-${position}.pdf`,
        objectKey,
        printStatus,
        printStatus === "PRINTED" ? `spool-${position}` : null,
        createdAtMs,
        printStatus === "PRINTED" ? completedAtMs : null,
        createdAtMs,
        completedAtMs ?? createdAtMs,
      );
    await runtime.env.PDF_BUCKET.put(
      objectKey,
      Buffer.from(`%PDF synthetic ${position}`),
    );
  }

  runtime.db
    .prepare(
      `INSERT INTO uploads
       (id, order_id, r2_object_key, original_filename, expected_size_bytes,
        size_bytes, mime_type, storage_status, retention_reason, delete_after_ms,
        uploaded_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, 'private.pdf', 100, 100, 'application/pdf', 'UPLOADED',
        ?, ?, ?, ?, ?)`,
    )
    .run(
      fileIds[0],
      orderId,
      objectKeys[0],
      status === "COMPLETED" ? "COMPLETED" : "UNPAID",
      status === "COMPLETED" ? purgeAtMs : draftExpiresAtMs,
      createdAtMs,
      createdAtMs,
      completedAtMs ?? createdAtMs,
    );

  let paymentId = null;
  let providerEventId = null;
  if (paymentStatus) {
    paymentId = randomUUID();
    const providerOrderId = `order_${paymentId.replaceAll("-", "")}`;
    const providerPaymentId =
      paymentStatus === "PAID" ? `pay_${paymentId.replaceAll("-", "")}` : null;
    runtime.db
      .prepare(
        `INSERT INTO payments
         (id, order_id, provider_order_id, provider_payment_id, amount_paise,
          currency, status, verified_at_ms, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, 100, 'INR', ?, ?, ?, ?)`,
      )
      .run(
        paymentId,
        orderId,
        providerOrderId,
        providerPaymentId,
        paymentStatus,
        paymentStatus === "PAID" ? createdAtMs + 1_000 : null,
        createdAtMs,
        createdAtMs,
      );
    providerEventId = randomUUID();
    runtime.db
      .prepare(
        `INSERT INTO payment_provider_events
         (id, provider_event_id, event_type, received_at_ms, processed_at_ms,
          processing_status, related_payment_id, related_order_id)
         VALUES (?, ?, 'payment.captured', ?, ?, 'PROCESSED', ?, ?)`,
      )
      .run(
        providerEventId,
        `event_${providerEventId.replaceAll("-", "")}`,
        createdAtMs,
        createdAtMs + 1_000,
        paymentId,
        orderId,
      );
  }

  if (addForensics) {
    const attemptId = randomUUID();
    const stepId = randomUUID();
    runtime.db
      .prepare(
        `INSERT INTO print_attempts
         (id, order_id, attempt_number, agent_id, printer_id, windows_job_id,
          status, submitted_at_ms, last_observed_at_ms, finished_at_ms,
          created_at_ms, updated_at_ms, order_file_id, file_position)
         VALUES (?, ?, 1, ?, ?, 'spool-1', 'SUCCEEDED', ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(
        attemptId,
        orderId,
        agentId,
        printerId,
        createdAtMs + 4_000,
        completedAtMs,
        completedAtMs,
        createdAtMs + 3_000,
        completedAtMs,
        fileIds[0],
      );
    runtime.db
      .prepare(
        `INSERT INTO print_attempt_steps
         (id, print_attempt_id, order_id, sequence_number, step_type, status,
          spooler_job_id, submission_started_at_ms, submitted_at_ms,
          last_observed_at_ms, finished_at_ms, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, 1, 'CUSTOMER_DOCUMENT', 'SUCCEEDED', 'spool-1', ?, ?,
          ?, ?, ?, ?)`,
      )
      .run(
        stepId,
        attemptId,
        orderId,
        createdAtMs + 3_500,
        createdAtMs + 4_000,
        completedAtMs,
        completedAtMs,
        createdAtMs + 3_000,
        completedAtMs,
      );
    runtime.db
      .prepare(
        `INSERT INTO order_events
         (id, order_id, event_type, from_status, to_status, actor_type,
          actor_id, details_json, created_at_ms)
         VALUES (?, ?, 'ORDER_COMPLETED', 'PRINTED', 'COMPLETED', 'AGENT', ?,
          ?, ?)`,
      )
      .run(
        randomUUID(),
        orderId,
        agentId,
        JSON.stringify({ spoolerJobId: "spool-1" }),
        completedAtMs,
      );
    runtime.db
      .prepare(
        `INSERT INTO audit_logs
         (id, actor_type, actor_id, action, entity_type, entity_id, created_at_ms)
         VALUES (?, 'ADMIN', 'synthetic-admin', 'ORDER_MANUAL_COMPLETED',
          'ORDER', ?, ?)`,
      )
      .run(randomUUID(), orderId, completedAtMs);
  }

  return {
    orderId,
    fileIds,
    objectKeys,
    paymentId,
    providerEventId,
  };
}

async function withRuntime(label, callback) {
  const runtime = await createRuntime(
    `.tmp/retention-verification/${label}-${Date.now()}`,
  );
  try {
    return await callback(runtime);
  } finally {
    runtime.close();
  }
}

function cleanup(runtime, nowMs) {
  const repository = new runtime.api.D1CleanupRepository(runtime.env.DB);
  const service = new runtime.api.CleanupService(
    repository,
    runtime.env.PDF_BUCKET,
    () => nowMs,
  );
  return { repository, service };
}

const boundary = await withRuntime("boundary", async (runtime) => {
  const base = Date.parse("2026-10-01T00:00:00.000Z");
  const unpaidExpiry = base + UNPAID_MS;
  const completedAt = base + 20_000;
  const completedExpiry = completedAt + COMPLETED_MS;
  await seedOrder(runtime, {
    status: "UPLOADED",
    createdAtMs: base,
    draftExpiresAtMs: unpaidExpiry,
  });
  await seedOrder(runtime, {
    status: "COMPLETED",
    createdAtMs: base,
    draftExpiresAtMs: base + UNPAID_MS,
    purgeAtMs: completedExpiry,
    completedAtMs: completedAt,
    paymentStatus: "PAID",
    printStatus: "PRINTED",
  });
  const repository = new runtime.api.D1CleanupRepository(runtime.env.DB);
  const result = {
    unpaid: {
      tMinus1: await repository.hasCandidates(
        "EXPIRED_UNPAID",
        unpaidExpiry - 1,
      ),
      t: await repository.hasCandidates("EXPIRED_UNPAID", unpaidExpiry),
      tPlus1: await repository.hasCandidates(
        "EXPIRED_UNPAID",
        unpaidExpiry + 1,
      ),
    },
    completed: {
      tMinus1: await repository.hasCandidates(
        "COMPLETED_DUE",
        completedExpiry - 1,
      ),
      t: await repository.hasCandidates("COMPLETED_DUE", completedExpiry),
      tPlus1: await repository.hasCandidates(
        "COMPLETED_DUE",
        completedExpiry + 1,
      ),
    },
  };
  assert.deepEqual(result.unpaid, {
    tMinus1: false,
    t: true,
    tPlus1: true,
  });
  assert.deepEqual(result.completed, {
    tMinus1: false,
    t: true,
    tPlus1: true,
  });
  return result;
});

async function verifyDeletion(kind, fileCount) {
  return withRuntime(`${kind}-${fileCount}`, async (runtime) => {
    const base = Date.parse("2026-10-01T00:00:00.000Z");
    const completedAt = base + 10_000;
    const eligibleAt =
      kind === "unpaid" ? base + UNPAID_MS : completedAt + COMPLETED_MS;
    const seeded = await seedOrder(runtime, {
      status: kind === "unpaid" ? "UPLOADED" : "COMPLETED",
      createdAtMs: base,
      draftExpiresAtMs: base + UNPAID_MS,
      purgeAtMs: kind === "completed" ? eligibleAt : null,
      completedAtMs: kind === "completed" ? completedAt : null,
      fileCount,
      paymentStatus: kind === "completed" ? "PAID" : null,
      printStatus: kind === "completed" ? "PRINTED" : "PENDING",
      addForensics: kind === "completed",
    });
    const unrelated = await seedOrder(runtime, {
      status: "UPLOADED",
      createdAtMs: base,
      draftExpiresAtMs: eligibleAt + HOUR_MS,
    });
    assert.ok(seeded.objectKeys.every((key) => runtime.objects.has(key)));
    await cleanup(runtime, eligibleAt - 1).service.runScheduled();
    assert.equal(
      count(
        runtime.db,
        "SELECT COUNT(*) count FROM orders WHERE id = ?",
        seeded.orderId,
      ),
      1,
    );
    assert.ok(seeded.objectKeys.every((key) => runtime.objects.has(key)));

    await cleanup(runtime, eligibleAt).service.runScheduled();
    const result = {
      orderDeleted:
        count(
          runtime.db,
          "SELECT COUNT(*) count FROM orders WHERE id = ?",
          seeded.orderId,
        ) === 0,
      fileRowsDeleted:
        count(
          runtime.db,
          "SELECT COUNT(*) count FROM order_files WHERE order_id = ?",
          seeded.orderId,
        ) === 0,
      uploadRowDeleted:
        count(
          runtime.db,
          "SELECT COUNT(*) count FROM uploads WHERE order_id = ?",
          seeded.orderId,
        ) === 0,
      allR2ObjectsDeleted: seeded.objectKeys.every(
        (key) => !runtime.objects.has(key),
      ),
      unrelatedOrderRetained:
        count(
          runtime.db,
          "SELECT COUNT(*) count FROM orders WHERE id = ?",
          unrelated.orderId,
        ) === 1,
      unrelatedR2Retained: unrelated.objectKeys.every((key) =>
        runtime.objects.has(key),
      ),
      retainedPayments: count(
        runtime.db,
        "SELECT COUNT(*) count FROM retained_payment_records WHERE id = ?",
        seeded.paymentId,
      ),
      retainedProviderEvents: count(
        runtime.db,
        "SELECT COUNT(*) count FROM retained_provider_events WHERE id = ?",
        seeded.providerEventId,
      ),
      retainedAuditLogs: count(
        runtime.db,
        "SELECT COUNT(*) count FROM audit_logs WHERE entity_type = 'ORDER' AND entity_id = ?",
        seeded.orderId,
      ),
      retainedPrintAttempts: count(
        runtime.db,
        "SELECT COUNT(*) count FROM print_attempts WHERE order_id = ?",
        seeded.orderId,
      ),
      retainedPrintSteps: count(
        runtime.db,
        "SELECT COUNT(*) count FROM print_attempt_steps WHERE order_id = ?",
        seeded.orderId,
      ),
      retainedOrderEvents: count(
        runtime.db,
        "SELECT COUNT(*) count FROM order_events WHERE order_id = ?",
        seeded.orderId,
      ),
      cleanupAuditItems: count(
        runtime.db,
        "SELECT COUNT(*) count FROM cleanup_run_items WHERE order_id = ? AND status = 'DELETED'",
        seeded.orderId,
      ),
    };
    assert.equal(result.orderDeleted, true);
    assert.equal(result.fileRowsDeleted, true);
    assert.equal(result.uploadRowDeleted, true);
    assert.equal(result.allR2ObjectsDeleted, true);
    assert.equal(result.unrelatedOrderRetained, true);
    assert.equal(result.unrelatedR2Retained, true);
    assert.equal(result.cleanupAuditItems, 1);
    if (kind === "completed") {
      assert.equal(result.retainedPayments, 1);
      assert.equal(result.retainedProviderEvents, 1);
      assert.equal(result.retainedAuditLogs, 1);
      assert.equal(result.retainedPrintAttempts, 0);
      assert.equal(result.retainedPrintSteps, 0);
      assert.equal(result.retainedOrderEvents, 0);
    }
    return result;
  });
}

const u1 = await verifyDeletion("unpaid", 1);
const u2 = await verifyDeletion("unpaid", 3);
const p1 = await verifyDeletion("completed", 1);
const p2 = await verifyDeletion("completed", 3);

const negative = await withRuntime("negative", async (runtime) => {
  const now = Date.parse("2026-10-01T03:00:00.000Z");
  const expired = now - 1;
  const paidNotPrinted = await seedOrder(runtime, {
    status: "QUEUED",
    createdAtMs: now - 3 * HOUR_MS,
    draftExpiresAtMs: expired,
    paymentStatus: "PAID",
  });
  const activePrint = await seedOrder(runtime, {
    status: "PRINTING",
    createdAtMs: now - 3 * HOUR_MS,
    draftExpiresAtMs: expired,
    paymentStatus: "PAID",
    printStatus: "SUBMITTED",
  });
  const uncertainPrint = await seedOrder(runtime, {
    status: "ADMIN_ACTION_REQUIRED",
    createdAtMs: now - 3 * HOUR_MS,
    draftExpiresAtMs: expired,
    paymentStatus: "PAID",
    printStatus: "UNCERTAIN",
  });
  const stalePendingPayment = await seedOrder(runtime, {
    status: "PAYMENT_PENDING",
    createdAtMs: now - HOUR_MS,
    draftExpiresAtMs: expired,
    paymentStatus: "PENDING",
  });
  const repository = new runtime.api.D1CleanupRepository(runtime.env.DB);
  const scheduledUnpaid = await repository.preview("EXPIRED_UNPAID", now);
  const scheduledCompleted = await repository.preview("COMPLETED_DUE", now);
  await cleanup(runtime, now).service.runScheduled();
  const retained = (orderId) =>
    count(
      runtime.db,
      "SELECT COUNT(*) count FROM orders WHERE id = ?",
      orderId,
    ) === 1;
  const result = {
    paidNotPrintedProtected: retained(paidNotPrinted.orderId),
    activePrintProtected: retained(activePrint.orderId),
    uncertainPrintProtected: retained(uncertainPrint.orderId),
    stalePendingPaymentStillPresent: retained(stalePendingPayment.orderId),
    stalePendingPaymentEligible:
      scheduledUnpaid.orders > 0 || scheduledCompleted.orders > 0,
  };
  assert.equal(result.paidNotPrintedProtected, true);
  assert.equal(result.activePrintProtected, true);
  assert.equal(result.uncertainPrintProtected, true);
  assert.equal(result.stalePendingPaymentStillPresent, true);
  assert.equal(result.stalePendingPaymentEligible, false);
  return result;
});

const retry = await withRuntime("retry", async (runtime) => {
  const base = Date.parse("2026-10-01T00:00:00.000Z");
  const eligibleAt = base + UNPAID_MS;
  const seeded = await seedOrder(runtime, {
    status: "UPLOADED",
    createdAtMs: base,
    draftExpiresAtMs: eligibleAt,
  });
  const workingDelete = runtime.env.PDF_BUCKET.delete.bind(
    runtime.env.PDF_BUCKET,
  );
  runtime.env.PDF_BUCKET.delete = async () => {
    throw new Error("SIMULATED_R2_DELETE_FAILURE");
  };
  await cleanup(runtime, eligibleAt).service.runScheduled();
  const failed = runtime.db
    .prepare(
      `SELECT status, attempt_count, next_attempt_at_ms
       FROM cleanup_run_items WHERE order_id = ?`,
    )
    .get(seeded.orderId);
  assert.equal(failed.status, "FAILED");
  assert.equal(failed.attempt_count, 1);
  assert.equal(failed.next_attempt_at_ms, eligibleAt + 300_000);
  const failureKeptR2Object = runtime.objects.has(seeded.objectKeys[0]);
  assert.equal(failureKeptR2Object, true);
  assert.equal(
    count(
      runtime.db,
      "SELECT COUNT(*) count FROM orders WHERE id = ?",
      seeded.orderId,
    ),
    1,
  );
  const beforeBackoff = Number(
    runtime.db.prepare("SELECT total_changes() changes").get().changes,
  );
  await cleanup(runtime, eligibleAt + 299_999).service.runScheduled();
  const afterBackoff = Number(
    runtime.db.prepare("SELECT total_changes() changes").get().changes,
  );
  runtime.env.PDF_BUCKET.delete = workingDelete;
  await cleanup(runtime, eligibleAt + 300_000).service.runScheduled();
  const recoveredRun = runtime.db
    .prepare(
      `SELECT status, failures, completed_at_ms FROM cleanup_runs
       WHERE scope = 'EXPIRED_UNPAID' ORDER BY created_at_ms LIMIT 1`,
    )
    .get();
  const beforePostRecovery = Number(
    runtime.db.prepare("SELECT total_changes() changes").get().changes,
  );
  await cleanup(runtime, eligibleAt + 300_001).service.runScheduled();
  const afterPostRecovery = Number(
    runtime.db.prepare("SELECT total_changes() changes").get().changes,
  );
  const result = {
    failureKeptR2Object,
    writesBeforeRetryDue: afterBackoff - beforeBackoff,
    recoveredOrderDeleted:
      count(
        runtime.db,
        "SELECT COUNT(*) count FROM orders WHERE id = ?",
        seeded.orderId,
      ) === 0,
    recoveredR2Deleted: !runtime.objects.has(seeded.objectKeys[0]),
    recoveredRun,
    writesOnNextEmptyCycle: afterPostRecovery - beforePostRecovery,
  };
  assert.equal(result.writesBeforeRetryDue, 0);
  assert.equal(result.recoveredOrderDeleted, true);
  assert.equal(result.recoveredR2Deleted, true);
  assert.equal(result.recoveredRun.status, "PARTIAL");
  assert.ok(result.writesOnNextEmptyCycle > 0);
  return result;
});

const emptyCost = await withRuntime("empty", async (runtime) => {
  const before = { ...runtime.totals };
  await cleanup(
    runtime,
    Date.parse("2026-10-01T04:00:00.000Z"),
  ).service.runScheduled();
  return {
    statements: runtime.totals.statements - before.statements,
    returnedRows: runtime.totals.returnedRows - before.returnedRows,
    changedRows: runtime.totals.changedRows - before.changedRows,
    r2Deletes: runtime.totals.r2.DELETE - before.r2.DELETE,
  };
});
assert.equal(emptyCost.changedRows, 0);
assert.equal(emptyCost.r2Deletes, 0);

const result = {
  generatedAt: new Date().toISOString(),
  evidence: "MEASURED LOCAL with SIMULATED in-memory R2",
  scope:
    "Current cleanup service/repository, all migrations, fake clock, synthetic D1/R2/payment/print fixtures; no external side effects.",
  policyBoundary: boundary,
  tests: { U1: u1, U2: u2, P1: p1, P2: p2, negative, retry },
  optimizer: { emptyCron: emptyCost },
  acceptance: {
    unpaidSingleAndMultiDeletion: true,
    completedSingleAndMultiDeletion: true,
    requiredPaymentProviderEvidenceRetained: true,
    auditLogRetained: true,
    printForensicsRetained: false,
    stalePendingPaymentBecomesEligibleAfterTenMinutes: false,
    failedDeleteBackoffIsWriteFreeBeforeDue: true,
    recoveredRunBecomesTerminalAndWriteFree: false,
    overall: "FAIL",
  },
  notVerified: [
    "Cloudflare R2 deletion for a controlled production object",
    "Natural two-hour production completion window",
    "Windows physical printing",
    "Live Razorpay payment flow",
  ],
};

writeFileSync(
  `${outputDirectory}/controlled-retention-matrix.json`,
  `${JSON.stringify(result, null, 2)}\n`,
);
console.log(JSON.stringify(result, null, 2));
