import type {
  AdminLiveOrder,
  AgentPrintJobStep,
  IdentificationSheetData,
  PrintPlanStepStatus,
} from "@printgo/api-contract";
import {
  COMPLETED_RETENTION_MS,
  PRINT_CLAIM_LEASE_MS,
  maskPhoneNumber,
  type ColorMode,
  type PaperSize,
  type SidesMode,
} from "@printgo/domain";

export interface ClaimedPrintJobRecord {
  orderId: string;
  attemptId: string;
  claimId: string;
  leaseExpiresAtMs: number;
  jobCode: string;
  printerId: string;
  windowsPrinterName: string;
  objectKey: string;
  expectedSizeBytes: number;
  sourcePageCount: number;
  pageRange: string;
  copies: number;
  paperSize: PaperSize;
  colorMode: ColorMode;
  sides: SidesMode;
  identificationSheet: IdentificationSheetData | null;
  currentStep: AgentPrintJobStep;
}

interface JobRow {
  order_id: string;
  attempt_id: string;
  claim_id: string;
  claim_expires_at_ms: number;
  public_job_code: string;
  printer_id: string;
  windows_printer_name: string;
  r2_object_key: string;
  size_bytes: number;
  source_page_count: number;
  selected_pages: string;
  copies: number;
  paper_size: PaperSize;
  color_mode: ColorMode;
  sides: SidesMode;
  customer_name: string;
  customer_phone: string;
  instructions: string | null;
  total_amount_paise: number;
  currency: "INR";
  paid_at_ms: number;
  shop_name: string;
  identification_sheet_enabled: number;
  step_id: string;
  sequence_number: number;
  step_type: AgentPrintJobStep["type"];
  step_status: PrintPlanStepStatus;
  spooler_job_id: string | null;
}

interface CandidateRow {
  order_id: string;
  printer_id: string;
  identification_sheet_enabled: number;
  identification_sheet_placement: "FIRST" | "LAST";
}

interface StepOwnershipRow {
  order_id: string;
  attempt_id: string;
  step_id: string;
  step_status: PrintPlanStepStatus;
  spooler_job_id: string | null;
  order_status: string;
}

function mapJob(row: JobRow | null): ClaimedPrintJobRecord | null {
  if (!row) return null;
  return {
    orderId: row.order_id,
    attemptId: row.attempt_id,
    claimId: row.claim_id,
    leaseExpiresAtMs: row.claim_expires_at_ms,
    jobCode: row.public_job_code,
    printerId: row.printer_id,
    windowsPrinterName: row.windows_printer_name,
    objectKey: row.r2_object_key,
    expectedSizeBytes: row.size_bytes,
    sourcePageCount: row.source_page_count,
    pageRange: row.selected_pages,
    copies: row.copies,
    paperSize: row.paper_size,
    colorMode: row.color_mode,
    sides: row.sides,
    identificationSheet:
      row.identification_sheet_enabled === 1
        ? {
            jobCode: row.public_job_code,
            customerName: row.customer_name,
            maskedPhone: maskPhoneNumber(row.customer_phone),
            paperSize: row.paper_size,
            colorMode: row.color_mode,
            sides: row.sides,
            pageRange: row.selected_pages,
            copies: row.copies,
            amountPaidPaise: row.total_amount_paise,
            currency: row.currency,
            instructions: row.instructions,
            paidAtMs: row.paid_at_ms,
            shopName: row.shop_name,
          }
        : null,
    currentStep: {
      stepId: row.step_id,
      sequenceNumber: row.sequence_number,
      type: row.step_type,
      status: row.step_status,
      spoolerJobId: row.spooler_job_id,
    },
  };
}

export interface PrintingRepository {
  recoverExpiredClaims(nowMs: number): Promise<void>;
  claimOrRenew(
    agentId: string,
    nowMs: number,
  ): Promise<ClaimedPrintJobRecord | null>;
  authenticateAgent(rawCredentialHash: string): Promise<string | null>;
  findOwnedStep(input: {
    agentId: string;
    orderId: string;
    stepId: string;
    claimId: string;
    nowMs: number;
  }): Promise<StepOwnershipRow | null>;
  startStep(input: {
    agentId: string;
    orderId: string;
    stepId: string;
    claimId: string;
    nowMs: number;
  }): Promise<StepOwnershipRow | null>;
  recordSubmission(input: {
    agentId: string;
    orderId: string;
    stepId: string;
    claimId: string;
    spoolerJobId: string;
    nowMs: number;
  }): Promise<StepOwnershipRow | null>;
  recordResult(input: {
    agentId: string;
    orderId: string;
    stepId: string;
    claimId: string;
    status: "BLOCKED" | "SUCCEEDED" | "FAILED" | "UNCERTAIN";
    spoolerJobId: string | null;
    failureCode: string | null;
    failureDetail: string | null;
    nowMs: number;
  }): Promise<StepOwnershipRow | null>;
  listLiveOrders(nowMs?: number): Promise<AdminLiveOrder[]>;
  manualComplete(input: {
    orderId: string;
    adminId: string;
    reason?: string;
    nowMs: number;
  }): Promise<{ orderId: string; status: "COMPLETED" }>;
  retryOrder(input: {
    orderId: string;
    adminId: string;
    forceUncertain?: boolean;
    nowMs: number;
  }): Promise<{ orderId: string; status: "QUEUED" }>;
  findUploadByOrderId(orderId: string): Promise<{
    r2_object_key: string;
    storage_status: string;
    deleted_at_ms: number | null;
  } | null>;
}

