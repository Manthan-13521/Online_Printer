import type {
  AdminLiveOrder,
  AgentPrintJobStep,
  IdentificationSheetAddonService,
  IdentificationSheetData,
  PrintPlanStepStatus,
} from "@printgo/api-contract";
import {
  COMPLETED_RETENTION_MS,
  PRINT_CLAIM_LEASE_MS,
  maskPhoneNumber,
  normalizePrinterFailure,
  isPrinterWideFailure,
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
  fileId?: string;
  filePosition?: number;
  fileCount?: number;
  originalFilename?: string;
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
  pickup_code: string | null;
  due_at_pickup_paise: number;
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
  file_id: string;
  file_position: number;
  file_count: number;
  original_filename: string;
  identification_sheet_enabled: number;
  step_id: string;
  sequence_number: number;
  step_type: AgentPrintJobStep["type"];
  step_status: PrintPlanStepStatus;
  spooler_job_id: string | null;
  addon_services_json: string | null;
}

interface CandidateRow {
  order_id: string;
  printer_id: string;
  file_id: string;
  file_position: number;
  file_count: number;
  remaining_files: number;
  identification_sheet_enabled: number;
  identification_sheet_placement: "FIRST" | "LAST";
  identification_required: number;
  /** Non-null when the job was routed to a fallback printer. */
  fallback_from_printer_id: string | null;
}

interface StepOwnershipRow {
  order_id: string;
  attempt_id: string;
  step_id: string;
  step_status: PrintPlanStepStatus;
  spooler_job_id: string | null;
  order_status: string;
  step_type: AgentPrintJobStep["type"];
  order_file_id: string | null;
}

function parseAddonServices(
  rawJson: string | null | undefined,
): IdentificationSheetAddonService[] {
  if (!rawJson) return [];
  try {
    const parsed = JSON.parse(rawJson) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (item): item is IdentificationSheetAddonService =>
          item !== null &&
          typeof item === "object" &&
          typeof (item as Record<string, unknown>).name === "string",
      );
    }
    return [];
  } catch {
    return [];
  }
}

function mapJob(row: JobRow | null): ClaimedPrintJobRecord | null {
  if (!row) return null;
  return {
    orderId: row.order_id,
    attemptId: row.attempt_id,
    claimId: row.claim_id,
    leaseExpiresAtMs: row.claim_expires_at_ms,
    jobCode: row.public_job_code,
    fileId: row.file_id,
    filePosition: row.file_position,
    fileCount: row.file_count,
    originalFilename: row.original_filename,
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
            pickupCode: row.pickup_code,
            customerName: row.customer_name,
            maskedPhone: maskPhoneNumber(row.customer_phone),
            customerPhone: row.customer_phone,
            paperSize: row.paper_size,
            colorMode: row.color_mode,
            sides: row.sides,
            pageRange: row.selected_pages,
            copies: row.copies,
            amountPaidPaise: row.total_amount_paise,
            dueAtPickupPaise: row.due_at_pickup_paise,
            currency: row.currency,
            instructions: row.instructions,
            paidAtMs: row.paid_at_ms,
            shopName: row.shop_name,
            addonServices: parseAddonServices(row.addon_services_json),
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
  }): Promise<{ orderId: string; status: "COMPLETED" | "AWAITING_FINISHING" }>;
  retryOrder(input: {
    orderId: string;
    adminId: string;
    forceUncertain?: boolean;
    nowMs: number;
  }): Promise<{ orderId: string; status: "QUEUED" }>;
  autoRetryEligibleOrders(nowMs: number): Promise<{ retriedCount: number }>;
  findUploadByOrderId(orderId: string): Promise<{
    r2_object_key: string;
    storage_status: string;
    deleted_at_ms: number | null;
    delete_after_ms: number | null;
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
          `UPDATE order_files SET print_status = 'UNCERTAIN', updated_at_ms = ?
           WHERE id IN (
             SELECT pa.order_file_id FROM print_attempts pa JOIN orders o ON o.id = pa.order_id
             JOIN print_attempt_steps ps ON ps.print_attempt_id = pa.id
             WHERE o.claim_expires_at_ms <= ? AND o.status IN (${activeStatuses})
               AND ps.step_type = 'CUSTOMER_DOCUMENT'
               AND ps.status IN ('SUBMISSION_STARTED','SUBMITTED','BLOCKED','UNCERTAIN')
           )`,
        )
        .bind(nowMs, nowMs),
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
        o.public_job_code, o.pickup_code, o.due_at_pickup_paise, o.printer_id, p.windows_printer_name, f.r2_object_key,
        f.size_bytes, f.source_page_count, f.selected_pages, f.copies,
        f.paper_size, f.color_mode, f.sides, o.customer_name, o.customer_phone,
        o.instructions, o.total_amount_paise, o.currency, o.paid_at_ms,
        f.id file_id, f.position file_position, f.original_filename,
        (SELECT COUNT(*) FROM order_files WHERE order_id = o.id) file_count,
        i.shop_name, EXISTS(SELECT 1 FROM print_attempt_steps ids WHERE ids.print_attempt_id = pa.id AND ids.step_type = 'IDENTIFICATION_SHEET') identification_sheet_enabled, ps.id step_id,
        ps.sequence_number, ps.step_type, ps.status step_status, ps.spooler_job_id,
        (SELECT json_group_array(json_object(
          'name', snapshot_name,
          'pricingType', snapshot_pricing_type,
          'priceChargedOnlinePaise', snapshot_price_charged_online_paise,
          'handlingMode', snapshot_handling_mode
        )) FROM order_addon_services WHERE order_id = o.id) addon_services_json
      FROM orders o
      JOIN print_attempts pa ON pa.order_id = o.id
        AND pa.status IN ('CREATED','SUBMITTING','SPOOLING','PRINTING','BLOCKED')
      JOIN print_attempt_steps ps ON ps.print_attempt_id = pa.id
        AND ps.status <> 'SUCCEEDED'
      JOIN printers p ON p.id = o.printer_id AND p.agent_id = o.claimed_by_agent_id
      JOIN order_files f ON f.id = COALESCE(pa.order_file_id,
        (SELECT legacy.id FROM order_files legacy WHERE legacy.order_id = o.id ORDER BY legacy.position LIMIT 1))
      JOIN installation i ON i.id = 1
      WHERE o.claimed_by_agent_id = ?
        AND o.status IN ('CLAIMED','SPOOLING','PRINTING','PRINT_BLOCKED')
      ORDER BY 
        CASE WHEN ps.status IN ('PENDING', 'SUBMISSION_STARTED') THEN 0 ELSE 1 END ASC,
        ps.sequence_number ASC 
      LIMIT 1`,
      )
      .bind(agentId)
      .first<JobRow>();
    return mapJob(row);
  }

  async claimOrRenew(
    agentId: string,
    nowMs: number,
  ): Promise<ClaimedPrintJobRecord | null> {
    // Empty queues must not run the recovery/claim write chain on every pulse.
    const work = await this.db
      .prepare(
        `SELECT 1 FROM orders
         WHERE status IN ('QUEUED','CLAIMED','SPOOLING','PRINTING','PRINT_BLOCKED','RETRY_PENDING')
            OR (status = 'PRINT_FAILED' AND cleanup_state = 'ACTIVE' AND updated_at_ms <= ?)
         LIMIT 1`,
      )
      .bind(nowMs - 60_000)
      .first();
    if (!work) return null;
    await this.recoverExpiredClaims(nowMs);
    await this.autoRetryEligibleOrders(nowMs);
    await this.finishOrphanedSuccess(agentId, nowMs);
    const existing = await this.findCurrent(agentId);
    if (existing && existing.leaseExpiresAtMs > nowMs) {
      // Leave fast jobs alone; renew only in the last third of the configured lease.
      if (existing.leaseExpiresAtMs - nowMs > PRINT_CLAIM_LEASE_MS / 3)
        return existing;
      const lease = nowMs + PRINT_CLAIM_LEASE_MS;
      await this.db
        .prepare(
          `UPDATE orders SET claim_expires_at_ms = ?, updated_at_ms = ?
         WHERE id = ? AND claimed_by_agent_id = ? AND claim_id = ?
           AND claim_expires_at_ms > ? AND claim_expires_at_ms <= ?
           AND status IN ('CLAIMED','SPOOLING','PRINTING','PRINT_BLOCKED')`,
        )
        .bind(
          lease,
          nowMs,
          existing.orderId,
          agentId,
          existing.claimId,
          nowMs,
          nowMs + PRINT_CLAIM_LEASE_MS / 3,
        )
        .run();
      // Re-read ownership: a concurrent completion/recovery must not receive a fabricated lease.
      return this.findCurrent(agentId);
    }

    const candidate = await this.db
      .prepare(
        `SELECT o.id order_id, p.id printer_id, i.identification_sheet_enabled,
        i.identification_sheet_placement, o.identification_required, f.id file_id, f.position file_position,
        (SELECT COUNT(*) FROM order_files all_files WHERE all_files.order_id = o.id) file_count,
        (SELECT COUNT(*) FROM order_files remaining WHERE remaining.order_id = o.id
          AND remaining.print_status <> 'PRINTED') remaining_files,
        CASE WHEN i.default_production_printer_id IS NOT NULL
                  AND p.id <> i.default_production_printer_id
             THEN i.default_production_printer_id
             ELSE NULL
        END AS fallback_from_printer_id
      FROM orders o
      JOIN order_files f ON f.order_id = o.id AND f.id = COALESCE((
        SELECT next_file.id FROM order_files next_file
        WHERE next_file.order_id = o.id AND next_file.print_status <> 'PRINTED'
        ORDER BY next_file.position LIMIT 1
      ), (SELECT last_file.id FROM order_files last_file
          WHERE last_file.order_id = o.id ORDER BY last_file.position DESC LIMIT 1))
      JOIN payments pay ON pay.order_id = o.id AND pay.status = 'PAID'
        AND pay.provider_payment_id IS NOT NULL AND pay.verified_at_ms IS NOT NULL
      JOIN agents a ON a.id = ? AND a.is_active = 1 AND a.last_heartbeat_at_ms >= ?
      JOIN printers p ON p.agent_id = a.id AND p.enabled = 1 AND p.status = 'ONLINE'
        AND COALESCE(p.is_paused, 0) = 0
        AND p.is_production_eligible = 1 AND p.is_virtual = 0
        AND p.capabilities_json IS NOT NULL
      JOIN installation i ON i.id = 1
        AND (
          i.default_production_printer_id IS NULL
          OR p.id = i.default_production_printer_id
          OR (
            -- Fallback: primary is unavailable and this printer is its configured fallback
            EXISTS (
              SELECT 1 FROM printers pp
              WHERE pp.id = i.default_production_printer_id
                AND pp.auto_fallback_enabled = 1
                AND pp.fallback_printer_id = p.id
                AND (pp.enabled = 0 OR pp.status <> 'ONLINE' OR COALESCE(pp.is_paused, 0) = 1)
            )
            -- Prevent loop: this printer's fallback must not be the primary
            AND COALESCE(p.fallback_printer_id, '') <> i.default_production_printer_id
          )
        )
      WHERE ((o.status = 'QUEUED') OR (o.status = 'RETRY_PENDING' AND (o.next_retry_at_ms IS NULL OR o.next_retry_at_ms <= ?)))
        AND o.public_job_code IS NOT NULL
        AND o.cleanup_state = 'ACTIVE' AND f.upload_status = 'UPLOADED'
        AND f.size_bytes IS NOT NULL
        AND (f.position <> 1 OR EXISTS (SELECT 1 FROM uploads u
          WHERE u.order_id = o.id AND u.r2_object_key = f.r2_object_key
            AND u.storage_status = 'UPLOADED'))
        AND (f.color_mode = 'BW' OR json_extract(p.capabilities_json, '$.colour') = 1 OR json_extract(p.capabilities_json, '$.colour') = 'UNKNOWN')
        AND (f.sides = 'SINGLE' OR json_extract(p.capabilities_json, '$.duplex') = 1 OR json_extract(p.capabilities_json, '$.duplex') = 'UNKNOWN' OR json_extract(p.capabilities_json, '$.duplex') IS NULL OR json_extract(p.capabilities_json, '$.duplex') = 0)
        AND EXISTS (SELECT 1 FROM json_each(p.capabilities_json, '$.paperSizes')
          WHERE upper(value) = f.paper_size)
        AND NOT EXISTS (SELECT 1 FROM orders busy WHERE busy.claimed_by_agent_id = a.id
          AND busy.status IN ('CLAIMED','SPOOLING','PRINTING','PRINT_BLOCKED'))
      ORDER BY o.is_priority DESC, (CASE WHEN o.status = 'QUEUED' THEN 0 ELSE 1 END) ASC, o.queued_at_ms ASC, o.id, p.id LIMIT 1`,
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
      candidate.identification_required === 1 &&
      !succeededSet.has("IDENTIFICATION_SHEET") &&
      ((candidate.identification_sheet_placement === "FIRST" &&
        candidate.file_position === 1) ||
        (candidate.identification_sheet_placement === "LAST" &&
          candidate.remaining_files === 1));
    const needDocStep = candidate.remaining_files > 0;

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
        WHERE id = ? AND status IN ('QUEUED', 'RETRY_PENDING') AND cleanup_state = 'ACTIVE' AND EXISTS (
          SELECT 1 FROM payments WHERE order_id = orders.id AND status = 'PAID'
            AND provider_payment_id IS NOT NULL AND verified_at_ms IS NOT NULL
        ) AND EXISTS (
          SELECT 1 FROM order_files WHERE id = ? AND order_id = orders.id
            AND upload_status = 'UPLOADED' AND size_bytes IS NOT NULL
        ) AND EXISTS (
          SELECT 1 FROM printers p JOIN agents a ON a.id = p.agent_id
          WHERE p.id = ? AND p.agent_id = ? AND p.enabled = 1 AND p.status = 'ONLINE'
            AND p.is_production_eligible = 1 AND p.is_virtual = 0
            AND a.is_active = 1 AND a.last_heartbeat_at_ms >= ?
            AND p.capabilities_json IS NOT NULL
            AND ((SELECT color_mode FROM order_files WHERE id = ?) = 'BW'
              OR json_extract(p.capabilities_json, '$.colour') = 1 OR json_extract(p.capabilities_json, '$.colour') = 'UNKNOWN')
            AND ((SELECT sides FROM order_files WHERE id = ?) = 'SINGLE'
              OR json_extract(p.capabilities_json, '$.duplex') = 1 OR json_extract(p.capabilities_json, '$.duplex') = 'UNKNOWN' OR json_extract(p.capabilities_json, '$.duplex') IS NULL OR json_extract(p.capabilities_json, '$.duplex') = 0)
            AND EXISTS (SELECT 1 FROM json_each(p.capabilities_json, '$.paperSizes')
              WHERE upper(value) = (SELECT paper_size FROM order_files WHERE id = ?))
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
          candidate.file_id,
          candidate.printer_id,
          agentId,
          nowMs - 90_000,
          candidate.file_id,
          candidate.file_id,
          candidate.file_id,
        ),
      this.db
        .prepare(
          `INSERT INTO print_attempts (id, order_id, attempt_number, agent_id, printer_id,
          status, identification_sheet_included, created_at_ms, updated_at_ms,
          order_file_id, file_position, fallback_from_printer_id)
        SELECT ?, id, COALESCE((SELECT MAX(attempt_number) + 1 FROM print_attempts
          WHERE order_id = orders.id), 1), ?, ?, 'CREATED', ?, ?, ?, ?, ?, ?
        FROM orders WHERE id = ? AND claim_id = ? AND claimed_by_agent_id = ?`,
        )
        .bind(
          attemptId,
          agentId,
          candidate.printer_id,
          needIdStep ? 1 : 0,
          nowMs,
          nowMs,
          candidate.file_id,
          candidate.file_position,
          candidate.fallback_from_printer_id,
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
          ps.step_type, pa.order_file_id, o.claim_id
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
    if (row.step_type === "CUSTOMER_DOCUMENT" && row.order_file_id) {
      await this.db
        .prepare(
          `UPDATE order_files SET print_status = 'PRINTED', printed_at_ms = ?,
           updated_at_ms = ? WHERE id = ? AND order_id = ?
             AND print_status <> 'PRINTED'`,
        )
        .bind(nowMs, nowMs, row.order_file_id, row.order_id)
        .run();
    }
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
        ps.spooler_job_id, o.status order_status, ps.step_type, pa.order_file_id
      FROM orders o JOIN print_attempts pa ON pa.order_id = o.id
      JOIN print_attempt_steps ps ON ps.print_attempt_id = pa.id
      WHERE o.id = ? AND ps.id = ? AND o.claimed_by_agent_id = ?
        AND o.claim_id = ? AND o.claim_expires_at_ms > ?
        AND o.cleanup_state = 'ACTIVE'`,
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
        WHERE id = ? AND print_attempt_id = ? AND status = 'PENDING'
          AND EXISTS (SELECT 1 FROM orders o
            WHERE o.id = print_attempt_steps.order_id AND o.cleanup_state = 'ACTIVE'
              AND o.claim_id = ?)`,
        )
        .bind(
          input.nowMs,
          input.nowMs,
          input.stepId,
          current.attempt_id,
          input.claimId,
        ),
      this.db
        .prepare(
          `UPDATE print_attempts SET status = 'SUBMITTING', updated_at_ms = ?
        WHERE id = ? AND status IN ('CREATED','PRINTING') AND changes() = 1`,
        )
        .bind(input.nowMs, current.attempt_id),
      this.db
        .prepare(
          `UPDATE orders SET status = ?, print_started_at_ms = COALESCE(print_started_at_ms, ?),
          claim_expires_at_ms = ?, updated_at_ms = ? WHERE id = ? AND claim_id = ?
          AND status IN ('CLAIMED','PRINTING') AND changes() = 1`,
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
          actor_type, actor_id, created_at_ms) SELECT ?, ?, 'PRINT_STEP_STARTED', ?,
          ?, 'AGENT', ?, ? WHERE changes() = 1`,
        )
        .bind(
          crypto.randomUUID(),
          input.orderId,
          current.order_status,
          nextOrderStatus,
          input.agentId,
          input.nowMs,
        ),
      this.db
        .prepare(
          `UPDATE order_files SET print_status = 'SUBMISSION_STARTED',
           submission_started_at_ms = COALESCE(submission_started_at_ms, ?),
           updated_at_ms = ?
           WHERE id = ? AND ? = 'CUSTOMER_DOCUMENT'
             AND EXISTS (SELECT 1 FROM print_attempt_steps
               WHERE id = ? AND status = 'SUBMISSION_STARTED')`,
        )
        .bind(
          input.nowMs,
          input.nowMs,
          current.order_file_id,
          current.step_type,
          input.stepId,
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
        WHERE id = ? AND status = 'SUBMISSION_STARTED' AND spooler_job_id IS NULL
          AND EXISTS (SELECT 1 FROM orders o
            WHERE o.id = print_attempt_steps.order_id AND o.cleanup_state = 'ACTIVE'
              AND o.claim_id = ?)`,
        )
        .bind(
          input.spoolerJobId,
          input.nowMs,
          input.nowMs,
          input.nowMs,
          input.stepId,
          input.claimId,
        ),
      this.db
        .prepare(
          `UPDATE print_attempts SET status = 'PRINTING', windows_job_id = COALESCE(windows_job_id, ?),
          submitted_at_ms = COALESCE(submitted_at_ms, ?), last_observed_at_ms = ?, updated_at_ms = ?
        WHERE id = ? AND changes() = 1`,
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
        WHERE id = ? AND claim_id = ? AND status IN ('SPOOLING','PRINT_BLOCKED') AND changes() = 1`,
        )
        .bind(lease, input.nowMs, input.orderId, input.claimId),
      this.db
        .prepare(
          `UPDATE order_files SET print_status = 'SUBMITTED', spooler_job_id = ?,
           submitted_at_ms = COALESCE(submitted_at_ms, ?), updated_at_ms = ?
           WHERE id = ? AND ? = 'CUSTOMER_DOCUMENT'
             AND EXISTS (SELECT 1 FROM print_attempt_steps
               WHERE id = ? AND status = 'SUBMITTED' AND spooler_job_id = ?)`,
        )
        .bind(
          input.spoolerJobId,
          input.nowMs,
          input.nowMs,
          current.order_file_id,
          current.step_type,
          input.stepId,
          input.spoolerJobId,
        ),
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
        (input.status === "FAILED" || input.status === "BLOCKED") &&
        ["PENDING", "SUBMISSION_STARTED"].includes(current.step_status)
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
    function toStepFailureCode(code: string | null | undefined): string | null {
      if (!code) return null;
      const upper = code.trim().toUpperCase();
      const allowed = [
        "PAPER_OUT",
        "PAPER_JAM",
        "OFFLINE",
        "NO_TONER",
        "TONER_LOW",
        "DOOR_OPEN",
        "USER_INTERVENTION",
        "PRINTER_ERROR",
        "UNKNOWN",
      ];
      if (allowed.includes(upper)) {
        return upper;
      }
      if (upper === "PRINTER_OFFLINE" || upper === "CONNECTION_LOST")
        return "OFFLINE";
      if (upper === "SPOOLER_ERROR") return "PRINTER_ERROR";
      return "UNKNOWN";
    }

    const stepFailureCode = toStepFailureCode(input.failureCode);
    const finished = input.status === "BLOCKED" ? null : input.nowMs;
    const stepUpdate = await this.db
      .prepare(
        `UPDATE print_attempt_steps SET status = ?, spooler_job_id = COALESCE(spooler_job_id, ?),
        failure_code = ?, failure_detail = ?, last_observed_at_ms = ?, finished_at_ms = ?,
        updated_at_ms = ? WHERE id = ? AND status = ?
          AND EXISTS (SELECT 1 FROM orders o
            WHERE o.id = print_attempt_steps.order_id AND o.cleanup_state = 'ACTIVE'
              AND o.claim_id = ?)`,
      )
      .bind(
        input.status,
        input.spoolerJobId,
        stepFailureCode,
        input.failureDetail,
        input.nowMs,
        finished,
        input.nowMs,
        input.stepId,
        current.step_status,
        input.claimId,
      )
      .run();
    if (stepUpdate.meta.changes !== 1) return null;
    if (current.step_type === "CUSTOMER_DOCUMENT" && current.order_file_id) {
      const fileStatus =
        input.status === "SUCCEEDED" ? "PRINTED" : input.status;
      await this.db
        .prepare(
          `UPDATE order_files SET print_status = ?,
           spooler_job_id = COALESCE(spooler_job_id, ?),
           printed_at_ms = CASE WHEN ? = 'PRINTED' THEN ? ELSE printed_at_ms END,
           updated_at_ms = ? WHERE id = ?
             AND EXISTS (SELECT 1 FROM orders o
               WHERE o.id = order_files.order_id AND o.cleanup_state = 'ACTIVE')`,
        )
        .bind(
          fileStatus,
          input.spoolerJobId,
          fileStatus,
          input.nowMs,
          input.nowMs,
          current.order_file_id,
        )
        .run();
    }

    const normFailure = normalizePrinterFailure(
      input.failureCode || input.failureDetail,
    );
    const printerWide = isPrinterWideFailure(normFailure);

    if (
      input.status === "BLOCKED" ||
      (input.status === "FAILED" && printerWide)
    ) {
      const printerRow = await this.db
        .prepare("SELECT printer_id FROM orders WHERE id = ?")
        .bind(input.orderId)
        .first<{ printer_id: string | null }>();

      const statements: D1PreparedStatement[] = [
        this.db
          .prepare(
            "UPDATE print_attempts SET status = 'BLOCKED', failure_code = ?, failure_detail = ?, last_observed_at_ms = ?, updated_at_ms = ? WHERE id = ?",
          )
          .bind(
            stepFailureCode,
            input.failureDetail,
            input.nowMs,
            input.nowMs,
            current.attempt_id,
          ),
        this.db
          .prepare(
            `UPDATE orders
             SET status = 'PRINT_BLOCKED', error_category = ?, raw_error = ?,
                 claim_expires_at_ms = ?, updated_at_ms = ?
             WHERE id = ? AND claim_id = ?`,
          )
          .bind(
            normFailure,
            input.failureDetail ?? input.failureCode ?? "Printer is blocked",
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
      ];

      if (printerRow?.printer_id) {
        statements.push(
          this.db
            .prepare(
              `UPDATE printers
               SET is_paused = 1, paused_reason = ?,
                   paused_at_ms = COALESCE(paused_at_ms, ?), updated_at_ms = ?
               WHERE id = ? AND (is_paused = 0 OR paused_reason <> ?)`,
            )
            .bind(
              normFailure,
              input.nowMs,
              input.nowMs,
              printerRow.printer_id,
              normFailure,
            ),
        );
      }

      await this.db.batch(statements);
    } else if (input.status === "UNCERTAIN") {
      const orderMeta = await this.db
        .prepare("SELECT attempt_count FROM orders WHERE id = ?")
        .bind(input.orderId)
        .first<{ attempt_count: number }>();
      const currentAttempts = (orderMeta?.attempt_count ?? 0) + 1;

      await this.db.batch([
        this.db
          .prepare(
            "UPDATE print_attempts SET status = 'FAILED', failure_code = ?, failure_detail = ?, finished_at_ms = ?, updated_at_ms = ? WHERE id = ?",
          )
          .bind(
            "UNKNOWN",
            input.failureDetail ?? "Print outcome uncertain",
            input.nowMs,
            input.nowMs,
            current.attempt_id,
          ),
        this.db
          .prepare(
            `UPDATE orders
             SET status = 'COMPLETION_UNKNOWN', claimed_by_agent_id = NULL, claim_id = NULL,
                 claim_expires_at_ms = NULL, error_category = 'COMPLETION_UNKNOWN',
                 raw_error = ?, attempt_count = ?, last_attempt_at_ms = ?, updated_at_ms = ?
             WHERE id = ? AND claim_id = ?`,
          )
          .bind(
            input.failureDetail ??
              "Print outcome uncertain / completion unknown",
            currentAttempts,
            input.nowMs,
            input.nowMs,
            input.orderId,
            input.claimId,
          ),
        this.event(
          input.orderId,
          "PRINT_OUTCOME_UNCERTAIN",
          current.order_status,
          "COMPLETION_UNKNOWN",
          input.agentId,
          input.nowMs,
        ),
      ]);
    } else if (input.status === "FAILED") {
      const orderMeta = await this.db
        .prepare("SELECT attempt_count FROM orders WHERE id = ?")
        .bind(input.orderId)
        .first<{ attempt_count: number }>();
      const currentAttempts = (orderMeta?.attempt_count ?? 0) + 1;

      if (currentAttempts < 3) {
        const statements: D1PreparedStatement[] = [
          this.db
            .prepare(
              "UPDATE print_attempts SET status = 'FAILED', failure_code = ?, failure_detail = ?, finished_at_ms = ?, updated_at_ms = ? WHERE id = ?",
            )
            .bind(
              stepFailureCode,
              input.failureDetail,
              input.nowMs,
              input.nowMs,
              current.attempt_id,
            ),
          this.db
            .prepare(
              `UPDATE orders
               SET status = 'RETRY_PENDING', claimed_by_agent_id = NULL, claim_id = NULL,
                   claim_expires_at_ms = NULL, error_category = ?, raw_error = ?,
                   attempt_count = ?, last_attempt_at_ms = ?, next_retry_at_ms = ?,
                   updated_at_ms = ?
               WHERE id = ? AND claim_id = ?`,
            )
            .bind(
              normFailure,
              input.failureDetail ?? input.failureCode ?? "Print failed",
              currentAttempts,
              input.nowMs,
              input.nowMs + 10_000,
              input.nowMs,
              input.orderId,
              input.claimId,
            ),
          this.event(
            input.orderId,
            "PRINT_RETRY_PENDING",
            current.order_status,
            "RETRY_PENDING",
            input.agentId,
            input.nowMs,
          ),
        ];

        await this.db.batch(statements);
      } else {
        await this.db.batch([
          this.db
            .prepare(
              "UPDATE print_attempts SET status = 'FAILED', failure_code = ?, failure_detail = ?, finished_at_ms = ?, updated_at_ms = ? WHERE id = ?",
            )
            .bind(
              stepFailureCode,
              input.failureDetail,
              input.nowMs,
              input.nowMs,
              current.attempt_id,
            ),
          this.db
            .prepare(
              `UPDATE orders
               SET status = 'NEEDS_ADMIN', claimed_by_agent_id = NULL, claim_id = NULL,
                   claim_expires_at_ms = NULL, error_category = ?, raw_error = ?,
                   attempt_count = ?, last_attempt_at_ms = ?, next_retry_at_ms = NULL,
                   updated_at_ms = ?
               WHERE id = ? AND claim_id = ?`,
            )
            .bind(
              normFailure,
              input.failureDetail ??
                input.failureCode ??
                "Print failed after retries",
              currentAttempts,
              input.nowMs,
              input.nowMs,
              input.orderId,
              input.claimId,
            ),
          this.event(
            input.orderId,
            "PRINT_NEEDS_ADMIN",
            current.order_status,
            "NEEDS_ADMIN",
            input.agentId,
            input.nowMs,
          ),
        ]);
      }
    } else {
      if (!(await this.completeAttemptIfReady(current, input))) {
        await this.db.batch([
          this.db
            .prepare(
              "UPDATE print_attempts SET status = 'PRINTING', failure_code = NULL, failure_detail = NULL, last_observed_at_ms = ?, updated_at_ms = ? WHERE id = ? AND (status <> 'PRINTING' OR failure_code IS NOT NULL OR failure_detail IS NOT NULL)",
            )
            .bind(input.nowMs, input.nowMs, current.attempt_id),
          this.db
            .prepare(
              "UPDATE orders SET status = 'PRINTING', claim_expires_at_ms = ?, updated_at_ms = ? WHERE id = ? AND claim_id = ? AND (status <> 'PRINTING' OR claim_expires_at_ms <= ?)",
            )
            .bind(
              input.nowMs + PRINT_CLAIM_LEASE_MS,
              input.nowMs,
              input.orderId,
              input.claimId,
              input.nowMs + PRINT_CLAIM_LEASE_MS / 3,
            ),
        ]);
      }
    }
    return (
      (await this.findOwnedStep({ ...input, nowMs: input.nowMs })) ?? {
        ...current,
        step_status: input.status,
        order_status:
          input.status === "SUCCEEDED" ? "QUEUED" : current.order_status,
      }
    );
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
    const remainingFiles = await this.db
      .prepare(
        `SELECT COUNT(*) count FROM order_files
         WHERE order_id = ? AND print_status <> 'PRINTED'`,
      )
      .bind(input.orderId)
      .first<{ count: number }>();
    if ((remainingFiles?.count ?? 1) > 0) {
      await this.db.batch([
        this.db
          .prepare(
            `UPDATE print_attempts SET status = 'SUCCEEDED',
             finished_at_ms = COALESCE(finished_at_ms, ?), updated_at_ms = ?
             WHERE id = ? AND status <> 'SUCCEEDED'`,
          )
          .bind(input.nowMs, input.nowMs, current.attempt_id),
        this.db
          .prepare(
            `UPDATE orders SET status = 'QUEUED', claimed_by_agent_id = NULL,
             claim_id = NULL, claim_expires_at_ms = NULL, printer_id = NULL,
             claimed_at_ms = NULL, error_category = NULL, raw_error = NULL, next_retry_at_ms = NULL, updated_at_ms = ?
             WHERE id = ? AND claim_id = ?`,
          )
          .bind(input.nowMs, input.orderId, input.claimId),
        this.db
          .prepare(
            `INSERT OR IGNORE INTO order_events
             (id, order_id, event_type, from_status, to_status, actor_type,
              actor_id, idempotency_key, created_at_ms)
             VALUES (?, ?, 'ORDER_FILE_PRINTED', ?, 'QUEUED', 'AGENT', ?, ?, ?)`,
          )
          .bind(
            crypto.randomUUID(),
            input.orderId,
            current.order_status,
            input.agentId,
            `print-attempt:${current.attempt_id}:file-complete`,
            input.nowMs,
          ),
      ]);
      return true;
    }
    // Check if any POST_PRINT addon services require staff finishing before completion
    const postPrintCheck = await this.db
      .prepare(
        `SELECT 1 FROM order_addon_services
         WHERE order_id = ? AND snapshot_handling_mode = 'POST_PRINT'
         LIMIT 1`,
      )
      .bind(input.orderId)
      .first<{ 1: number }>();
    const hasPostPrint = postPrintCheck !== null;

    if (hasPostPrint) {
      // POST_PRINT: go to AWAITING_FINISHING; admin must Mark Finished to complete
      await this.db.batch([
        this.db
          .prepare(
            "UPDATE print_attempts SET status = 'SUCCEEDED', finished_at_ms = COALESCE(finished_at_ms, ?), updated_at_ms = ? WHERE id = ? AND status <> 'SUCCEEDED'",
          )
          .bind(input.nowMs, input.nowMs, current.attempt_id),
        this.db
          .prepare(
            "UPDATE orders SET status = 'AWAITING_FINISHING', printed_at_ms = COALESCE(printed_at_ms, ?), claimed_by_agent_id = NULL, claim_id = NULL, claim_expires_at_ms = NULL, error_category = NULL, raw_error = NULL, next_retry_at_ms = NULL, updated_at_ms = ? WHERE id = ? AND claim_id = ? AND status <> 'AWAITING_FINISHING'",
          )
          .bind(input.nowMs, input.nowMs, input.orderId, input.claimId),
        this.db
          .prepare(
            `INSERT OR IGNORE INTO order_events (id, order_id, event_type, from_status,
              to_status, actor_type, actor_id, idempotency_key, created_at_ms)
            VALUES (?, ?, 'ORDER_PRINTED', ?, 'AWAITING_FINISHING', 'AGENT', ?, ?, ?)`,
          )
          .bind(
            crypto.randomUUID(),
            input.orderId,
            current.order_status,
            input.agentId,
            `print-attempt:${current.attempt_id}:printed`,
            input.nowMs,
          ),
      ]);
    } else {
      // AUTO: transition directly to COMPLETED
      await this.db.batch([
        this.db
          .prepare(
            "UPDATE print_attempts SET status = 'SUCCEEDED', finished_at_ms = COALESCE(finished_at_ms, ?), updated_at_ms = ? WHERE id = ? AND status <> 'SUCCEEDED'",
          )
          .bind(input.nowMs, input.nowMs, current.attempt_id),
        this.db
          .prepare(
            // PRINTED and COMPLETED already shared one atomic batch. Keep both forensic events below.
            `UPDATE orders SET status = 'COMPLETED', printed_at_ms = COALESCE(printed_at_ms, ?),
             completed_at_ms = COALESCE(completed_at_ms, ?), purge_at_ms = COALESCE(purge_at_ms, ?),
             error_category = NULL, raw_error = NULL, next_retry_at_ms = NULL, updated_at_ms = ?
             WHERE id = ? AND claim_id = ? AND status IN ('CLAIMED','SPOOLING','PRINTING','PRINT_BLOCKED')
               AND EXISTS (SELECT 1 FROM order_files WHERE order_id = orders.id)
               AND NOT EXISTS (SELECT 1 FROM order_files
                 WHERE order_id = orders.id AND print_status <> 'PRINTED')
               AND NOT EXISTS (SELECT 1 FROM order_addon_services
                 WHERE order_id = orders.id AND snapshot_handling_mode IN ('MANUAL_PRINT','POST_PRINT'))`,
          )
          .bind(
            input.nowMs,
            input.nowMs,
            input.nowMs + COMPLETED_RETENTION_MS,
            input.nowMs,
            input.orderId,
            input.claimId,
          ),
        this.db
          .prepare(
            `UPDATE uploads SET retention_reason = 'COMPLETED', delete_after_ms = ?, updated_at_ms = ?
             WHERE order_id = ? AND storage_status = 'UPLOADED' AND retention_reason IS NOT 'COMPLETED'
               AND EXISTS (SELECT 1 FROM orders WHERE id = uploads.order_id AND status = 'COMPLETED')`,
          )
          .bind(
            input.nowMs + COMPLETED_RETENTION_MS,
            input.nowMs,
            input.orderId,
          ),
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
            SELECT ?, o.id, 'ORDER_COMPLETED', 'PRINTED', 'COMPLETED', 'AGENT', ?, ?, ?
            FROM orders o WHERE o.id = ? AND o.status = 'COMPLETED'`,
          )
          .bind(
            crypto.randomUUID(),
            input.agentId,
            `print-attempt:${current.attempt_id}:completed`,
            input.nowMs,
            input.orderId,
          ),
      ]);
    }
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
            SELECT id, public_job_code, pickup_code, is_priority, identification_required,
              customer_name, customer_phone,
              selected_pages, copies, paper_size, color_mode, sides,
              total_amount_paise, currency, status, claimed_by_agent_id, printer_id,
              error_category, raw_error, attempt_count, last_attempt_at_ms, next_retry_at_ms,
              paid_at_ms, updated_at_ms
            FROM orders
            WHERE status IN ('QUEUED','CLAIMED','SPOOLING','PRINTING','PRINT_BLOCKED',
              'PRINT_FAILED','ADMIN_ACTION_REQUIRED','RETRY_PENDING','NEEDS_ADMIN','COMPLETION_UNKNOWN')
            UNION ALL
            SELECT id, public_job_code, pickup_code, is_priority, identification_required,
              customer_name, customer_phone,
              selected_pages, copies, paper_size, color_mode, sides,
              total_amount_paise, currency, status, claimed_by_agent_id, printer_id,
              error_category, raw_error, attempt_count, last_attempt_at_ms, next_retry_at_ms,
              paid_at_ms, updated_at_ms
            FROM orders
            WHERE status = 'PRINTED' AND updated_at_ms >= ?
          )
          ORDER BY updated_at_ms DESC
          LIMIT 100
        )
        SELECT o.id order_id, o.public_job_code, o.pickup_code, o.is_priority, o.identification_required,
          o.customer_name, o.customer_phone,
          o.selected_pages, o.copies, o.paper_size, o.color_mode, o.sides,
          o.total_amount_paise, o.currency, o.status, a.display_name agent_name,
          p.display_name printer_name, pa.failure_detail,
          o.error_category, o.raw_error, o.attempt_count, o.last_attempt_at_ms, o.next_retry_at_ms,
          o.paid_at_ms, o.updated_at_ms
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
        pickup_code: string | null;
        is_priority: number;
        identification_required: number;
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
        error_category: string | null;
        raw_error: string | null;
        attempt_count: number;
        last_attempt_at_ms: number | null;
        next_retry_at_ms: number | null;
        paid_at_ms: number;
        updated_at_ms: number;
      }>();
    return result.results.map((row) => ({
      orderId: row.order_id,
      jobCode: row.public_job_code,
      pickupCode: row.pickup_code ?? null,
      isPriority: row.is_priority === 1,
      identificationRequired: row.identification_required === 1,
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
      issue: row.raw_error ?? row.failure_detail ?? null,
      errorCategory: row.error_category ?? null,
      rawError: row.raw_error ?? null,
      attemptCount: row.attempt_count ?? 0,
      lastAttemptAt: row.last_attempt_at_ms
        ? new Date(row.last_attempt_at_ms).toISOString()
        : null,
      nextRetryAt: row.next_retry_at_ms
        ? new Date(row.next_retry_at_ms).toISOString()
        : null,
      paidAt: new Date(row.paid_at_ms).toISOString(),
      updatedAt: new Date(row.updated_at_ms).toISOString(),
    }));
  }

  async findUploadByOrderId(orderId: string): Promise<{
    r2_object_key: string;
    storage_status: string;
    deleted_at_ms: number | null;
    delete_after_ms: number | null;
  } | null> {
    return this.db
      .prepare(
        `SELECT r2_object_key, storage_status, deleted_at_ms, delete_after_ms FROM uploads WHERE order_id = ?`,
      )
      .bind(orderId)
      .first<{
        r2_object_key: string;
        storage_status: string;
        deleted_at_ms: number | null;
        delete_after_ms: number | null;
      }>();
  }

  async manualComplete(input: {
    orderId: string;
    adminId: string;
    reason?: string;
    nowMs: number;
  }): Promise<{ orderId: string; status: "COMPLETED" | "AWAITING_FINISHING" }> {
    const order = await this.db
      .prepare(`SELECT id, status, cleanup_state FROM orders WHERE id = ?`)
      .bind(input.orderId)
      .first<{ id: string; status: string; cleanup_state: string }>();

    if (!order) {
      throw new Error("ORDER_NOT_FOUND");
    }
    if (order.cleanup_state !== "ACTIVE") {
      throw new Error("ORDER_CANNOT_BE_COMPLETED");
    }

    if (order.status === "COMPLETED") {
      return { orderId: order.id, status: "COMPLETED" };
    }
    const reason = input.reason?.trim();
    if (!reason || reason.length > 500)
      throw new Error("ORDER_CONFIRMATION_REQUIRED");
    if (
      ![
        "NEEDS_ADMIN",
        "COMPLETION_UNKNOWN",
        "RETRY_PENDING",
        "PRINT_FAILED",
        "ADMIN_ACTION_REQUIRED",
        "PRINTED",
      ].includes(order.status)
    )
      throw new Error("ORDER_CANNOT_BE_COMPLETED");

    const hasFinishing = await this.db
      .prepare(
        `SELECT 1 AS required FROM order_addon_services
       WHERE order_id = ? AND snapshot_handling_mode = 'POST_PRINT' LIMIT 1`,
      )
      .bind(input.orderId)
      .first<{ required: number }>();
    const nextStatus = hasFinishing ? "AWAITING_FINISHING" : "COMPLETED";
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `UPDATE orders SET status = ?, printed_at_ms = COALESCE(printed_at_ms, ?),
         completed_at_ms = ?, purge_at_ms = ?, claimed_by_agent_id = NULL,
         claim_id = NULL, claim_expires_at_ms = NULL, updated_at_ms = ?
         WHERE id = ? AND cleanup_state = 'ACTIVE'
           AND status IN ('NEEDS_ADMIN','COMPLETION_UNKNOWN','RETRY_PENDING',
             'PRINT_FAILED','ADMIN_ACTION_REQUIRED','PRINTED')
           AND EXISTS (SELECT 1 FROM order_files WHERE order_id = orders.id)
           AND NOT EXISTS (SELECT 1 FROM print_attempt_steps
             WHERE order_id = orders.id AND status IN ('SUBMISSION_STARTED','SUBMITTED'))`,
        )
        .bind(
          nextStatus,
          input.nowMs,
          hasFinishing ? null : input.nowMs,
          hasFinishing ? null : input.nowMs + COMPLETED_RETENTION_MS,
          input.nowMs,
          input.orderId,
        ),
      this.db
        .prepare(
          `UPDATE order_files SET print_status = 'PRINTED',
         printed_at_ms = COALESCE(printed_at_ms, ?), updated_at_ms = ?
         WHERE order_id = ? AND print_status <> 'PRINTED'
           AND EXISTS (SELECT 1 FROM orders WHERE id = ? AND status = ?)`,
        )
        .bind(
          input.nowMs,
          input.nowMs,
          input.orderId,
          input.orderId,
          nextStatus,
        ),
      this.db
        .prepare(
          `UPDATE uploads SET retention_reason = 'COMPLETED', delete_after_ms = ?,
         updated_at_ms = ? WHERE order_id = ? AND storage_status = 'UPLOADED'
           AND EXISTS (SELECT 1 FROM orders WHERE id = ? AND status = 'COMPLETED')`,
        )
        .bind(
          input.nowMs + COMPLETED_RETENTION_MS,
          input.nowMs,
          input.orderId,
          input.orderId,
        ),
      this.db
        .prepare(
          `INSERT INTO order_events (id, order_id, event_type, from_status,
          to_status, actor_type, actor_id, details_json, created_at_ms)
         SELECT ?, id, 'ORDER_MANUALLY_COMPLETED', ?, ?, 'ADMIN', ?, ?, ?
         FROM orders WHERE id = ? AND status = ?`,
        )
        .bind(
          crypto.randomUUID(),
          order.status,
          nextStatus,
          input.adminId,
          JSON.stringify({ confirmation: reason }),
          input.nowMs,
          input.orderId,
          nextStatus,
        ),
    ];
    const results = await this.db.batch(statements);
    if (results[0]?.meta.changes !== 1)
      throw new Error("ORDER_CANNOT_BE_COMPLETED");
    return { orderId: input.orderId, status: nextStatus };
  }

  async retryOrder(input: {
    orderId: string;
    adminId: string;
    forceUncertain?: boolean;
    nowMs: number;
  }): Promise<{ orderId: string; status: "QUEUED" }> {
    const order = await this.db
      .prepare(`SELECT id, status, cleanup_state FROM orders WHERE id = ?`)
      .bind(input.orderId)
      .first<{ id: string; status: string; cleanup_state: string }>();

    if (!order) {
      throw new Error("ORDER_NOT_FOUND");
    }
    if (order.cleanup_state !== "ACTIVE") {
      throw new Error("ORDER_CANNOT_BE_RETRIED");
    }

    const retriableStatuses = [
      "ADMIN_ACTION_REQUIRED",
      "PRINT_FAILED",
      "PRINT_BLOCKED",
      "NEEDS_ADMIN",
      "COMPLETION_UNKNOWN",
      "RETRY_PENDING",
      "COMPLETED",
      "PRINTED",
      "PAYMENT_PENDING",
      "PAID",
    ];

    if (!retriableStatuses.includes(order.status)) {
      throw new Error("ORDER_CANNOT_BE_RETRIED");
    }

    if (
      (order.status === "ADMIN_ACTION_REQUIRED" ||
        order.status === "COMPLETION_UNKNOWN") &&
      !input.forceUncertain
    ) {
      throw new Error("UNCERTAIN_RETRY_CONFIRMATION_REQUIRED");
    }

    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `UPDATE orders
           SET status = 'QUEUED', claimed_by_agent_id = NULL, claim_id = NULL,
               claim_expires_at_ms = NULL, printer_id = NULL, claimed_at_ms = NULL,
               error_category = NULL, raw_error = NULL, attempt_count = 0,
               next_retry_at_ms = NULL, queued_at_ms = ?, updated_at_ms = ?
           WHERE id = ? AND cleanup_state = 'ACTIVE'
             AND status IN ('ADMIN_ACTION_REQUIRED','PRINT_FAILED','PRINT_BLOCKED','NEEDS_ADMIN','COMPLETION_UNKNOWN','RETRY_PENDING','COMPLETED','PRINTED','PAYMENT_PENDING','PAID')`,
        )
        .bind(input.nowMs, input.nowMs, input.orderId),
      this.db
        .prepare(
          `UPDATE print_attempts
           SET status = 'CANCELLED', finished_at_ms = COALESCE(finished_at_ms, ?),
               updated_at_ms = ?
           WHERE order_id = ? AND status NOT IN ('SUCCEEDED', 'CANCELLED')
             AND EXISTS (SELECT 1 FROM orders WHERE id = ?
               AND cleanup_state = 'ACTIVE' AND status = 'QUEUED')`,
        )
        .bind(input.nowMs, input.nowMs, input.orderId, input.orderId),
      this.db
        .prepare(
          order.status === "COMPLETED" || order.status === "PRINTED"
            ? `UPDATE order_files
               SET print_status = 'PENDING', spooler_job_id = NULL, updated_at_ms = ?
               WHERE order_id = ?`
            : `UPDATE order_files
               SET print_status = 'PENDING', spooler_job_id = NULL, updated_at_ms = ?
               WHERE order_id = ? AND print_status <> 'PRINTED'`,
        )
        .bind(input.nowMs, input.orderId),
      this.db
        .prepare(
          `INSERT INTO order_events (
             id, order_id, event_type, from_status, to_status,
             actor_type, actor_id, created_at_ms
           ) SELECT ?, o.id, 'ORDER_PRINT_RETRY_REQUESTED', ?, 'QUEUED', 'ADMIN', ?, ?
             FROM orders o WHERE o.id = ? AND o.cleanup_state = 'ACTIVE'
               AND o.status = 'QUEUED'`,
        )
        .bind(
          crypto.randomUUID(),
          order.status,
          input.adminId,
          input.nowMs,
          input.orderId,
        ),
      this.db
        .prepare(
          `INSERT INTO audit_logs (
             id, actor_type, actor_id, action, entity_type, entity_id, created_at_ms
           ) SELECT ?, 'ADMIN', ?, 'ORDER_PRINT_RETRY', 'ORDER', o.id, ?
             FROM orders o WHERE o.id = ? AND o.cleanup_state = 'ACTIVE'
               AND o.status = 'QUEUED'`,
        )
        .bind(crypto.randomUUID(), input.adminId, input.nowMs, input.orderId),
    ];

    const results = await this.db.batch(statements);
    if (results[0]?.meta.changes !== 1)
      throw new Error("ORDER_CANNOT_BE_RETRIED");
    return { orderId: input.orderId, status: "QUEUED" };
  }

  async autoRetryEligibleOrders(
    nowMs: number,
  ): Promise<{ retriedCount: number }> {
    const candidates = await this.db
      .prepare(
        `SELECT id, status FROM orders
         WHERE cleanup_state = 'ACTIVE'
           AND status = 'PRINT_FAILED'
           AND updated_at_ms <= ?
           AND (SELECT COUNT(*) FROM print_attempts WHERE order_id = orders.id) < 5
         ORDER BY updated_at_ms ASC LIMIT 5`,
      )
      .bind(nowMs - 60_000)
      .all<{ id: string; status: string }>();

    if (!candidates.results || candidates.results.length === 0) {
      return { retriedCount: 0 };
    }

    let retriedCount = 0;
    for (const order of candidates.results) {
      const statements: D1PreparedStatement[] = [
        this.db
          .prepare(
            `UPDATE orders
             SET status = 'QUEUED', claimed_by_agent_id = NULL, claim_id = NULL,
                 claim_expires_at_ms = NULL, printer_id = NULL, claimed_at_ms = NULL,
                 queued_at_ms = ?, updated_at_ms = ?
             WHERE id = ? AND cleanup_state = 'ACTIVE' AND status = 'PRINT_FAILED'`,
          )
          .bind(nowMs, nowMs, order.id),
        this.db
          .prepare(
            `UPDATE print_attempts
             SET status = 'CANCELLED', finished_at_ms = COALESCE(finished_at_ms, ?),
                 updated_at_ms = ?
             WHERE order_id = ? AND status NOT IN ('SUCCEEDED', 'CANCELLED')
               AND EXISTS (SELECT 1 FROM orders WHERE id = ?
                 AND cleanup_state = 'ACTIVE' AND status = 'QUEUED')`,
          )
          .bind(nowMs, nowMs, order.id, order.id),
        this.db
          .prepare(
            `UPDATE order_files
             SET print_status = 'PENDING', spooler_job_id = NULL, updated_at_ms = ?
             WHERE order_id = ? AND print_status <> 'PRINTED'`,
          )
          .bind(nowMs, order.id),
        this.db
          .prepare(
            `INSERT INTO order_events (
               id, order_id, event_type, from_status, to_status,
               actor_type, actor_id, created_at_ms
             ) SELECT ?, o.id, 'ORDER_PRINT_AUTO_RETRY', ?, 'QUEUED', 'SYSTEM', 'AUTO_RETRY', ?
               FROM orders o WHERE o.id = ? AND o.cleanup_state = 'ACTIVE'
                 AND o.status = 'QUEUED'`,
          )
          .bind(crypto.randomUUID(), order.status, nowMs, order.id),
        this.db
          .prepare(
            `INSERT INTO audit_logs (
               id, actor_type, actor_id, action, entity_type, entity_id, created_at_ms
             ) SELECT ?, 'SYSTEM', 'AUTO_RETRY', 'ORDER_PRINT_AUTO_RETRY', 'ORDER', o.id, ?
               FROM orders o WHERE o.id = ? AND o.cleanup_state = 'ACTIVE'
                 AND o.status = 'QUEUED'`,
          )
          .bind(crypto.randomUUID(), nowMs, order.id),
      ];

      const res = await this.db.batch(statements);
      if (res[0]?.meta.changes === 1) {
        retriedCount++;
      }
    }

    return { retriedCount };
  }
}