export class D1PrintingRepository implements PrintingRepository {
  constructor(private readonly db: D1Database) {}

  async authenticateAgent(rawCredentialHash: string): Promise<string | null> {
    const row = await this.db
      .prepare(
        "SELECT id FROM agents WHERE credential_hash = ? AND is_active = 1",
      )
      .bind(rawCredentialHash)
      .first<{ id: string }>();
    return row?.id ?? null;
  }

  async recoverExpiredClaims(nowMs: number): Promise<void> {
    const activeStatuses = "'CLAIMED','SPOOLING','PRINTING','PRINT_BLOCKED'";
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE print_attempt_steps SET status = 'UNCERTAIN', failure_code = 'UNKNOWN',
          failure_detail = 'Agent lease expired after physical submission may have started.',
          finished_at_ms = ?, updated_at_ms = ?
        WHERE print_attempt_id IN (
          SELECT pa.id FROM print_attempts pa JOIN orders o ON o.id = pa.order_id
          WHERE o.claim_expires_at_ms <= ? AND o.status IN (${activeStatuses})
            AND pa.status IN ('SUBMITTING','SPOOLING','PRINTING','BLOCKED')
        ) AND status IN ('SUBMISSION_STARTED','SUBMITTED','BLOCKED')`,
        )
        .bind(nowMs, nowMs, nowMs),
      this.db
        .prepare(
          `UPDATE print_attempts SET status = 'FAILED', failure_code = 'UNKNOWN',
          failure_detail = 'Agent lease expired after physical submission may have started.',
          finished_at_ms = ?, updated_at_ms = ?
        WHERE order_id IN (
          SELECT id FROM orders WHERE claim_expires_at_ms <= ?
            AND status IN (${activeStatuses})
        ) AND status IN ('SUBMITTING','SPOOLING','PRINTING','BLOCKED')`,
        )
        .bind(nowMs, nowMs, nowMs),
      this.db
        .prepare(
          `UPDATE orders SET status = 'ADMIN_ACTION_REQUIRED', updated_at_ms = ?
        WHERE claim_expires_at_ms <= ? AND status IN (${activeStatuses})
          AND EXISTS (
            SELECT 1 FROM print_attempts pa JOIN print_attempt_steps ps
              ON ps.print_attempt_id = pa.id
            WHERE pa.order_id = orders.id
              AND ps.status IN ('SUBMISSION_STARTED','SUBMITTED','BLOCKED','UNCERTAIN')
          )`,
        )
        .bind(nowMs, nowMs),
      this.db
        .prepare(
          `UPDATE print_attempts SET status = 'CANCELLED', finished_at_ms = ?, updated_at_ms = ?
        WHERE order_id IN (
          SELECT id FROM orders WHERE status = 'CLAIMED' AND claim_expires_at_ms <= ?
        ) AND status = 'CREATED' AND NOT EXISTS (
          SELECT 1 FROM print_attempt_steps ps
          WHERE ps.print_attempt_id = print_attempts.id AND ps.status <> 'PENDING'
        )`,
        )
        .bind(nowMs, nowMs, nowMs),
      this.db
        .prepare(
          `UPDATE orders SET status = 'QUEUED', claimed_by_agent_id = NULL,
          claim_id = NULL, claim_expires_at_ms = NULL, printer_id = NULL,
          claimed_at_ms = NULL, updated_at_ms = ?
        WHERE status = 'CLAIMED' AND claim_expires_at_ms <= ?
          AND NOT EXISTS (
            SELECT 1 FROM print_attempts pa JOIN print_attempt_steps ps
              ON ps.print_attempt_id = pa.id
            WHERE pa.order_id = orders.id
              AND ps.status IN ('SUBMISSION_STARTED','SUBMITTED','BLOCKED','UNCERTAIN')
          )`,
        )
        .bind(nowMs, nowMs),
    ]);
  }

  private async findCurrent(
    agentId: string,
  ): Promise<ClaimedPrintJobRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT o.id order_id, pa.id attempt_id, o.claim_id, o.claim_expires_at_ms,
        o.public_job_code, o.printer_id, p.windows_printer_name, u.r2_object_key,
        u.size_bytes, o.source_page_count, o.selected_pages, o.copies,
        o.paper_size, o.color_mode, o.sides, o.customer_name, o.customer_phone,
        o.instructions, o.total_amount_paise, o.currency, o.paid_at_ms,
        i.shop_name, i.identification_sheet_enabled, ps.id step_id,
        ps.sequence_number, ps.step_type, ps.status step_status, ps.spooler_job_id
      FROM orders o
      JOIN print_attempts pa ON pa.order_id = o.id
        AND pa.status IN ('CREATED','SUBMITTING','SPOOLING','PRINTING','BLOCKED')
      JOIN print_attempt_steps ps ON ps.print_attempt_id = pa.id
        AND ps.status <> 'SUCCEEDED'
      JOIN printers p ON p.id = o.printer_id AND p.agent_id = o.claimed_by_agent_id
      JOIN uploads u ON u.order_id = o.id
      JOIN installation i ON i.id = 1
      WHERE o.claimed_by_agent_id = ?
        AND o.status IN ('CLAIMED','SPOOLING','PRINTING','PRINT_BLOCKED')
      ORDER BY ps.sequence_number LIMIT 1`,
      )
      .bind(agentId)
      .first<JobRow>();
    return mapJob(row);
  }

  async claimOrRenew(
    agentId: string,
    nowMs: number,
  ): Promise<ClaimedPrintJobRecord | null> {
    await this.recoverExpiredClaims(nowMs);
    await this.finishOrphanedSuccess(agentId, nowMs);
    const existing = await this.findCurrent(agentId);
    if (existing && existing.leaseExpiresAtMs > nowMs) {
      const lease = nowMs + PRINT_CLAIM_LEASE_MS;
      await this.db
        .prepare(
          `UPDATE orders SET claim_expires_at_ms = ?, updated_at_ms = ?
         WHERE id = ? AND claimed_by_agent_id = ? AND claim_id = ?`,
        )
        .bind(lease, nowMs, existing.orderId, agentId, existing.claimId)
        .run();
      return { ...existing, leaseExpiresAtMs: lease };
    }

    const candidate = await this.db
      .prepare(
        `SELECT o.id order_id, p.id printer_id, i.identification_sheet_enabled,
        i.identification_sheet_placement
      FROM orders o
      JOIN uploads u ON u.order_id = o.id
      JOIN payments pay ON pay.order_id = o.id AND pay.status = 'PAID'
        AND pay.provider_payment_id IS NOT NULL AND pay.verified_at_ms IS NOT NULL
      JOIN agents a ON a.id = ? AND a.is_active = 1 AND a.last_heartbeat_at_ms >= ?
      JOIN printers p ON p.agent_id = a.id AND p.enabled = 1 AND p.status = 'ONLINE'
        AND p.is_production_eligible = 1 AND p.is_virtual = 0
        AND p.capabilities_json IS NOT NULL
      JOIN installation i ON i.id = 1
        AND (i.default_production_printer_id IS NULL OR p.id = i.default_production_printer_id)
      WHERE o.status = 'QUEUED' AND o.public_job_code IS NOT NULL
        AND o.source_page_count IS NOT NULL AND u.storage_status = 'UPLOADED'
        AND u.size_bytes IS NOT NULL AND u.deleted_at_ms IS NULL
        AND (u.delete_after_ms IS NULL OR u.delete_after_ms > ?)
        AND (o.color_mode = 'BW' OR json_extract(p.capabilities_json, '$.colour') = 1)
        AND (o.sides = 'SINGLE' OR json_extract(p.capabilities_json, '$.duplex') = 1)
        AND EXISTS (SELECT 1 FROM json_each(p.capabilities_json, '$.paperSizes')
          WHERE upper(value) = o.paper_size)
        AND NOT EXISTS (SELECT 1 FROM orders busy WHERE busy.claimed_by_agent_id = a.id
          AND busy.status IN ('CLAIMED','SPOOLING','PRINTING','PRINT_BLOCKED'))
      ORDER BY o.queued_at_ms, o.id, p.id LIMIT 1`,
      )
      .bind(agentId, nowMs - 90_000, nowMs)
      .first<CandidateRow>();
    if (!candidate) return null;

    const succeededSteps = await this.db
      .prepare(
        `SELECT step_type FROM print_attempt_steps WHERE order_id = ? AND status = 'SUCCEEDED'`,
      )
      .bind(candidate.order_id)
      .all<{ step_type: string }>();

    const succeededSet = new Set(
      succeededSteps.results.map((r) => r.step_type),
    );
    const needIdStep =
      candidate.identification_sheet_enabled === 1 &&
      !succeededSet.has("IDENTIFICATION_SHEET");
    const needDocStep = !succeededSet.has("CUSTOMER_DOCUMENT");

    if (!needIdStep && !needDocStep) {
      await this.finishOrphanedSuccess(agentId, nowMs);
      return null;
    }

    const claimId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const lease = nowMs + PRINT_CLAIM_LEASE_MS;
    const idStep = crypto.randomUUID();
    const documentStep = crypto.randomUUID();
    const firstIsId = candidate.identification_sheet_placement === "FIRST";
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `UPDATE orders SET status = 'CLAIMED', claimed_by_agent_id = ?, claim_id = ?,
          claim_expires_at_ms = ?, printer_id = ?, claimed_at_ms = ?, updated_at_ms = ?
        WHERE id = ? AND status = 'QUEUED' AND EXISTS (
          SELECT 1 FROM payments WHERE order_id = orders.id AND status = 'PAID'
            AND provider_payment_id IS NOT NULL AND verified_at_ms IS NOT NULL
        ) AND EXISTS (
          SELECT 1 FROM uploads WHERE order_id = orders.id AND storage_status = 'UPLOADED'
            AND deleted_at_ms IS NULL AND size_bytes IS NOT NULL
            AND (delete_after_ms IS NULL OR delete_after_ms > ?)
        ) AND EXISTS (
          SELECT 1 FROM printers p JOIN agents a ON a.id = p.agent_id
          WHERE p.id = ? AND p.agent_id = ? AND p.enabled = 1 AND p.status = 'ONLINE'
            AND p.is_production_eligible = 1 AND p.is_virtual = 0
            AND a.is_active = 1 AND a.last_heartbeat_at_ms >= ?
            AND p.capabilities_json IS NOT NULL
            AND (orders.color_mode = 'BW' OR json_extract(p.capabilities_json, '$.colour') = 1)
            AND (orders.sides = 'SINGLE' OR json_extract(p.capabilities_json, '$.duplex') = 1)
            AND EXISTS (SELECT 1 FROM json_each(p.capabilities_json, '$.paperSizes')
              WHERE upper(value) = orders.paper_size)
        )`,
        )
        .bind(
          agentId,
          claimId,
          lease,
          candidate.printer_id,
          nowMs,
          nowMs,
          candidate.order_id,
          nowMs,
          candidate.printer_id,
          agentId,
          nowMs - 90_000,
        ),
      this.db
        .prepare(
          `INSERT INTO print_attempts (id, order_id, attempt_number, agent_id, printer_id,
          status, identification_sheet_included, created_at_ms, updated_at_ms)
        SELECT ?, id, COALESCE((SELECT MAX(attempt_number) + 1 FROM print_attempts
          WHERE order_id = orders.id), 1), ?, ?, 'CREATED', ?, ?, ?
        FROM orders WHERE id = ? AND claim_id = ? AND claimed_by_agent_id = ?`,
        )
        .bind(
          attemptId,
          agentId,
          candidate.printer_id,
          candidate.identification_sheet_enabled,
          nowMs,
          nowMs,
          candidate.order_id,
          claimId,
          agentId,
        ),
    ];

    if (firstIsId) {
      if (needIdStep) {
        statements.push(
          this.db
            .prepare(
              `INSERT INTO print_attempt_steps (id, print_attempt_id, order_id, sequence_number,
              step_type, created_at_ms, updated_at_ms)
            SELECT ?, ?, ?, ?, 'IDENTIFICATION_SHEET', ?, ? FROM print_attempts WHERE id = ?`,
            )
            .bind(
              idStep,
              attemptId,
              candidate.order_id,
              1,
              nowMs,
              nowMs,
              attemptId,
            ),
        );
      }
      if (needDocStep) {
        statements.push(
          this.db
            .prepare(
              `INSERT INTO print_attempt_steps (id, print_attempt_id, order_id, sequence_number,
              step_type, created_at_ms, updated_at_ms)
            SELECT ?, ?, ?, ?, 'CUSTOMER_DOCUMENT', ?, ? FROM print_attempts WHERE id = ?`,
            )
            .bind(
              documentStep,
              attemptId,
              candidate.order_id,
              needIdStep ? 2 : 1,
              nowMs,
              nowMs,
              attemptId,
            ),
        );
      }
    } else {
      if (needDocStep) {
        statements.push(
          this.db
            .prepare(
              `INSERT INTO print_attempt_steps (id, print_attempt_id, order_id, sequence_number,
              step_type, created_at_ms, updated_at_ms)
            SELECT ?, ?, ?, ?, 'CUSTOMER_DOCUMENT', ?, ? FROM print_attempts WHERE id = ?`,
            )
            .bind(
              documentStep,
              attemptId,
              candidate.order_id,
              1,
              nowMs,
              nowMs,
              attemptId,
            ),
        );
      }
      if (needIdStep) {
        statements.push(
          this.db
            .prepare(
              `INSERT INTO print_attempt_steps (id, print_attempt_id, order_id, sequence_number,
              step_type, created_at_ms, updated_at_ms)
            SELECT ?, ?, ?, ?, 'IDENTIFICATION_SHEET', ?, ? FROM print_attempts WHERE id = ?`,
            )
            .bind(
              idStep,
              attemptId,
              candidate.order_id,
              needDocStep ? 2 : 1,
              nowMs,
              nowMs,
              attemptId,
            ),
        );
      }
    }

    statements.push(
      this.db
        .prepare(
          `INSERT INTO order_events (id, order_id, event_type, from_status, to_status,
          actor_type, actor_id, created_at_ms)
        SELECT ?, id, 'PRINT_JOB_CLAIMED', 'QUEUED', 'CLAIMED', 'AGENT', ?, ?
        FROM orders WHERE id = ? AND claim_id = ?`,
        )
        .bind(crypto.randomUUID(), agentId, nowMs, candidate.order_id, claimId),
    );
    const results = await this.db.batch(statements);
    if (results[0]?.meta.changes !== 1) return null;
    return this.findCurrent(agentId);
  }

  private async finishOrphanedSuccess(
    agentId: string,
    nowMs: number,
  ): Promise<void> {
    const row = await this.db
      .prepare(
        `SELECT o.id order_id, pa.id attempt_id, ps.id step_id,
          ps.status step_status, ps.spooler_job_id, o.status order_status,
          o.claim_id
        FROM orders o JOIN print_attempts pa ON pa.order_id = o.id
        JOIN print_attempt_steps ps ON ps.print_attempt_id = pa.id
        WHERE o.claimed_by_agent_id = ?
          AND o.status IN ('SPOOLING','PRINTING','PRINT_BLOCKED','PRINTED')
          AND pa.status IN ('SUBMITTING','SPOOLING','PRINTING','BLOCKED')
          AND NOT EXISTS (SELECT 1 FROM print_attempt_steps pending
            WHERE pending.print_attempt_id = pa.id AND pending.status <> 'SUCCEEDED')
        ORDER BY ps.sequence_number DESC LIMIT 1`,
      )
      .bind(agentId)
      .first<StepOwnershipRow & { claim_id: string }>();
    if (!row) return;
    await this.completeAttemptIfReady(row, {
      agentId,
      orderId: row.order_id,
      stepId: row.step_id,
      claimId: row.claim_id,
      status: "SUCCEEDED",
      spoolerJobId: row.spooler_job_id,
      failureCode: null,
      failureDetail: null,
      nowMs,
    });
  }

  async findOwnedStep(
    input: Parameters<PrintingRepository["findOwnedStep"]>[0],
  ): Promise<StepOwnershipRow | null> {
    return this.db
      .prepare(
        `SELECT o.id order_id, pa.id attempt_id, ps.id step_id, ps.status step_status,
        ps.spooler_job_id, o.status order_status
      FROM orders o JOIN print_attempts pa ON pa.order_id = o.id
      JOIN print_attempt_steps ps ON ps.print_attempt_id = pa.id
      WHERE o.id = ? AND ps.id = ? AND o.claimed_by_agent_id = ?
        AND o.claim_id = ? AND o.claim_expires_at_ms > ?`,
      )
      .bind(
        input.orderId,
        input.stepId,
        input.agentId,
        input.claimId,
        input.nowMs,
      )
      .first<StepOwnershipRow>();
  }

  async startStep(
    input: Parameters<PrintingRepository["startStep"]>[0],
  ): Promise<StepOwnershipRow | null> {
    const current = await this.findOwnedStep(input);
    if (!current || current.step_status !== "PENDING") return current;
    const lease = input.nowMs + PRINT_CLAIM_LEASE_MS;
    const nextOrderStatus =
      current.order_status === "CLAIMED" ? "SPOOLING" : "PRINTING";
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE print_attempt_steps SET status = 'SUBMISSION_STARTED',
          submission_started_at_ms = ?, updated_at_ms = ?
        WHERE id = ? AND print_attempt_id = ? AND status = 'PENDING'`,
        )
        .bind(input.nowMs, input.nowMs, input.stepId, current.attempt_id),
      this.db
        .prepare(
          `UPDATE print_attempts SET status = 'SUBMITTING', updated_at_ms = ?
        WHERE id = ? AND status IN ('CREATED','PRINTING')`,
        )
        .bind(input.nowMs, current.attempt_id),
      this.db
        .prepare(
          `UPDATE orders SET status = ?, print_started_at_ms = COALESCE(print_started_at_ms, ?),
          claim_expires_at_ms = ?, updated_at_ms = ? WHERE id = ? AND claim_id = ?
          AND status IN ('CLAIMED','PRINTING')`,
        )
        .bind(
          nextOrderStatus,
          input.nowMs,
          lease,
          input.nowMs,
          input.orderId,
          input.claimId,
        ),
      this.db
        .prepare(
          `INSERT INTO order_events (id, order_id, event_type, from_status, to_status,
          actor_type, actor_id, created_at_ms) VALUES (?, ?, 'PRINT_STEP_STARTED', ?,
          ?, 'AGENT', ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          input.orderId,
          current.order_status,
          nextOrderStatus,
          input.agentId,
          input.nowMs,
        ),
    ]);
    return results[0]?.meta.changes === 1
      ? this.findOwnedStep({ ...input, nowMs: input.nowMs })
      : null;
  }

  async recordSubmission(
    input: Parameters<PrintingRepository["recordSubmission"]>[0],
  ): Promise<StepOwnershipRow | null> {
    const current = await this.findOwnedStep(input);
    if (!current) return null;
    if (
      current.step_status === "SUBMITTED" ||
      current.step_status === "BLOCKED"
    ) {
      return current.spooler_job_id === input.spoolerJobId ? current : null;
    }
    if (current.step_status !== "SUBMISSION_STARTED") return current;
    const lease = input.nowMs + PRINT_CLAIM_LEASE_MS;
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE print_attempt_steps SET status = 'SUBMITTED', spooler_job_id = ?,
          submitted_at_ms = ?, last_observed_at_ms = ?, updated_at_ms = ?
        WHERE id = ? AND status = 'SUBMISSION_STARTED' AND spooler_job_id IS NULL`,
        )
        .bind(
          input.spoolerJobId,
          input.nowMs,
          input.nowMs,
          input.nowMs,
          input.stepId,
        ),
      this.db
        .prepare(
          `UPDATE print_attempts SET status = 'PRINTING', windows_job_id = COALESCE(windows_job_id, ?),
          submitted_at_ms = COALESCE(submitted_at_ms, ?), last_observed_at_ms = ?, updated_at_ms = ?
        WHERE id = ?`,
        )
        .bind(
          input.spoolerJobId,
          input.nowMs,
          input.nowMs,
          input.nowMs,
          current.attempt_id,
        ),
      this.db
        .prepare(
          `UPDATE orders SET status = 'PRINTING', claim_expires_at_ms = ?, updated_at_ms = ?
        WHERE id = ? AND claim_id = ? AND status IN ('SPOOLING','PRINT_BLOCKED')`,
        )
        .bind(lease, input.nowMs, input.orderId, input.claimId),
    ]);
    return results[0]?.meta.changes === 1 ? this.findOwnedStep(input) : null;
  }

  async recordResult(
    input: Parameters<PrintingRepository["recordResult"]>[0],
  ): Promise<StepOwnershipRow | null> {
    const current = await this.findOwnedStep(input);
    if (!current) return null;
    if (current.step_status === "SUCCEEDED") {
      if (input.status === "SUCCEEDED") {
        await this.completeAttemptIfReady(current, input);
      }
      return this.findOwnedStep(input);
    }
    if (current.step_status === "BLOCKED" && input.status === "BLOCKED")
      return current;
    if (["FAILED", "UNCERTAIN"].includes(current.step_status)) return current;
    if (
      input.status !== "UNCERTAIN" &&
      !(
        input.status === "FAILED" &&
        current.step_status === "SUBMISSION_STARTED"
      ) &&
      !["SUBMITTED", "BLOCKED"].includes(current.step_status)
    )
      return current;
    if (
      input.spoolerJobId &&
      current.spooler_job_id &&
      input.spoolerJobId !== current.spooler_job_id
    )
      return null;
    const finished = input.status === "BLOCKED" ? null : input.nowMs;
    const stepUpdate = await this.db
      .prepare(
        `UPDATE print_attempt_steps SET status = ?, spooler_job_id = COALESCE(spooler_job_id, ?),
        failure_code = ?, failure_detail = ?, last_observed_at_ms = ?, finished_at_ms = ?,
        updated_at_ms = ? WHERE id = ? AND status = ?`,
      )
      .bind(
        input.status,
        input.spoolerJobId,
        input.failureCode,
        input.failureDetail,
        input.nowMs,
        finished,
        input.nowMs,
        input.stepId,
        current.step_status,
      )
      .run();
    if (stepUpdate.meta.changes !== 1) return null;

    if (input.status === "BLOCKED") {
      await this.db.batch([
        this.db
          .prepare(
            "UPDATE print_attempts SET status = 'BLOCKED', failure_code = ?, failure_detail = ?, last_observed_at_ms = ?, updated_at_ms = ? WHERE id = ?",
          )
          .bind(
            input.failureCode,
            input.failureDetail,
            input.nowMs,
            input.nowMs,
            current.attempt_id,
          ),
        this.db
          .prepare(
            "UPDATE orders SET status = 'PRINT_BLOCKED', claim_expires_at_ms = ?, updated_at_ms = ? WHERE id = ? AND claim_id = ?",
          )
          .bind(
            input.nowMs + PRINT_CLAIM_LEASE_MS,
            input.nowMs,
            input.orderId,
            input.claimId,
          ),
        this.event(
          input.orderId,
          "PRINT_BLOCKED",
          current.order_status,
          "PRINT_BLOCKED",
          input.agentId,
          input.nowMs,
        ),
      ]);
    } else if (input.status === "FAILED" || input.status === "UNCERTAIN") {
      const orderStatus =
        input.status === "UNCERTAIN" ? "ADMIN_ACTION_REQUIRED" : "PRINT_FAILED";
      await this.db.batch([
        this.db
          .prepare(
            "UPDATE print_attempts SET status = 'FAILED', failure_code = ?, failure_detail = ?, finished_at_ms = ?, updated_at_ms = ? WHERE id = ?",
          )
          .bind(
            input.failureCode ?? "UNKNOWN",
            input.failureDetail,
            input.nowMs,
            input.nowMs,
            current.attempt_id,
          ),
        this.db
          .prepare(
            "UPDATE orders SET status = ?, updated_at_ms = ? WHERE id = ? AND claim_id = ?",
          )
          .bind(orderStatus, input.nowMs, input.orderId, input.claimId),
        this.event(
          input.orderId,
          input.status === "UNCERTAIN"
            ? "PRINT_OUTCOME_UNCERTAIN"
            : "PRINT_FAILED",
          current.order_status,
          orderStatus,
          input.agentId,
          input.nowMs,
        ),
      ]);
    } else {
      if (!(await this.completeAttemptIfReady(current, input))) {
        await this.db.batch([
          this.db
            .prepare(
              "UPDATE print_attempts SET status = 'PRINTING', failure_code = NULL, failure_detail = NULL, last_observed_at_ms = ?, updated_at_ms = ? WHERE id = ?",
            )
            .bind(input.nowMs, input.nowMs, current.attempt_id),
          this.db
            .prepare(
              "UPDATE orders SET status = 'PRINTING', claim_expires_at_ms = ?, updated_at_ms = ? WHERE id = ? AND claim_id = ?",
            )
            .bind(
              input.nowMs + PRINT_CLAIM_LEASE_MS,
              input.nowMs,
              input.orderId,
              input.claimId,
            ),
        ]);
      }
    }
    return this.findOwnedStep({ ...input, nowMs: input.nowMs });
  }

  private async completeAttemptIfReady(
    current: StepOwnershipRow,
    input: Parameters<PrintingRepository["recordResult"]>[0],
  ): Promise<boolean> {
    const remaining = await this.db
      .prepare(
        "SELECT COUNT(*) count FROM print_attempt_steps WHERE print_attempt_id = ? AND status <> 'SUCCEEDED'",
      )
      .bind(current.attempt_id)
      .first<{ count: number }>();
    if ((remaining?.count ?? 1) !== 0) return false;
    await this.db.batch([
      this.db
        .prepare(
          "UPDATE print_attempts SET status = 'SUCCEEDED', finished_at_ms = COALESCE(finished_at_ms, ?), updated_at_ms = ? WHERE id = ? AND status <> 'SUCCEEDED'",
        )
        .bind(input.nowMs, input.nowMs, current.attempt_id),
      this.db
        .prepare(
          "UPDATE orders SET status = 'PRINTED', printed_at_ms = COALESCE(printed_at_ms, ?), updated_at_ms = ? WHERE id = ? AND claim_id = ? AND status NOT IN ('PRINTED','COMPLETED')",
        )
        .bind(input.nowMs, input.nowMs, input.orderId, input.claimId),
      this.db
        .prepare(
          "UPDATE orders SET status = 'COMPLETED', completed_at_ms = COALESCE(completed_at_ms, ?), updated_at_ms = ? WHERE id = ? AND claim_id = ? AND status = 'PRINTED'",
        )
        .bind(input.nowMs, input.nowMs, input.orderId, input.claimId),
      this.db
        .prepare(
          "UPDATE uploads SET retention_reason = 'COMPLETED', delete_after_ms = ?, updated_at_ms = ? WHERE order_id = ? AND storage_status = 'UPLOADED' AND retention_reason IS NULL",
        )
        .bind(input.nowMs + COMPLETED_RETENTION_MS, input.nowMs, input.orderId),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO order_events (id, order_id, event_type, from_status,
            to_status, actor_type, actor_id, idempotency_key, created_at_ms)
          VALUES (?, ?, 'ORDER_PRINTED', ?, 'PRINTED', 'AGENT', ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          input.orderId,
          current.order_status,
          input.agentId,
          `print-attempt:${current.attempt_id}:printed`,
          input.nowMs,
        ),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO order_events (id, order_id, event_type, from_status,
            to_status, actor_type, actor_id, idempotency_key, created_at_ms)
          VALUES (?, ?, 'ORDER_COMPLETED', 'PRINTED', 'COMPLETED', 'AGENT', ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          input.orderId,
          input.agentId,
          `print-attempt:${current.attempt_id}:completed`,
          input.nowMs,
        ),
    ]);
    return true;
  }

  private event(
    orderId: string,
    type: string,
    from: string,
    to: string,
    agentId: string,
    nowMs: number,
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO order_events (id, order_id, event_type, from_status, to_status,
        actor_type, actor_id, created_at_ms) VALUES (?, ?, ?, ?, ?, 'AGENT', ?, ?)`,
      )
      .bind(crypto.randomUUID(), orderId, type, from, to, agentId, nowMs);
  }

  async listLiveOrders(nowMs: number = Date.now()): Promise<AdminLiveOrder[]> {
    // Only return live unprinted orders, plus recently completed orders within the 1-hour retention window
    const recentPrintedCutoffMs = nowMs - 60 * 60 * 1000;
    const result = await this.db
      .prepare(
        `WITH live_candidates AS (
          SELECT * FROM (
            SELECT id, public_job_code, customer_name, customer_phone,
              selected_pages, copies, paper_size, color_mode, sides,
              total_amount_paise, currency, status, claimed_by_agent_id, printer_id,
              paid_at_ms, updated_at_ms
            FROM orders
            WHERE status IN ('QUEUED','CLAIMED','SPOOLING','PRINTING','PRINT_BLOCKED',
              'PRINT_FAILED','ADMIN_ACTION_REQUIRED')
            UNION ALL
            SELECT id, public_job_code, customer_name, customer_phone,
              selected_pages, copies, paper_size, color_mode, sides,
              total_amount_paise, currency, status, claimed_by_agent_id, printer_id,
              paid_at_ms, updated_at_ms
            FROM orders
            WHERE status = 'PRINTED' AND updated_at_ms >= ?
          )
          ORDER BY updated_at_ms DESC
          LIMIT 100
        )
        SELECT o.id order_id, o.public_job_code, o.customer_name, o.customer_phone,
          o.selected_pages, o.copies, o.paper_size, o.color_mode, o.sides,
          o.total_amount_paise, o.currency, o.status, a.display_name agent_name,
          p.display_name printer_name, pa.failure_detail, o.paid_at_ms, o.updated_at_ms
        FROM live_candidates o
        LEFT JOIN agents a ON a.id = o.claimed_by_agent_id
        LEFT JOIN printers p ON p.id = o.printer_id
        LEFT JOIN print_attempts pa ON pa.order_id = o.id AND pa.attempt_number =
          (SELECT MAX(pa2.attempt_number) FROM print_attempts pa2 WHERE pa2.order_id = o.id)
        ORDER BY o.updated_at_ms DESC`,
      )
      .bind(recentPrintedCutoffMs)
      .all<{
        order_id: string;
        public_job_code: string;
        customer_name: string;
        customer_phone: string;
        selected_pages: string;
        copies: number;
        paper_size: PaperSize;
        color_mode: ColorMode;
        sides: SidesMode;
        total_amount_paise: number;
        currency: "INR";
        status: string;
        agent_name: string | null;
        printer_name: string | null;
        failure_detail: string | null;
        paid_at_ms: number;
        updated_at_ms: number;
      }>();
    return result.results.map((row) => ({
      orderId: row.order_id,
      jobCode: row.public_job_code,
      customerName: row.customer_name,
      customerPhone: row.customer_phone,
      printSummary: {
        selectedPages: row.selected_pages,
        copies: row.copies,
        paperSize: row.paper_size,
        colorMode: row.color_mode,
        sides: row.sides,
      },
      amountPaidPaise: row.total_amount_paise,
      currency: row.currency,
      status: row.status,
      agentName: row.agent_name,
      printerName: row.printer_name,
      issue: row.failure_detail,
      paidAt: new Date(row.paid_at_ms).toISOString(),
      updatedAt: new Date(row.updated_at_ms).toISOString(),
    }));
  }

  async findUploadByOrderId(orderId: string): Promise<{
    r2_object_key: string;
    storage_status: string;
    deleted_at_ms: number | null;
  } | null> {
    return this.db
      .prepare(
        `SELECT r2_object_key, storage_status, deleted_at_ms FROM uploads WHERE order_id = ?`,
      )
      .bind(orderId)
      .first<{
        r2_object_key: string;
        storage_status: string;
        deleted_at_ms: number | null;
      }>();
  }

  async manualComplete(input: {
    orderId: string;
    adminId: string;
    reason?: string;
    nowMs: number;
  }): Promise<{ orderId: string; status: "COMPLETED" }> {
    const order = await this.db
      .prepare(`SELECT id, status FROM orders WHERE id = ?`)
      .bind(input.orderId)
      .first<{ id: string; status: string }>();

    if (!order) {
      throw new Error("ORDER_NOT_FOUND");
    }

    if (order.status === "COMPLETED") {
      return { orderId: order.id, status: "COMPLETED" };
    }

    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `UPDATE orders
           SET status = 'COMPLETED', printed_at_ms = COALESCE(printed_at_ms, ?),
               completed_at_ms = ?, updated_at_ms = ?
           WHERE id = ?`,
        )
        .bind(input.nowMs, input.nowMs, input.nowMs, input.orderId),
      this.db
        .prepare(
          `UPDATE print_attempts
           SET status = 'SUCCEEDED', finished_at_ms = COALESCE(finished_at_ms, ?),
               updated_at_ms = ?
           WHERE order_id = ? AND status NOT IN ('SUCCEEDED', 'CANCELLED')`,
        )
        .bind(input.nowMs, input.nowMs, input.orderId),
      this.db
        .prepare(
          `UPDATE print_attempt_steps
           SET status = 'SUCCEEDED', finished_at_ms = COALESCE(finished_at_ms, ?),
               updated_at_ms = ?
           WHERE order_id = ? AND status <> 'SUCCEEDED'`,
        )
        .bind(input.nowMs, input.nowMs, input.orderId),
      this.db
        .prepare(
          `UPDATE uploads
           SET retention_reason = 'COMPLETED', delete_after_ms = ?, updated_at_ms = ?
           WHERE order_id = ? AND storage_status = 'UPLOADED' AND retention_reason IS NULL`,
        )
        .bind(input.nowMs + COMPLETED_RETENTION_MS, input.nowMs, input.orderId),
      this.db
        .prepare(
          `INSERT INTO order_events (
             id, order_id, event_type, from_status, to_status,
             actor_type, actor_id, created_at_ms
           ) VALUES (?, ?, 'ORDER_MANUALLY_COMPLETED', ?, 'COMPLETED', 'ADMIN', ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          input.orderId,
          order.status,
          input.adminId,
          input.nowMs,
        ),
      this.db
        .prepare(
          `INSERT INTO audit_logs (
             id, actor_type, actor_id, action, entity_type, entity_id, created_at_ms
           ) VALUES (?, 'ADMIN', ?, 'ORDER_MANUAL_COMPLETED', 'ORDER', ?, ?)`,
        )
        .bind(crypto.randomUUID(), input.adminId, input.orderId, input.nowMs),
    ];

    await this.db.batch(statements);
    return { orderId: input.orderId, status: "COMPLETED" };
  }

  async retryOrder(input: {
    orderId: string;
    adminId: string;
    forceUncertain?: boolean;
    nowMs: number;
  }): Promise<{ orderId: string; status: "QUEUED" }> {
    const order = await this.db
      .prepare(`SELECT id, status FROM orders WHERE id = ?`)
      .bind(input.orderId)
      .first<{ id: string; status: string }>();

    if (!order) {
      throw new Error("ORDER_NOT_FOUND");
    }

    if (
      !["ADMIN_ACTION_REQUIRED", "PRINT_FAILED", "PRINT_BLOCKED"].includes(
        order.status,
      )
    ) {
      throw new Error("ORDER_CANNOT_BE_RETRIED");
    }

    if (order.status === "ADMIN_ACTION_REQUIRED" && !input.forceUncertain) {
      throw new Error("UNCERTAIN_RETRY_CONFIRMATION_REQUIRED");
    }

    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `UPDATE orders
           SET status = 'QUEUED', claimed_by_agent_id = NULL, claim_id = NULL,
               claim_expires_at_ms = NULL, printer_id = NULL, claimed_at_ms = NULL,
               queued_at_ms = ?, updated_at_ms = ?
           WHERE id = ?`,
        )
        .bind(input.nowMs, input.nowMs, input.orderId),
      this.db
        .prepare(
          `UPDATE print_attempts
           SET status = 'CANCELLED', finished_at_ms = COALESCE(finished_at_ms, ?),
               updated_at_ms = ?
           WHERE order_id = ? AND status NOT IN ('SUCCEEDED', 'CANCELLED')`,
        )
        .bind(input.nowMs, input.nowMs, input.orderId),
      this.db
        .prepare(
          `INSERT INTO order_events (
             id, order_id, event_type, from_status, to_status,
             actor_type, actor_id, created_at_ms
           ) VALUES (?, ?, 'ORDER_PRINT_RETRY_REQUESTED', ?, 'QUEUED', 'ADMIN', ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          input.orderId,
          order.status,
          input.adminId,
          input.nowMs,
        ),
      this.db
        .prepare(
          `INSERT INTO audit_logs (
             id, actor_type, actor_id, action, entity_type, entity_id, created_at_ms
           ) VALUES (?, 'ADMIN', ?, 'ORDER_PRINT_RETRY', 'ORDER', ?, ?)`,
        )
        .bind(crypto.randomUUID(), input.adminId, input.orderId, input.nowMs),
    ];

    await this.db.batch(statements);
    return { orderId: input.orderId, status: "QUEUED" };
  }
}
