import type {
  AdminClearSpoolerResponseData,
  AdminLiveOrder,
  AdminPickupOrder,
  AdminPickupOrderFile,
  AdminPickupOrdersData,
  AdminQueueRecoverResponseData,
  AgentPrintJobStep,
  IdentificationSheetAddonService,
  IdentificationSheetData,
  PrintPlanStepStatus,
  QueueStallDetails,
} from "@printgo/api-contract";
import {
  COMPLETED_RETENTION_MS,
  PRINT_CLAIM_LEASE_MS,
  maskPhoneNumber,
  normalizePrinterFailure,
  isPrinterWideFailure,
  resolveEffectiveFeatures,
  type ColorMode,
  type OrderStatus,
  type PaperSize,
  type PrinterCapabilityFeatures,
  type SidesMode,
} from "@printgo/domain";
import { isOwnedUploadKey } from "../cleanup/service";

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
  verifiedFeatures?: PrinterCapabilityFeatures | null;
  physicalDeviceId?: string;
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
  physical_device_id: string | null;
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
  verified_capabilities_json: string | null;
  enabled_services_json: string | null;
  capabilities_json: string | null;
}

interface CandidateRow {
  order_id: string;
  order_status: string;
  printer_id: string;
  physical_device_id: string | null;
  file_id: string;
  file_position: number;
  file_count: number;
  remaining_files: number;
  identification_sheet_enabled: number;
  identification_sheet_placement: "FIRST" | "LAST";
  id_sheet_min_pages: number | null;
  id_sheet_min_amount_paise: number | null;
  total_amount_paise: number;
  total_printed_pages: number | null;
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
  attempt_number?: number;
  printer_id?: string;
}

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

function checkPrinterFileCapability(
  p: {
    capabilities_json?: string | null;
    verified_capabilities_json?: string | null;
    enabled_services_json?: string | null;
  },
  file: { paper_size: string; color_mode: string; sides: string },
): { compatible: boolean; missing?: string } {
  let bw = false;
  let color = false;
  let duplex = false;
  let a4 = false;
  let a3 = false;

  if (p.verified_capabilities_json && p.enabled_services_json) {
    try {
      const v = JSON.parse(p.verified_capabilities_json) as {
        verified?: Record<string, unknown>;
      };
      const s = JSON.parse(p.enabled_services_json) as Record<string, unknown>;
      const verified = v.verified ?? {};
      bw =
        (verified.bw === 1 || verified.bw === true) &&
        (s.bw === 1 || s.bw === true);
      color =
        (verified.color === 1 || verified.color === true) &&
        (s.color === 1 || s.color === true);
      duplex =
        (verified.duplex === 1 || verified.duplex === true) &&
        (s.duplex === 1 || s.duplex === true);
      a4 =
        (verified.a4 === 1 || verified.a4 === true) &&
        (s.a4 === 1 || s.a4 === true);
      a3 =
        (verified.a3 === 1 || verified.a3 === true) &&
        (s.a3 === 1 || s.a3 === true);
    } catch {
      // ignore
    }
  } else if (p.capabilities_json) {
    try {
      const caps = JSON.parse(p.capabilities_json) as {
        colour?: unknown;
        duplex?: unknown;
        paperSizes?: unknown[];
      };
      color =
        caps.colour === 1 || caps.colour === true || caps.colour === "true";
      bw = true;
      duplex =
        caps.duplex === 1 || caps.duplex === true || caps.duplex === "true";
      const paperSizes = (caps.paperSizes ?? []).map((sz) =>
        String(sz).toUpperCase(),
      );
      a4 = paperSizes.includes("A4");
      a3 = paperSizes.includes("A3");
    } catch {
      bw = true;
      a4 = true;
    }
  } else {
    bw = true;
    a4 = true;
  }

  if (file.color_mode === "COLOR" && !color) {
    return { compatible: false, missing: "Colour printing" };
  }
  if (file.color_mode === "BW" && !bw) {
    return { compatible: false, missing: "Black & White printing" };
  }
  if (file.sides === "DOUBLE" && !duplex) {
    return { compatible: false, missing: "Double-sided (Duplex) printing" };
  }
  if (file.paper_size === "A3" && !a3) {
    return { compatible: false, missing: "A3 paper" };
  }
  if (file.paper_size === "A4" && !a4) {
    return { compatible: false, missing: "A4 paper" };
  }
  return { compatible: true };
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
    ...(row.physical_device_id
      ? { physicalDeviceId: row.physical_device_id }
      : {}),
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
    verifiedFeatures: resolveEffectiveFeatures({
      verified_capabilities_json: row.verified_capabilities_json ?? null,
      enabled_services_json: row.enabled_services_json ?? null,
      capabilities_json: row.capabilities_json ?? null,
    }),
  };
}

export interface PrintingRepository {
  recoverExpiredClaims(nowMs: number): Promise<void>;
  claimOrRenew(
    agentId: string,
    nowMs: number,
  ): Promise<ClaimedPrintJobRecord | null>;
  claimOrRenewAll(
    agentId: string,
    nowMs: number,
  ): Promise<ClaimedPrintJobRecord[]>;
  findAllCurrent(agentId: string): Promise<ClaimedPrintJobRecord[]>;
  finishOrphanedSuccess(agentId: string, nowMs: number): Promise<void>;
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
  handlePreflightFailure(input: {
    agentId: string;
    orderId: string;
    stepId: string;
    claimId: string;
    failureCode: string;
    failureDetail?: string | null;
    nowMs: number;
  }): Promise<{
    action: "FALLBACK_ASSIGNED" | "BLOCKED_RELEASED" | "ACTION_REQUIRED";
    printJob?: ClaimedPrintJobRecord | null;
    fallbackPrinterName?: string | null;
    orderId: string;
    message: string;
    retryAfterMs?: number;
  }>;
  listLiveOrders(nowMs?: number): Promise<AdminLiveOrder[]>;
  getQueueStallDetails(nowMs?: number): Promise<QueueStallDetails>;
  recoverQueue(input: {
    adminId: string;
    nowMs: number;
  }): Promise<AdminQueueRecoverResponseData>;
  createClearSpoolerCommand(input: {
    printerId?: string;
    adminId: string;
    nowMs: number;
  }): Promise<AdminClearSpoolerResponseData>;
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
  deleteOrder(input: {
    orderId: string;
    adminId: string;
    bucket: R2Bucket;
    nowMs: number;
  }): Promise<{ orderId: string; deleted: boolean; message: string }>;
  convertOrderToSingleSided(input: {
    orderId: string;
    adminId: string;
    nowMs: number;
  }): Promise<{ orderId: string; status: "QUEUED"; message: string }>;
  listPickupOrders(nowMs?: number): Promise<AdminPickupOrdersData>;
  setAutoPrint(enabled: boolean): Promise<void>;
  requestPickupManualPrint(
    orderId: string,
    adminId: string,
    nowMs: number,
  ): Promise<void>;
  markPickupCollected(
    orderId: string,
    adminId: string,
    nowMs: number,
  ): Promise<void>;
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
          `UPDATE orders SET status = 'ADMIN_ACTION_REQUIRED', physical_device_id = NULL, updated_at_ms = ?
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
          physical_device_id = NULL, claimed_at_ms = NULL, updated_at_ms = ?
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

  async findAllCurrent(agentId: string): Promise<ClaimedPrintJobRecord[]> {
    const rows = await this.db
      .prepare(
        `SELECT o.id order_id, pa.id attempt_id, o.claim_id, o.claim_expires_at_ms,
        o.public_job_code, o.pickup_code, o.due_at_pickup_paise, o.printer_id, p.windows_printer_name,
        COALESCE(o.physical_device_id, COALESCE(p.physical_device_id, 'AGENT_LOCK_' || p.agent_id)) physical_device_id,
        p.verified_capabilities_json, p.enabled_services_json, p.capabilities_json,
        f.r2_object_key,
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
      JOIN print_attempt_steps ps ON ps.id = (
        SELECT next_s.id FROM print_attempt_steps next_s
        WHERE next_s.print_attempt_id = pa.id AND next_s.status <> 'SUCCEEDED'
        ORDER BY CASE WHEN next_s.status IN ('PENDING', 'SUBMISSION_STARTED') THEN 0 ELSE 1 END ASC,
                 next_s.sequence_number ASC
        LIMIT 1
      )
      JOIN printers p ON p.id = o.printer_id AND p.agent_id = o.claimed_by_agent_id
      JOIN order_files f ON f.id = COALESCE(pa.order_file_id,
        (SELECT legacy.id FROM order_files legacy WHERE legacy.order_id = o.id ORDER BY legacy.position LIMIT 1))
      JOIN installation i ON i.id = 1
      WHERE o.claimed_by_agent_id = ?
        AND o.status IN ('CLAIMED','SPOOLING','PRINTING','PRINT_BLOCKED')
      ORDER BY o.queued_at_ms ASC, o.id ASC`,
      )
      .bind(agentId)
      .all<JobRow>();
    return (rows.results ?? [])
      .map(mapJob)
      .filter((j): j is ClaimedPrintJobRecord => j !== null);
  }

  async findCurrent(
    agentId: string,
    orderId?: string,
  ): Promise<ClaimedPrintJobRecord | null> {
    const all = await this.findAllCurrent(agentId);
    if (orderId) return all.find((j) => j.orderId === orderId) ?? null;
    return all[0] ?? null;
  }

  private async claimCandidate(
    candidate: CandidateRow,
    agentId: string,
    nowMs: number,
  ): Promise<ClaimedPrintJobRecord | null> {
    const succeededSteps = await this.db
      .prepare(
        `SELECT step_type FROM print_attempt_steps WHERE order_id = ? AND status = 'SUCCEEDED'`,
      )
      .bind(candidate.order_id)
      .all<{ step_type: string }>();

    const succeededSet = new Set(
      succeededSteps.results.map((r) => r.step_type),
    );
    const meetsPageThreshold =
      candidate.id_sheet_min_pages !== null &&
      candidate.id_sheet_min_pages !== undefined &&
      candidate.id_sheet_min_pages > 0
        ? (candidate.total_printed_pages ?? 0) > candidate.id_sheet_min_pages
        : null;

    const meetsAmountThreshold =
      candidate.id_sheet_min_amount_paise !== null &&
      candidate.id_sheet_min_amount_paise !== undefined &&
      candidate.id_sheet_min_amount_paise > 0
        ? (candidate.total_amount_paise ?? 0) >
          candidate.id_sheet_min_amount_paise
        : null;

    const thresholdsSatisfied =
      meetsPageThreshold !== null && meetsAmountThreshold !== null
        ? meetsPageThreshold || meetsAmountThreshold
        : meetsPageThreshold !== null
          ? meetsPageThreshold
          : meetsAmountThreshold !== null
            ? meetsAmountThreshold
            : true;

    const needIdStep =
      candidate.identification_sheet_enabled === 1 &&
      thresholdsSatisfied &&
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
    const physicalDeviceId =
      candidate.physical_device_id ?? candidate.printer_id;
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `UPDATE orders SET status = 'CLAIMED', claimed_by_agent_id = ?, claim_id = ?,
          claim_expires_at_ms = ?, printer_id = ?, physical_device_id = ?, claimed_at_ms = ?, updated_at_ms = ?
        WHERE id = ? AND status IN ('QUEUED', 'RETRY_PENDING', 'PRINT_BLOCKED') AND cleanup_state = 'ACTIVE'
          AND NOT EXISTS (
            SELECT 1 FROM orders busy
            WHERE busy.id <> orders.id
              AND (
                busy.status IN ('CLAIMED','SPOOLING','PRINTING')
                OR (
                  busy.status IN ('ADMIN_ACTION_REQUIRED','COMPLETION_UNKNOWN','NEEDS_ADMIN')
                  AND busy.physical_device_id IS NOT NULL
                )
              )
              AND busy.physical_device_id = ?
          )
          AND (
            (orders.order_type = 'CUSTOMER' AND EXISTS (
              SELECT 1 FROM payments WHERE order_id = orders.id AND status = 'PAID'
                AND provider_payment_id IS NOT NULL AND verified_at_ms IS NOT NULL
            ))
            OR (orders.order_type = 'SAVED_PRINT' AND orders.admin_authorized_by IS NOT NULL)
          ) AND EXISTS (
          SELECT 1 FROM order_files WHERE id = ? AND order_id = orders.id
            AND upload_status = 'UPLOADED' AND size_bytes IS NOT NULL
        ) AND EXISTS (
          SELECT 1 FROM printers p
          JOIN agents a ON a.id = p.agent_id
          JOIN order_files f ON f.id = ? AND f.order_id = orders.id
          WHERE p.id = ? AND p.agent_id = ? AND p.enabled = 1 AND p.status = 'ONLINE'
            AND p.is_production_eligible = 1 AND p.is_virtual = 0
            AND a.is_active = 1 AND a.last_heartbeat_at_ms >= ?
            AND p.capabilities_json IS NOT NULL
            AND (
              p.verified_capabilities_json IS NULL
              OR COALESCE(json_extract(p.verified_capabilities_json, '$.requiresReview'), 0) NOT IN (1, 'true')
            )
            AND (
              CASE
                WHEN p.verified_capabilities_json IS NOT NULL AND p.enabled_services_json IS NOT NULL THEN
                  (
                    (f.color_mode = 'BW' AND json_extract(p.verified_capabilities_json, '$.verified.bw') = 1 AND json_extract(p.enabled_services_json, '$.bw') = 1)
                    OR
                    (f.color_mode = 'COLOR' AND json_extract(p.verified_capabilities_json, '$.verified.color') = 1 AND json_extract(p.enabled_services_json, '$.color') = 1)
                  )
                ELSE
                  (f.color_mode = 'BW' OR json_extract(p.capabilities_json, '$.colour') = 1 OR json_extract(p.capabilities_json, '$.colour') = 'true')
              END
            )
            AND (
              CASE
                WHEN p.verified_capabilities_json IS NOT NULL AND p.enabled_services_json IS NOT NULL THEN
                  (
                    f.sides = 'SINGLE'
                    OR
                    (json_extract(p.verified_capabilities_json, '$.verified.duplex') = 1 AND json_extract(p.enabled_services_json, '$.duplex') = 1)
                  )
                ELSE
                  (f.sides = 'SINGLE' OR json_extract(p.capabilities_json, '$.duplex') = 1 OR json_extract(p.capabilities_json, '$.duplex') = 'true')
              END
            )
            AND (
              CASE
                WHEN p.verified_capabilities_json IS NOT NULL AND p.enabled_services_json IS NOT NULL THEN
                  (
                    (f.paper_size = 'A4' AND json_extract(p.verified_capabilities_json, '$.verified.a4') = 1 AND json_extract(p.enabled_services_json, '$.a4') = 1)
                    OR
                    (f.paper_size = 'A3' AND json_extract(p.verified_capabilities_json, '$.verified.a3') = 1 AND json_extract(p.enabled_services_json, '$.a3') = 1)
                  )
                ELSE
                  EXISTS (SELECT 1 FROM json_each(p.capabilities_json, '$.paperSizes')
                    WHERE upper(value) = f.paper_size)
              END
            )
            AND NOT EXISTS (
              SELECT 1 FROM (
                SELECT status
                FROM agent_control_commands
                WHERE agent_id = p.agent_id
                  AND (printer_id IS NULL OR printer_id = p.id OR windows_printer_name = p.windows_printer_name)
                  AND command_type = 'CLEAR_SPOOLER'
                ORDER BY created_at_ms DESC
                LIMIT 1
              ) latest_cmd
              WHERE latest_cmd.status <> 'SUCCEEDED'
            )
        )`,
        )
        .bind(
          agentId,
          claimId,
          lease,
          candidate.printer_id,
          physicalDeviceId,
          nowMs,
          nowMs,
          candidate.order_id,
          physicalDeviceId,
          candidate.file_id,
          candidate.file_id,
          candidate.printer_id,
          agentId,
          nowMs - 90_000,
        ),
      this.db
        .prepare(
          `INSERT INTO print_attempts (id, order_id, attempt_number, agent_id, printer_id,
          physical_device_id, status, identification_sheet_included, created_at_ms, updated_at_ms,
          order_file_id, file_position, fallback_from_printer_id)
        SELECT ?, id, COALESCE((SELECT MAX(attempt_number) + 1 FROM print_attempts
          WHERE order_id = orders.id), 1), ?, ?, ?, 'CREATED', ?, ?, ?, ?, ?, ?
        FROM orders WHERE id = ? AND claim_id = ? AND claimed_by_agent_id = ?`,
        )
        .bind(
          attemptId,
          agentId,
          candidate.printer_id,
          physicalDeviceId,
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
        SELECT ?, id, 'PRINT_JOB_CLAIMED', ?, 'CLAIMED', 'AGENT', ?, ?
        FROM orders WHERE id = ? AND claim_id = ?`,
        )
        .bind(
          crypto.randomUUID(),
          candidate.order_status,
          agentId,
          nowMs,
          candidate.order_id,
          claimId,
        ),
    );
    const results = await this.db.batch(statements);
    if (results[0]?.meta.changes !== 1) return null;
    return this.findCurrent(agentId, candidate.order_id);
  }

  async claimOrRenewAll(
    agentId: string,
    nowMs: number,
  ): Promise<ClaimedPrintJobRecord[]> {
    // Empty queues must not run the recovery/claim write chain on every pulse.
    const work = await this.db
      .prepare(
        `SELECT 1 FROM (
           SELECT 1 FROM orders
           WHERE status IN ('CLAIMED','SPOOLING','PRINTING')
              OR (
                status = 'QUEUED'
                AND (
                  (order_type != 'SAVED_PRINT' AND EXISTS (SELECT 1 FROM payments p WHERE p.order_id = orders.id AND p.status = 'PAID'))
                  OR (order_type = 'SAVED_PRINT' AND admin_authorized_by IS NOT NULL)
                )
                AND (
                  is_pickup = 0
                  OR pickup_manual_print_requested = 1
                  OR (
                    (SELECT pickup_auto_print_enabled FROM installation WHERE id = 1) = 1
                    AND (pickup_target_time_ms IS NULL OR pickup_target_time_ms <= ?)
                  )
                )
              )
           UNION ALL
           SELECT 1 FROM orders
           WHERE status IN ('PRINT_BLOCKED','RETRY_PENDING')
             AND (next_retry_at_ms IS NULL OR next_retry_at_ms <= ?)
             AND (
               is_pickup = 0
               OR pickup_manual_print_requested = 1
               OR (
                 (SELECT pickup_auto_print_enabled FROM installation WHERE id = 1) = 1
                 AND (pickup_target_time_ms IS NULL OR pickup_target_time_ms <= ?)
               )
             )
           UNION ALL
           SELECT 1 FROM orders
           WHERE status = 'PRINT_FAILED' AND cleanup_state = 'ACTIVE' AND updated_at_ms <= ?
         ) LIMIT 1`,
      )
      .bind(nowMs, nowMs, nowMs, nowMs - 60_000)
      .first();
    if (!work) return [];

    // OPT-6: Fast indexed gate probe before running the 6-statement recovery batch.
    // In normal operation, claims are renewed every 6s and only expire upon agent crash/disconnect (5-min lease).
    // If no active orders have expired claims, the 6 UPDATE batch would match zero rows across all 6 statements.
    const hasExpiredClaims = await this.db
      .prepare(
        `SELECT 1 FROM orders
         WHERE claim_expires_at_ms <= ?
           AND status IN ('CLAIMED','SPOOLING','PRINTING','PRINT_BLOCKED')
         LIMIT 1`,
      )
      .bind(nowMs)
      .first();
    if (hasExpiredClaims) {
      await this.recoverExpiredClaims(nowMs);
    }
    await this.autoRetryEligibleOrders(nowMs);
    await this.finishOrphanedSuccess(agentId, nowMs);

    // Renew any existing active leases that are entering the final third of the lease window
    const lease = nowMs + PRINT_CLAIM_LEASE_MS;
    await this.db
      .prepare(
        `UPDATE orders SET claim_expires_at_ms = ?, updated_at_ms = ?
       WHERE claimed_by_agent_id = ?
         AND claim_expires_at_ms > ? AND claim_expires_at_ms <= ?
         AND status IN ('CLAIMED','SPOOLING','PRINTING','PRINT_BLOCKED')`,
      )
      .bind(lease, nowMs, agentId, nowMs, nowMs + PRINT_CLAIM_LEASE_MS / 3)
      .run();

    // Loop to claim orders for any idle, available physical printers (bounded to 16)
    for (let i = 0; i < 16; i++) {
      const candidate = await this.db
        .prepare(
          `SELECT o.id order_id, o.status order_status, p.id printer_id,
          COALESCE(p.physical_device_id, 'AGENT_LOCK_' || p.agent_id) physical_device_id,
          i.identification_sheet_enabled,
          i.identification_sheet_placement, i.id_sheet_min_pages, i.id_sheet_min_amount_paise,
          o.total_amount_paise,
          (SELECT SUM(COALESCE(op.selected_page_count, op.source_page_count, 1) * op.copies)
           FROM order_files op WHERE op.order_id = o.id) total_printed_pages,
          o.identification_required, f.id file_id, f.position file_position,
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
        LEFT JOIN payments pay ON pay.order_id = o.id AND pay.status = 'PAID'
          AND pay.provider_payment_id IS NOT NULL AND pay.verified_at_ms IS NOT NULL
        JOIN agents a ON a.id = ? AND a.is_active = 1 AND a.last_heartbeat_at_ms >= ?
        JOIN printers p ON p.agent_id = a.id AND p.enabled = 1 AND p.status = 'ONLINE'
          AND COALESCE(p.is_paused, 0) = 0
          AND p.is_production_eligible = 1 AND p.is_virtual = 0
          AND p.capabilities_json IS NOT NULL
        JOIN installation i ON i.id = 1
          AND (
            (o.printer_id IS NOT NULL AND p.id = o.printer_id)
            OR (
              -- Subcase A2: Pre-assigned order whose assigned printer is now faulted (paused/offline).
              -- When auto_fallback_enabled=1, any healthy compatible printer may claim it.
              -- Never silently reroute if the assigned printer is still healthy.
              o.printer_id IS NOT NULL AND p.id <> o.printer_id
              AND EXISTS (
                SELECT 1 FROM printers assigned
                WHERE assigned.id = o.printer_id
                  AND assigned.auto_fallback_enabled = 1
                  AND (assigned.enabled = 0 OR assigned.status <> 'ONLINE' OR COALESCE(assigned.is_paused, 0) = 1)
              )
            )
            OR (o.printer_id IS NULL AND (
              i.default_production_printer_id IS NULL
              OR p.id = i.default_production_printer_id
              OR (
                -- Subcase B1: Capability routing — default printer is ONLINE and NOT paused,
                -- but lacks the specific capability requested by file f
                p.id <> i.default_production_printer_id
                AND EXISTS (
                  SELECT 1 FROM printers def
                  WHERE def.id = i.default_production_printer_id
                    AND def.enabled = 1 AND def.status = 'ONLINE' AND COALESCE(def.is_paused, 0) = 0
                    AND (
                      (f.color_mode = 'COLOR' AND (
                        (def.verified_capabilities_json IS NOT NULL AND (json_extract(def.verified_capabilities_json, '$.verified.color') <> 1 OR json_extract(def.enabled_services_json, '$.color') <> 1))
                        OR (def.verified_capabilities_json IS NULL AND json_extract(def.capabilities_json, '$.colour') <> 1 AND json_extract(def.capabilities_json, '$.colour') <> 'true')
                      ))
                      OR (f.sides <> 'SINGLE' AND (
                        (def.verified_capabilities_json IS NOT NULL AND (json_extract(def.verified_capabilities_json, '$.verified.duplex') <> 1 OR json_extract(def.enabled_services_json, '$.duplex') <> 1))
                        OR (def.verified_capabilities_json IS NULL AND json_extract(def.capabilities_json, '$.duplex') <> 1 AND json_extract(def.capabilities_json, '$.duplex') <> 'true')
                      ))
                      OR (f.paper_size = 'A3' AND (
                        (def.verified_capabilities_json IS NOT NULL AND (json_extract(def.verified_capabilities_json, '$.verified.a3') <> 1 OR json_extract(def.enabled_services_json, '$.a3') <> 1))
                        OR (def.verified_capabilities_json IS NULL AND json_extract(def.capabilities_json, '$.paperSizes') NOT LIKE '%A3%')
                      ))
                    )
                )
              )
              OR (
                -- Subcase B2: Fallback routing — default printer is OFFLINE or PAUSED,
                -- and auto-fallback is enabled. When fallback_printer_id IS NULL, any
                -- compatible healthy printer qualifies (shop-wide fallback).
                p.id <> i.default_production_printer_id
                AND EXISTS (
                  SELECT 1 FROM printers def
                  WHERE def.id = i.default_production_printer_id
                    AND def.auto_fallback_enabled = 1
                    AND (def.fallback_printer_id IS NULL OR def.fallback_printer_id = p.id)
                    AND (def.enabled = 0 OR def.status <> 'ONLINE' OR COALESCE(def.is_paused, 0) = 1)
                )
                AND COALESCE(p.fallback_printer_id, '') <> i.default_production_printer_id
              )
              OR (
                -- Subcase B3: Parallel routing — default printer is busy on its physical device,
                -- and printer p is on an independent, idle physical device that matches all capabilities
                p.id <> i.default_production_printer_id
                AND EXISTS (
                  SELECT 1 FROM printers def
                  WHERE def.id = i.default_production_printer_id
                    AND COALESCE(def.physical_device_id, 'AGENT_LOCK_' || def.agent_id) <> COALESCE(p.physical_device_id, 'AGENT_LOCK_' || p.agent_id)
                    AND EXISTS (
                      SELECT 1 FROM orders busy
                      JOIN printers busy_p ON busy_p.id = busy.printer_id
                      WHERE busy.id <> o.id
                        AND (
                          (
                            busy.status IN ('CLAIMED','SPOOLING','PRINTING')
                            AND COALESCE(busy.physical_device_id, COALESCE(busy_p.physical_device_id, 'AGENT_LOCK_' || busy_p.agent_id)) = COALESCE(def.physical_device_id, 'AGENT_LOCK_' || def.agent_id)
                          )
                          OR (
                            busy.status IN ('ADMIN_ACTION_REQUIRED','COMPLETION_UNKNOWN','NEEDS_ADMIN')
                            AND busy.physical_device_id IS NOT NULL
                            AND busy.physical_device_id = COALESCE(def.physical_device_id, 'AGENT_LOCK_' || def.agent_id)
                          )
                        )
                    )
                )
              )
            ))
          )
        WHERE ((o.status = 'QUEUED')
               OR (o.status IN ('RETRY_PENDING', 'PRINT_BLOCKED') AND (o.next_retry_at_ms IS NULL OR o.next_retry_at_ms <= ?)))
          AND (
            (o.order_type = 'CUSTOMER' AND pay.id IS NOT NULL)
            OR (o.order_type = 'SAVED_PRINT' AND o.admin_authorized_by IS NOT NULL)
          )
          AND (
            o.is_pickup = 0
            OR o.pickup_manual_print_requested = 1
            OR (
              i.pickup_auto_print_enabled = 1
              AND (o.pickup_target_time_ms IS NULL OR o.pickup_target_time_ms <= ?)
            )
          )
          AND o.public_job_code IS NOT NULL
          AND o.cleanup_state = 'ACTIVE' AND f.upload_status = 'UPLOADED'
          AND f.size_bytes IS NOT NULL
          AND (f.position <> 1 OR EXISTS (SELECT 1 FROM uploads u
            WHERE u.order_id = o.id AND u.r2_object_key = f.r2_object_key
              AND u.storage_status = 'UPLOADED'))
          AND (
            p.verified_capabilities_json IS NULL
            OR COALESCE(json_extract(p.verified_capabilities_json, '$.requiresReview'), 0) NOT IN (1, 'true')
          )
          AND (
            CASE
              WHEN p.verified_capabilities_json IS NOT NULL AND p.enabled_services_json IS NOT NULL THEN
                (
                  (f.color_mode = 'BW' AND json_extract(p.verified_capabilities_json, '$.verified.bw') = 1 AND json_extract(p.enabled_services_json, '$.bw') = 1)
                  OR
                  (f.color_mode = 'COLOR' AND json_extract(p.verified_capabilities_json, '$.verified.color') = 1 AND json_extract(p.enabled_services_json, '$.color') = 1)
                )
              ELSE
                (f.color_mode = 'BW' OR json_extract(p.capabilities_json, '$.colour') = 1 OR json_extract(p.capabilities_json, '$.colour') = 'true')
            END
          )
          AND (
            CASE
              WHEN p.verified_capabilities_json IS NOT NULL AND p.enabled_services_json IS NOT NULL THEN
                (
                  f.sides = 'SINGLE'
                  OR
                  (json_extract(p.verified_capabilities_json, '$.verified.duplex') = 1 AND json_extract(p.enabled_services_json, '$.duplex') = 1)
                )
              ELSE
                (f.sides = 'SINGLE' OR json_extract(p.capabilities_json, '$.duplex') = 1 OR json_extract(p.capabilities_json, '$.duplex') = 'true')
            END
          )
          AND (
            CASE
              WHEN p.verified_capabilities_json IS NOT NULL AND p.enabled_services_json IS NOT NULL THEN
                (
                  (f.paper_size = 'A4' AND json_extract(p.verified_capabilities_json, '$.verified.a4') = 1 AND json_extract(p.enabled_services_json, '$.a4') = 1)
                  OR
                  (f.paper_size = 'A3' AND json_extract(p.verified_capabilities_json, '$.verified.a3') = 1 AND json_extract(p.enabled_services_json, '$.a3') = 1)
                )
              ELSE
                EXISTS (SELECT 1 FROM json_each(p.capabilities_json, '$.paperSizes') WHERE upper(value) = f.paper_size)
            END
          )
          AND NOT EXISTS (
            SELECT 1 FROM orders busy
            JOIN printers busy_p ON busy_p.id = busy.printer_id
            WHERE busy.id <> o.id
              AND (
                (
                  busy.status IN ('CLAIMED','SPOOLING','PRINTING')
                  AND COALESCE(busy.physical_device_id, COALESCE(busy_p.physical_device_id, 'AGENT_LOCK_' || busy_p.agent_id)) = COALESCE(p.physical_device_id, 'AGENT_LOCK_' || p.agent_id)
                )
                OR (
                  busy.status IN ('ADMIN_ACTION_REQUIRED','COMPLETION_UNKNOWN','NEEDS_ADMIN')
                  AND busy.physical_device_id IS NOT NULL
                  AND busy.physical_device_id = COALESCE(p.physical_device_id, 'AGENT_LOCK_' || p.agent_id)
                )
              )
          )
          AND NOT EXISTS (
            SELECT 1 FROM (
              SELECT status
              FROM agent_control_commands
              WHERE agent_id = a.id
                AND (printer_id IS NULL OR printer_id = p.id OR windows_printer_name = p.windows_printer_name)
                AND command_type = 'CLEAR_SPOOLER'
              ORDER BY created_at_ms DESC
              LIMIT 1
            ) latest_cmd
            WHERE latest_cmd.status <> 'SUCCEEDED'
          )
        ORDER BY
          o.is_priority DESC,
          (CASE WHEN o.status = 'QUEUED' THEN 0 WHEN o.status = 'RETRY_PENDING' THEN 1 ELSE 2 END) ASC,
          o.queued_at_ms ASC,
          o.id ASC,
          CASE WHEN p.id = i.default_production_printer_id THEN 0 ELSE 1 END ASC,
          CASE WHEN EXISTS (
            SELECT 1 FROM printers def
            WHERE def.id = i.default_production_printer_id
              AND def.auto_fallback_enabled = 1
              AND def.fallback_printer_id = p.id
              AND (def.enabled = 0 OR def.status <> 'ONLINE' OR COALESCE(def.is_paused, 0) = 1)
          ) THEN 0 ELSE 1 END ASC,
          p.priority DESC,
          p.id ASC
        LIMIT 1`,
        )
        .bind(agentId, nowMs - 90_000, nowMs, nowMs)
        .first<CandidateRow>();
      if (!candidate) break;

      const claimed = await this.claimCandidate(candidate, agentId, nowMs);
      if (!claimed) break;
    }

    return this.findAllCurrent(agentId);
  }

  async claimOrRenew(
    agentId: string,
    nowMs: number,
  ): Promise<ClaimedPrintJobRecord | null> {
    const all = await this.claimOrRenewAll(agentId, nowMs);
    return all[0] ?? null;
  }

  async finishOrphanedSuccess(agentId: string, nowMs: number): Promise<void> {
    const rows = await this.db
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
        GROUP BY o.id
        ORDER BY ps.sequence_number DESC`,
      )
      .bind(agentId)
      .all<StepOwnershipRow & { claim_id: string }>();
    for (const row of rows.results ?? []) {
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
  }

  async findOwnedStep(
    input: Parameters<PrintingRepository["findOwnedStep"]>[0],
  ): Promise<StepOwnershipRow | null> {
    return this.db
      .prepare(
        `SELECT o.id order_id, pa.id attempt_id, ps.id step_id, ps.status step_status,
        ps.spooler_job_id, o.status order_status, ps.step_type, pa.order_file_id,
        pa.attempt_number, pa.printer_id
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
    ]);
    return results[0]?.meta.changes === 1 ? this.findOwnedStep(input) : null;
  }

  async handlePreflightFailure(
    input: Parameters<PrintingRepository["handlePreflightFailure"]>[0],
  ): Promise<{
    action: "FALLBACK_ASSIGNED" | "BLOCKED_RELEASED" | "ACTION_REQUIRED";
    printJob?: ClaimedPrintJobRecord | null;
    fallbackPrinterName?: string | null;
    orderId: string;
    message: string;
    retryAfterMs?: number;
  }> {
    const current = await this.findOwnedStep(input);
    if (!current) {
      return {
        action: "ACTION_REQUIRED",
        orderId: input.orderId,
        message: "Print step not owned by active agent lease.",
      };
    }

    // Strict Post-Submission Boundary:
    // If the step has been submitted to Windows spooler, or succeeded, or has a spoolerJobId,
    // NEVER automatically reroute or reassign!
    if (
      current.step_status === "SUBMITTED" ||
      current.step_status === "SUCCEEDED" ||
      current.spooler_job_id !== null
    ) {
      return {
        action: "ACTION_REQUIRED",
        orderId: input.orderId,
        message:
          "Physical print submission has already started or spooler job was registered. Automatic rerouting is prohibited.",
      };
    }

    // If submission was marked started, submission state is ambiguous (could have submitted before crash).
    // Mark as UNCERTAIN and require operator review.
    if (current.step_status === "SUBMISSION_STARTED") {
      await this.db.batch([
        this.db
          .prepare(
            `UPDATE print_attempt_steps SET status = 'UNCERTAIN', failure_code = ?, failure_detail = ?, finished_at_ms = ?, updated_at_ms = ? WHERE id = ?`,
          )
          .bind(
            "UNKNOWN",
            input.failureDetail ??
              "Agent reported preflight failure after submission started.",
            input.nowMs,
            input.nowMs,
            input.stepId,
          ),
        this.db
          .prepare(
            `UPDATE orders SET status = 'ADMIN_ACTION_REQUIRED', error_category = 'COMPLETION_UNKNOWN', raw_error = ?, updated_at_ms = ? WHERE id = ?`,
          )
          .bind(
            input.failureDetail ?? "Ambiguous submission state",
            input.nowMs,
            input.orderId,
          ),
      ]);
      return {
        action: "ACTION_REQUIRED",
        orderId: input.orderId,
        message:
          "Submission was already initiated; non-submission cannot be safely proven. Admin intervention required.",
      };
    }

    // Step is strictly PENDING or BLOCKED without a spooler job ID:
    // 100% PROVABLY PRE-SUBMISSION.
    const normFailure = normalizePrinterFailure(
      input.failureCode || input.failureDetail,
    );
    const stepFailureCode = toStepFailureCode(
      input.failureCode || input.failureDetail,
    );
    const printerWide = isPrinterWideFailure(normFailure);
    const failingPrinterId = current.printer_id;

    // Pause failing printer if it's a hardware/printer-wide failure
    if (failingPrinterId && printerWide) {
      await this.db
        .prepare(
          `UPDATE printers
           SET is_paused = 1, paused_reason = ?,
               paused_at_ms = COALESCE(paused_at_ms, ?), updated_at_ms = ?
           WHERE id = ?`,
        )
        .bind(normFailure, input.nowMs, input.nowMs, failingPrinterId)
        .run();
    }

    // Mark current attempt step as FAILED
    // Mark current attempt as FAILED
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE print_attempt_steps
           SET status = 'FAILED', failure_code = ?, failure_detail = ?, finished_at_ms = ?, updated_at_ms = ?
           WHERE id = ?`,
        )
        .bind(
          stepFailureCode,
          input.failureDetail ?? "Preflight hardware check failed",
          input.nowMs,
          input.nowMs,
          input.stepId,
        ),
      this.db
        .prepare(
          `UPDATE print_attempts
           SET status = 'FAILED', failure_code = ?, failure_detail = ?, finished_at_ms = ?, updated_at_ms = ?
           WHERE id = ?`,
        )
        .bind(
          stepFailureCode,
          input.failureDetail ?? "Preflight hardware check failed",
          input.nowMs,
          input.nowMs,
          current.attempt_id,
        ),
    ]);

    // Query file requirements and shop configuration
    const fileMeta = await this.db
      .prepare(
        `SELECT f.id file_id, f.color_mode, f.paper_size, f.sides, f.position file_position,
                o.total_amount_paise, o.identification_required, o.fallback_count,
                (SELECT SUM(COALESCE(op.selected_page_count, op.source_page_count, 1) * op.copies)
                 FROM order_files op WHERE op.order_id = o.id) total_printed_pages,
                (SELECT COUNT(*) FROM order_files all_files WHERE all_files.order_id = o.id) file_count,
                (SELECT COUNT(*) FROM order_files rem WHERE rem.order_id = o.id AND rem.print_status <> 'PRINTED') remaining_files,
                i.default_production_printer_id, i.identification_sheet_enabled,
                i.identification_sheet_placement, i.id_sheet_min_pages, i.id_sheet_min_amount_paise,
                p_fail.fallback_printer_id, p_fail.auto_fallback_enabled
         FROM order_files f
         JOIN orders o ON o.id = f.order_id
         JOIN installation i ON i.id = 1
         LEFT JOIN printers p_fail ON p_fail.id = ?
         WHERE f.id = ? AND o.id = ?`,
      )
      .bind(failingPrinterId, current.order_file_id, input.orderId)
      .first<{
        file_id: string;
        color_mode: string;
        paper_size: string;
        sides: string;
        file_position: number;
        total_amount_paise: number;
        identification_required: number;
        fallback_count: number;
        total_printed_pages: number | null;
        file_count: number;
        remaining_files: number;
        default_production_printer_id: string | null;
        identification_sheet_enabled: number;
        identification_sheet_placement: string;
        id_sheet_min_pages: number | null;
        id_sheet_min_amount_paise: number | null;
        fallback_printer_id: string | null;
        auto_fallback_enabled: number | null;
      }>();

    // Query other candidate printers
    const candidates = await this.db
      .prepare(
        `SELECT p.id, p.windows_printer_name, p.display_name, p.priority,
                p.capabilities_json, p.verified_capabilities_json, p.enabled_services_json
         FROM printers p
         WHERE p.agent_id = ?
           AND p.id <> ?
           AND p.enabled = 1
           AND p.status = 'ONLINE'
           AND COALESCE(p.is_paused, 0) = 0
           AND p.is_production_eligible = 1
           AND p.is_virtual = 0
           AND (
             p.verified_capabilities_json IS NULL
             OR COALESCE(json_extract(p.verified_capabilities_json, '$.requiresReview'), 0) NOT IN (1, 'true')
           )
         ORDER BY
           CASE WHEN p.id = ? THEN 0 ELSE 1 END ASC,
           p.priority DESC,
           p.id ASC`,
      )
      .bind(
        input.agentId,
        failingPrinterId,
        fileMeta?.auto_fallback_enabled === 1
          ? fileMeta.fallback_printer_id
          : null,
      )
      .all<{
        id: string;
        windows_printer_name: string;
        display_name: string;
        priority: number;
        capabilities_json: string;
        verified_capabilities_json: string | null;
        enabled_services_json: string | null;
      }>();

    // Capability matching filter
    const compatible = (candidates.results ?? []).filter((p) => {
      if (!fileMeta) return false;
      // Do not route to any fallback printer if auto_fallback_enabled is 0
      if (fileMeta.auto_fallback_enabled === 0) {
        return false;
      }
      if (
        fileMeta.fallback_printer_id !== null &&
        fileMeta.fallback_printer_id !== p.id
      ) {
        return false;
      }

      // Check capabilities
      const verified = p.verified_capabilities_json
        ? (JSON.parse(p.verified_capabilities_json) as {
            verified?: {
              color?: number;
              bw?: number;
              duplex?: number;
              a4?: number;
              a3?: number;
            };
          })
        : null;
      const services = p.enabled_services_json
        ? (JSON.parse(p.enabled_services_json) as {
            color?: number;
            bw?: number;
            duplex?: number;
            a4?: number;
            a3?: number;
          })
        : null;
      const legacy = p.capabilities_json
        ? (JSON.parse(p.capabilities_json) as {
            colour?: boolean | string;
            duplex?: boolean | string;
            paperSizes?: string[];
          })
        : null;

      if (verified?.verified && services) {
        if (fileMeta.color_mode === "COLOR") {
          if (!verified.verified.color || !services.color) return false;
        } else if (fileMeta.color_mode === "BW") {
          if (!verified.verified.bw || !services.bw) return false;
        }
        if (fileMeta.sides !== "SINGLE") {
          if (!verified.verified.duplex || !services.duplex) return false;
        }
        if (fileMeta.paper_size === "A4") {
          if (!verified.verified.a4 || !services.a4) return false;
        } else if (fileMeta.paper_size === "A3") {
          if (!verified.verified.a3 || !services.a3) return false;
        }
      } else if (legacy) {
        if (fileMeta.color_mode === "COLOR") {
          if (!legacy.colour || legacy.colour === "false") return false;
        }
        if (fileMeta.sides !== "SINGLE") {
          if (!legacy.duplex || legacy.duplex === "false") return false;
        }
        if (fileMeta.paper_size === "A3") {
          const sizes = Array.isArray(legacy.paperSizes)
            ? legacy.paperSizes
            : [];
          if (
            !sizes.some((s: string) => String(s).toUpperCase().includes("A3"))
          )
            return false;
        }
      }
      return true;
    });

    if (compatible.length > 0 && fileMeta) {
      // BRANCH A: Compatible Fallback Printer Found!
      const selected = compatible[0]!;
      const newAttemptId = crypto.randomUUID();
      const newAttemptNumber = (current.attempt_number ?? 1) + 1;
      const idStep = crypto.randomUUID();
      const documentStep = crypto.randomUUID();

      const succeededSteps = await this.db
        .prepare(
          `SELECT step_type FROM print_attempt_steps WHERE order_id = ? AND status = 'SUCCEEDED'`,
        )
        .bind(input.orderId)
        .all<{ step_type: string }>();
      const succeededSet = new Set(
        (succeededSteps.results ?? []).map((r) => r.step_type),
      );

      const meetsPageThreshold =
        fileMeta.id_sheet_min_pages !== null &&
        fileMeta.id_sheet_min_pages !== undefined &&
        fileMeta.id_sheet_min_pages > 0
          ? (fileMeta.total_printed_pages ?? 0) > fileMeta.id_sheet_min_pages
          : null;
      const meetsAmountThreshold =
        fileMeta.id_sheet_min_amount_paise !== null &&
        fileMeta.id_sheet_min_amount_paise !== undefined &&
        fileMeta.id_sheet_min_amount_paise > 0
          ? (fileMeta.total_amount_paise ?? 0) >
            fileMeta.id_sheet_min_amount_paise
          : null;
      const thresholdsSatisfied =
        meetsPageThreshold !== null && meetsAmountThreshold !== null
          ? meetsPageThreshold || meetsAmountThreshold
          : meetsPageThreshold !== null
            ? meetsPageThreshold
            : meetsAmountThreshold !== null
              ? meetsAmountThreshold
              : true;

      const needIdStep =
        fileMeta.identification_sheet_enabled === 1 &&
        thresholdsSatisfied &&
        !succeededSet.has("IDENTIFICATION_SHEET") &&
        ((fileMeta.identification_sheet_placement === "FIRST" &&
          fileMeta.file_position === 1) ||
          (fileMeta.identification_sheet_placement === "LAST" &&
            fileMeta.remaining_files === 1));

      const needDocStep = fileMeta.remaining_files > 0;
      const firstIsId = fileMeta.identification_sheet_placement === "FIRST";

      const statements: D1PreparedStatement[] = [
        this.db
          .prepare(
            `UPDATE print_attempts SET status = 'FAILED', failure_code = ?, failure_detail = ?, finished_at_ms = ?, updated_at_ms = ?
             WHERE id = ? AND status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED')`,
          )
          .bind(
            normFailure,
            `Fallback reassigned to ${selected.display_name}`,
            input.nowMs,
            input.nowMs,
            current.attempt_id,
          ),
        this.db
          .prepare(
            `INSERT INTO print_attempts (
               id, order_id, order_file_id, attempt_number, agent_id, printer_id,
               fallback_from_printer_id, fallback_reason, fallback_authorized_at_ms,
               status, created_at_ms, updated_at_ms
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'CREATED', ?, ?)`,
          )
          .bind(
            newAttemptId,
            input.orderId,
            fileMeta.file_id,
            newAttemptNumber,
            input.agentId,
            selected.id,
            failingPrinterId,
            normFailure,
            input.nowMs,
            input.nowMs,
            input.nowMs,
          ),
        this.db
          .prepare(
            `UPDATE orders
             SET printer_id = ?, fallback_count = fallback_count + 1, updated_at_ms = ?
             WHERE id = ? AND claim_id = ?`,
          )
          .bind(selected.id, input.nowMs, input.orderId, input.claimId),
        this.event(
          input.orderId,
          "FALLBACK_REASSIGNED",
          current.order_status,
          current.order_status,
          input.agentId,
          input.nowMs,
        ),
      ];

      if (firstIsId) {
        if (needIdStep) {
          statements.push(
            this.db
              .prepare(
                `INSERT INTO print_attempt_steps (id, print_attempt_id, order_id, sequence_number,
                step_type, created_at_ms, updated_at_ms)
                VALUES (?, ?, ?, 1, 'IDENTIFICATION_SHEET', ?, ?)`,
              )
              .bind(
                idStep,
                newAttemptId,
                input.orderId,
                input.nowMs,
                input.nowMs,
              ),
          );
        }
        if (needDocStep) {
          statements.push(
            this.db
              .prepare(
                `INSERT INTO print_attempt_steps (id, print_attempt_id, order_id, sequence_number,
                step_type, created_at_ms, updated_at_ms)
                VALUES (?, ?, ?, ?, 'CUSTOMER_DOCUMENT', ?, ?)`,
              )
              .bind(
                documentStep,
                newAttemptId,
                input.orderId,
                needIdStep ? 2 : 1,
                input.nowMs,
                input.nowMs,
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
                VALUES (?, ?, ?, 1, 'CUSTOMER_DOCUMENT', ?, ?)`,
              )
              .bind(
                documentStep,
                newAttemptId,
                input.orderId,
                input.nowMs,
                input.nowMs,
              ),
          );
        }
        if (needIdStep) {
          statements.push(
            this.db
              .prepare(
                `INSERT INTO print_attempt_steps (id, print_attempt_id, order_id, sequence_number,
                step_type, created_at_ms, updated_at_ms)
                VALUES (?, ?, ?, ?, 'IDENTIFICATION_SHEET', ?, ?)`,
              )
              .bind(
                idStep,
                newAttemptId,
                input.orderId,
                needDocStep ? 2 : 1,
                input.nowMs,
                input.nowMs,
              ),
          );
        }
      }

      await this.db.batch(statements);
      const newJob = await this.findCurrent(input.agentId);

      return {
        action: "FALLBACK_ASSIGNED",
        printJob: newJob,
        fallbackPrinterName: selected.display_name,
        orderId: input.orderId,
        message: `Safe fallback authorized to printer ${selected.display_name}.`,
      };
    }

    // BRANCH B: No compatible fallback printer available.
    // Release active claim to prevent queue starvation of unrelated orders!
    // Production retry schedule:
    // Initial attempt fails: wait 60s -> Retry 1
    // Retry 1 fails: wait 90s -> Retry 2
    // Retry 2 fails: wait 90s -> Retry 3
    // Retry 3 fails: STOP automatic retries -> ADMIN_ACTION_REQUIRED
    const PREFLIGHT_RETRY_SCHEDULE_MS = [60_000, 90_000, 90_000] as const;
    const fallbackCount = (fileMeta?.fallback_count ?? 0) + 1;

    if (fallbackCount <= PREFLIGHT_RETRY_SCHEDULE_MS.length) {
      const backoffMs = PREFLIGHT_RETRY_SCHEDULE_MS[fallbackCount - 1]!;

      const statements: D1PreparedStatement[] = [
        this.db
          .prepare(
            `UPDATE orders
             SET status = 'RETRY_PENDING', claimed_by_agent_id = NULL, claim_id = NULL,
                 claim_expires_at_ms = NULL, error_category = ?, raw_error = ?,
                 blocked_reason = ?, fallback_count = ?, attempt_count = ?, next_retry_at_ms = ?,
                 updated_at_ms = ?
             WHERE id = ? AND claim_id = ?`,
          )
          .bind(
            normFailure,
            input.failureDetail ?? "No compatible printer currently available",
            input.failureDetail ??
              "Printer is blocked and no fallback available",
            fallbackCount,
            fallbackCount,
            input.nowMs + backoffMs,
            input.nowMs,
            input.orderId,
            input.claimId,
          ),
        this.event(
          input.orderId,
          "PRINT_UNSTARVED_RETRY",
          current.order_status,
          "RETRY_PENDING",
          input.agentId,
          input.nowMs,
        ),
      ];

      await this.db.batch(statements);

      return {
        action: "BLOCKED_RELEASED",
        orderId: input.orderId,
        message: `No compatible fallback printer available. Automatic retry ${fallbackCount} of 3 scheduled in ${backoffMs / 1000}s.`,
        retryAfterMs: backoffMs,
      };
    }

    // RETRY EXHAUSTION: Maximum 3 automatic retries failed before submission.
    // Stop automatic retries and transition order to ADMIN_ACTION_REQUIRED.
    const exhaustionDetail = `Maximum automatic retries (3) exhausted before spooler submission (${input.failureDetail ?? "Printer is blocked and no fallback available"}).`;
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `UPDATE orders
           SET status = 'ADMIN_ACTION_REQUIRED', physical_device_id = NULL, error_category = ?, raw_error = ?,
               blocked_reason = ?, fallback_count = ?, attempt_count = 3, next_retry_at_ms = NULL,
               updated_at_ms = ?
           WHERE id = ? AND claim_id = ?`,
        )
        .bind(
          normFailure,
          exhaustionDetail,
          exhaustionDetail,
          fallbackCount,
          input.nowMs,
          input.orderId,
          input.claimId,
        ),
      this.event(
        input.orderId,
        "PRINT_NEEDS_ADMIN",
        current.order_status,
        "ADMIN_ACTION_REQUIRED",
        input.agentId,
        input.nowMs,
      ),
    ];

    await this.db.batch(statements);

    return {
      action: "ACTION_REQUIRED",
      orderId: input.orderId,
      message: `${exhaustionDetail} Admin intervention required.`,
    };
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
                 claim_expires_at_ms = NULL, physical_device_id = NULL, error_category = 'COMPLETION_UNKNOWN',
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

    const orderRow = await this.db
      .prepare(`SELECT is_pickup FROM orders WHERE id = ?`)
      .bind(input.orderId)
      .first<{ is_pickup: number }>();
    const isPickup = (orderRow?.is_pickup ?? 0) === 1;

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
            `UPDATE order_files SET print_status = 'PRINTED',
             printed_at_ms = COALESCE(printed_at_ms, ?), updated_at_ms = ?
             WHERE order_id = ? AND print_status <> 'PRINTED'`,
          )
          .bind(input.nowMs, input.nowMs, input.orderId),
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
    } else if (isPickup) {
      // PICKUP: transition to PRINTED and await customer collection in Pickup Orders
      await this.db.batch([
        this.db
          .prepare(
            "UPDATE print_attempts SET status = 'SUCCEEDED', finished_at_ms = COALESCE(finished_at_ms, ?), updated_at_ms = ? WHERE id = ? AND status <> 'SUCCEEDED'",
          )
          .bind(input.nowMs, input.nowMs, current.attempt_id),
        this.db
          .prepare(
            `UPDATE orders SET status = 'PRINTED', printed_at_ms = COALESCE(printed_at_ms, ?),
             claimed_by_agent_id = NULL, claim_id = NULL, claim_expires_at_ms = NULL,
             error_category = NULL, raw_error = NULL, next_retry_at_ms = NULL, updated_at_ms = ?
             WHERE id = ? AND claim_id = ? AND status IN ('CLAIMED','SPOOLING','PRINTING','PRINT_BLOCKED')
               AND EXISTS (SELECT 1 FROM order_files WHERE order_id = orders.id)
               AND NOT EXISTS (SELECT 1 FROM order_files
                 WHERE order_id = orders.id AND print_status <> 'PRINTED')`,
          )
          .bind(input.nowMs, input.nowMs, input.orderId, input.claimId),
        this.db
          .prepare(
            `UPDATE order_files SET print_status = 'PRINTED',
             printed_at_ms = COALESCE(printed_at_ms, ?), updated_at_ms = ?
             WHERE order_id = ? AND print_status <> 'PRINTED'`,
          )
          .bind(input.nowMs, input.nowMs, input.orderId),
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
      ]);
    } else {
      // AUTO: transition directly to COMPLETED
      const retentionMs = await this.getOrderRetentionMs();
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
            input.nowMs + retentionMs,
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
          .bind(input.nowMs + retentionMs, input.nowMs, input.orderId),
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

  private async getOrderRetentionMs(): Promise<number> {
    try {
      const installSettings = await this.db
        .prepare(`SELECT order_retention_hours FROM installation WHERE id = 1`)
        .first<{ order_retention_hours: number | null }>();
      if (
        typeof installSettings?.order_retention_hours === "number" &&
        installSettings.order_retention_hours > 0
      ) {
        return installSettings.order_retention_hours * 3600_000;
      }
    } catch {
      // Keep default retentionMs
    }
    return COMPLETED_RETENTION_MS;
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
              paid_at_ms, updated_at_ms, payment_method, cash_confirmed_at_ms
            FROM orders
            WHERE status IN ('QUEUED','CLAIMED','SPOOLING','PRINTING','PRINT_BLOCKED',
              'PRINT_FAILED','ADMIN_ACTION_REQUIRED','RETRY_PENDING','NEEDS_ADMIN','COMPLETION_UNKNOWN')
              AND cleanup_state = 'ACTIVE'
              AND is_pickup = 0
              AND (
                public_job_code IS NOT NULL
                OR paid_at_ms IS NOT NULL
                OR EXISTS (SELECT 1 FROM payments p WHERE p.order_id = orders.id AND p.status = 'PAID')
                OR status = 'MANUAL_PRINT'
                OR EXISTS (
                  SELECT 1 FROM order_addon_services s WHERE s.order_id = orders.id
                    AND s.snapshot_handling_mode = 'MANUAL_PRINT'
                )
                OR EXISTS (
                  SELECT 1 FROM order_events e WHERE e.order_id = orders.id
                    AND e.event_type IN ('ORDER_MANUALLY_COMPLETED','ORDER_MANUALLY_PRINTED')
                )
              )
            UNION ALL
            SELECT id, public_job_code, pickup_code, is_priority, identification_required,
              customer_name, customer_phone,
              selected_pages, copies, paper_size, color_mode, sides,
              total_amount_paise, currency, status, claimed_by_agent_id, printer_id,
              error_category, raw_error, attempt_count, last_attempt_at_ms, next_retry_at_ms,
              paid_at_ms, updated_at_ms, payment_method, cash_confirmed_at_ms
            FROM orders
            WHERE status = 'PRINTED' AND updated_at_ms >= ?
              AND cleanup_state = 'ACTIVE'
              AND is_pickup = 0
              AND (
                public_job_code IS NOT NULL
                OR paid_at_ms IS NOT NULL
                OR EXISTS (SELECT 1 FROM payments p WHERE p.order_id = orders.id AND p.status = 'PAID')
                OR status = 'MANUAL_PRINT'
                OR EXISTS (
                  SELECT 1 FROM order_addon_services s WHERE s.order_id = orders.id
                    AND s.snapshot_handling_mode = 'MANUAL_PRINT'
                )
                OR EXISTS (
                  SELECT 1 FROM order_events e WHERE e.order_id = orders.id
                    AND e.event_type IN ('ORDER_MANUALLY_COMPLETED','ORDER_MANUALLY_PRINTED')
                )
              )
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
          o.paid_at_ms, o.updated_at_ms,
          CASE
            WHEN o.payment_method = 'CASH'
              OR o.cash_confirmed_at_ms IS NOT NULL
              OR EXISTS (SELECT 1 FROM payments pay WHERE pay.order_id = o.id AND pay.provider = 'CASH' AND pay.status = 'PAID')
              THEN 'CASH'
            WHEN EXISTS (SELECT 1 FROM payments pay WHERE pay.order_id = o.id AND pay.provider = 'RAZORPAY' AND pay.status = 'PAID')
              THEN 'ONLINE'
            WHEN o.payment_method = 'ONLINE' AND (
              o.paid_at_ms IS NOT NULL OR EXISTS (SELECT 1 FROM payments pay WHERE pay.order_id = o.id AND pay.status = 'PAID')
            )
              THEN 'ONLINE'
            ELSE 'UNKNOWN'
          END payment_method,
          o.cash_confirmed_at_ms,
          CASE
            WHEN o.paid_at_ms IS NOT NULL OR EXISTS (SELECT 1 FROM payments pay WHERE pay.order_id = o.id AND pay.status = 'PAID') THEN 'PAID'
            WHEN o.status = 'PAYMENT_FAILED' OR EXISTS (SELECT 1 FROM payments pay WHERE pay.order_id = o.id AND pay.status = 'FAILED') THEN 'FAILED'
            WHEN o.status = 'PAYMENT_CANCELLED' OR EXISTS (SELECT 1 FROM payments pay WHERE pay.order_id = o.id AND pay.status = 'CANCELLED') THEN 'CANCELLED'
            ELSE 'PENDING'
          END payment_status
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
        payment_method: string;
        cash_confirmed_at_ms: number | null;
        payment_status: string;
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
      paymentMethod:
        row.payment_method === "CASH"
          ? "CASH"
          : row.payment_method === "ONLINE"
            ? "ONLINE"
            : "UNKNOWN",
      paymentStatus:
        (row.payment_status as AdminLiveOrder["paymentStatus"]) ?? "PENDING",
      cashConfirmedAt: row.cash_confirmed_at_ms
        ? new Date(row.cash_confirmed_at_ms).toISOString()
        : null,
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
        "PRINTING",
        "SPOOLING",
        "CLAIMED",
        "PRINT_BLOCKED",
        "QUEUED",
        "MANUAL_PRINT",
      ].includes(order.status)
    )
      throw new Error("ORDER_CANNOT_BE_COMPLETED");

    const retentionMs = await this.getOrderRetentionMs();

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
             'PRINT_FAILED','ADMIN_ACTION_REQUIRED','PRINTED','PRINTING',
             'SPOOLING','CLAIMED','PRINT_BLOCKED','QUEUED','MANUAL_PRINT')
           AND EXISTS (SELECT 1 FROM order_files WHERE order_id = orders.id)`,
        )
        .bind(
          nextStatus,
          input.nowMs,
          hasFinishing ? null : input.nowMs,
          hasFinishing ? null : input.nowMs + retentionMs,
          input.nowMs,
          input.orderId,
        ),
      this.db
        .prepare(
          `UPDATE print_attempt_steps SET status = 'SUCCEEDED', finished_at_ms = COALESCE(finished_at_ms, ?), updated_at_ms = ?
         WHERE order_id = ? AND status IN ('SUBMISSION_STARTED', 'SUBMITTED', 'PENDING')`,
        )
        .bind(input.nowMs, input.nowMs, input.orderId),
      this.db
        .prepare(
          `UPDATE print_attempts SET status = 'SUCCEEDED', finished_at_ms = COALESCE(finished_at_ms, ?), updated_at_ms = ?
         WHERE order_id = ? AND status IN ('PRINTING', 'SUBMITTING', 'CREATED')`,
        )
        .bind(input.nowMs, input.nowMs, input.orderId),
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
          input.nowMs + retentionMs,
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
      .prepare(
        `SELECT id, status, cleanup_state, public_job_code, paid_at_ms,
           (SELECT 1 FROM payments p WHERE p.order_id = orders.id AND p.status = 'PAID') AS has_paid_payment,
           EXISTS (
             SELECT 1 FROM uploads u WHERE u.order_id = orders.id
               AND u.storage_status = 'UPLOADED' AND u.deleted_at_ms IS NULL
           ) AS has_printable_file,
           (SELECT 1 FROM order_events e WHERE e.order_id = orders.id
              AND e.event_type IN ('ORDER_MANUALLY_COMPLETED','ORDER_MANUALLY_PRINTED')) AS is_manual
         FROM orders WHERE id = ?`,
      )
      .bind(input.orderId)
      .first<{
        id: string;
        status: string;
        cleanup_state: string;
        public_job_code: string | null;
        paid_at_ms: number | null;
        has_paid_payment: number | null;
        has_printable_file: number;
        is_manual: number | null;
      }>();

    if (!order) {
      throw new Error("ORDER_NOT_FOUND");
    }
    if (order.cleanup_state !== "ACTIVE") {
      throw new Error("ORDER_CANNOT_BE_RETRIED");
    }

    const isValidPaidOrManualOrder =
      order.public_job_code !== null ||
      order.paid_at_ms !== null ||
      order.has_paid_payment === 1 ||
      order.is_manual === 1;

    if (!isValidPaidOrManualOrder) {
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
    ];

    if (!retriableStatuses.includes(order.status)) {
      throw new Error("ORDER_CANNOT_BE_RETRIED");
    }

    if (order.has_printable_file !== 1) {
      throw new Error("ORDER_PDF_EXPIRED");
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
               fallback_count = 0,
               next_retry_at_ms = NULL, queued_at_ms = ?, updated_at_ms = ?
           WHERE id = ? AND cleanup_state = 'ACTIVE'
             AND status IN ('ADMIN_ACTION_REQUIRED','PRINT_FAILED','PRINT_BLOCKED','NEEDS_ADMIN','COMPLETION_UNKNOWN','RETRY_PENDING','COMPLETED','PRINTED')`,
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

  async deleteOrder(input: {
    orderId: string;
    adminId: string;
    bucket: R2Bucket;
    nowMs: number;
  }): Promise<{ orderId: string; deleted: boolean; message: string }> {
    const order = await this.db
      .prepare(`SELECT id, status, cleanup_state FROM orders WHERE id = ?`)
      .bind(input.orderId)
      .first<{ id: string; status: string; cleanup_state: string }>();

    if (!order) {
      throw new Error("ORDER_NOT_FOUND");
    }

    // Block deletion if printing is actively in-flight
    if (["CLAIMED", "SPOOLING", "PRINTING"].includes(order.status)) {
      throw new Error("ORDER_CANNOT_BE_DELETED");
    }

    const activeStep = await this.db
      .prepare(
        `SELECT 1 FROM print_attempt_steps
         WHERE order_id = ? AND status IN ('SUBMISSION_STARTED', 'SUBMITTED')
         LIMIT 1`,
      )
      .bind(input.orderId)
      .first();
    if (activeStep) {
      throw new Error("ORDER_CANNOT_BE_DELETED");
    }

    const uploadRows = await this.db
      .prepare(
        `SELECT r2_object_key FROM uploads WHERE order_id = ? AND r2_object_key IS NOT NULL
         UNION
         SELECT r2_object_key FROM order_files WHERE order_id = ? AND r2_object_key IS NOT NULL`,
      )
      .bind(input.orderId, input.orderId)
      .all<{ r2_object_key: string }>();

    const objectKeys = uploadRows.results
      .map((r) => r.r2_object_key)
      .filter(
        (k): k is string =>
          typeof k === "string" &&
          k.length > 0 &&
          isOwnedUploadKey(k, input.orderId),
      );

    if (objectKeys.length > 0) {
      try {
        await input.bucket.delete(objectKeys);
      } catch (err) {
        console.error(
          "Failed to delete R2 objects for order:",
          input.orderId,
          err,
        );
      }
    }

    await this.db.batch([
      this.db
        .prepare("DELETE FROM retained_order_history WHERE id = ?")
        .bind(input.orderId),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO retained_payment_records
          (id, provider, provider_order_id, provider_payment_id, amount_paise,
           currency, status, verified_at_ms, payment_created_at_ms, purged_at_ms)
         SELECT id, provider, provider_order_id, provider_payment_id, amount_paise,
           currency, status, verified_at_ms, created_at_ms, ?
         FROM payments WHERE order_id = ?`,
        )
        .bind(input.nowMs, input.orderId),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO retained_provider_events
          (id, provider, provider_event_id, event_type, received_at_ms,
           processed_at_ms, processing_status, purged_at_ms)
         SELECT id, provider, provider_event_id, event_type, received_at_ms,
           processed_at_ms, processing_status, ?
         FROM payment_provider_events WHERE related_order_id = ? OR related_payment_id IN
           (SELECT id FROM payments WHERE order_id = ?)`,
        )
        .bind(input.nowMs, input.orderId, input.orderId),
      this.db
        .prepare(
          `DELETE FROM payment_provider_events WHERE related_order_id = ? OR related_payment_id IN
           (SELECT id FROM payments WHERE order_id = ?)`,
        )
        .bind(input.orderId, input.orderId),
      this.db
        .prepare("DELETE FROM print_attempt_steps WHERE order_id = ?")
        .bind(input.orderId),
      this.db
        .prepare("DELETE FROM print_attempts WHERE order_id = ?")
        .bind(input.orderId),
      this.db
        .prepare("DELETE FROM order_events WHERE order_id = ?")
        .bind(input.orderId),
      this.db
        .prepare(
          "UPDATE audit_logs SET entity_id = NULL, metadata_json = NULL WHERE entity_type = 'ORDER' AND entity_id = ?",
        )
        .bind(input.orderId),
      this.db
        .prepare("DELETE FROM payments WHERE order_id = ?")
        .bind(input.orderId),
      this.db
        .prepare("DELETE FROM uploads WHERE order_id = ?")
        .bind(input.orderId),
      this.db
        .prepare("DELETE FROM order_files WHERE order_id = ?")
        .bind(input.orderId),
      this.db
        .prepare("DELETE FROM order_addon_services WHERE order_id = ?")
        .bind(input.orderId),
      this.db.prepare("DELETE FROM orders WHERE id = ?").bind(input.orderId),
      this.db
        .prepare(
          `INSERT INTO audit_logs (id, actor_type, actor_id, action, entity_type, entity_id, metadata_json, created_at_ms)
           VALUES (?, 'ADMIN', ?, 'ORDER_DELETED', 'ORDER', NULL, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          input.adminId,
          JSON.stringify({ deletedOrderId: input.orderId }),
          input.nowMs,
        ),
    ]);

    return {
      orderId: input.orderId,
      deleted: true,
      message: "Order and customer files permanently deleted.",
    };
  }

  async getQueueStallDetails(
    nowMs: number = Date.now(),
  ): Promise<QueueStallDetails> {
    const orders = await this.db
      .prepare(
        `SELECT id, public_job_code, status, updated_at_ms,
                COALESCE(queued_at_ms, paid_at_ms, created_at_ms, updated_at_ms) AS queued_at_ms,
                printer_id, physical_device_id
         FROM orders
         WHERE cleanup_state = 'ACTIVE'
           AND status IN ('QUEUED','CLAIMED','SPOOLING','PRINTING','PRINT_BLOCKED',
                          'PRINT_FAILED','ADMIN_ACTION_REQUIRED','RETRY_PENDING',
                          'NEEDS_ADMIN','COMPLETION_UNKNOWN')
         ORDER BY COALESCE(queued_at_ms, paid_at_ms, created_at_ms, updated_at_ms) ASC`,
      )
      .all<{
        id: string;
        public_job_code: string | null;
        status: string;
        updated_at_ms: number;
        queued_at_ms: number;
        printer_id: string | null;
        physical_device_id: string | null;
      }>();

    const orderRows = orders.results ?? [];
    if (orderRows.length === 0) {
      return {
        isStalled: false,
        stalledSinceMs: null,
        stalledDurationMs: null,
        stalledOrderId: null,
        stalledOrderCode: null,
        reason: null,
        printerIssue: null,
        waitingCount: 0,
        activeCount: 0,
        needsReviewCount: 0,
      };
    }
    let waitingCount = 0;
    let activeCount = 0;
    let needsReviewCount = 0;

    const waitingOrders: typeof orderRows = [];
    const activeOrders: typeof orderRows = [];
    const reviewOrders: typeof orderRows = [];

    for (const o of orderRows) {
      if (o.status === "QUEUED" || o.status === "RETRY_PENDING") {
        waitingCount++;
        waitingOrders.push(o);
      } else if (
        o.status === "CLAIMED" ||
        o.status === "SPOOLING" ||
        o.status === "PRINTING"
      ) {
        activeCount++;
        activeOrders.push(o);
      } else if (
        o.status === "ADMIN_ACTION_REQUIRED" ||
        o.status === "COMPLETION_UNKNOWN" ||
        o.status === "NEEDS_ADMIN" ||
        o.status === "PRINT_BLOCKED" ||
        o.status === "PRINT_FAILED"
      ) {
        needsReviewCount++;
        reviewOrders.push(o);
      }
    }

    // Check printer statuses (ONLY enabled printers on active agents)
    const printerRows = await this.db
      .prepare(
        `SELECT p.id, p.display_name, p.windows_printer_name, p.status, p.status_reason, p.enabled, p.is_paused,
                p.capabilities_json, p.verified_capabilities_json, p.enabled_services_json
         FROM printers p
         JOIN agents a ON a.id = p.agent_id
         WHERE a.is_active = 1 AND p.enabled = 1`,
      )
      .all<{
        id: string;
        display_name: string;
        windows_printer_name: string;
        status: string;
        status_reason: string | null;
        enabled: number;
        is_paused: number | null;
        capabilities_json: string | null;
        verified_capabilities_json: string | null;
        enabled_services_json: string | null;
      }>();

    let printerIssue: string | null = null;
    const activePrinters = printerRows.results ?? [];
    const troubledPrinter = activePrinters.find(
      (p) =>
        p.status !== "ONLINE" ||
        p.is_paused === 1 ||
        (p.status_reason &&
          /(?:jam|offline|door|paper|error|unreachable)/i.test(
            p.status_reason,
          )),
    );
    if (troubledPrinter) {
      const reasonDetail = troubledPrinter.status_reason
        ? ` (${troubledPrinter.status_reason})`
        : "";
      printerIssue = `${troubledPrinter.display_name}: ${troubledPrinter.status}${reasonDetail}`;
    }

    // Query file requirements for waiting orders
    const waitingFileRequirements =
      waitingOrders.length > 0
        ? await this.db
            .prepare(
              `SELECT f.order_id, f.paper_size, f.color_mode, f.sides
               FROM order_files f
               WHERE f.order_id IN (${waitingOrders.map(() => "?").join(",")})`,
            )
            .bind(...waitingOrders.map((o) => o.id))
            .all<{
              order_id: string;
              paper_size: string;
              color_mode: string;
              sides: string;
            }>()
        : { results: [] };

    const STALL_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

    // 1. Check if an active print job has made no progress for 5+ minutes
    let stalledActive: (typeof orderRows)[number] | null = null;
    for (const active of activeOrders) {
      if (nowMs - active.updated_at_ms >= STALL_THRESHOLD_MS) {
        stalledActive = active;
        break;
      }
    }

    if (stalledActive) {
      const durationMs = nowMs - stalledActive.updated_at_ms;
      return {
        isStalled: true,
        stalledSinceMs: stalledActive.updated_at_ms,
        stalledDurationMs: durationMs,
        stalledOrderId: stalledActive.id,
        stalledOrderCode: stalledActive.public_job_code,
        reason:
          "Active print job has made no verifiable progress for over 5 minutes.",
        printerIssue,
        waitingCount,
        activeCount,
        needsReviewCount,
      };
    }

    // 2. If no active job is printing, but orders are waiting and either printer issue exists or review order holding lock
    if (activeCount === 0 && waitingCount > 0 && waitingOrders.length > 0) {
      const oldestWaiting = waitingOrders[0]!;
      const waitingDuration = nowMs - oldestWaiting.queued_at_ms;

      // Condition 2A: Waiting orders stalled behind a printer issue or error for 5+ min
      if (printerIssue && waitingDuration >= STALL_THRESHOLD_MS) {
        return {
          isStalled: true,
          stalledSinceMs: oldestWaiting.queued_at_ms,
          stalledDurationMs: waitingDuration,
          stalledOrderId: oldestWaiting.id,
          stalledOrderCode: oldestWaiting.public_job_code,
          reason: `Printer offline or error detected with ${waitingCount} order(s) waiting for over 5 minutes.`,
          printerIssue,
          waitingCount,
          activeCount,
          needsReviewCount,
        };
      }

      // Condition 2B: Waiting orders stalled because of capability starvation (e.g. duplex on simplex printer)
      const oldestFiles = (waitingFileRequirements.results ?? []).filter(
        (f) => f.order_id === oldestWaiting.id,
      );
      let oldestMissingCapability: string | null = null;
      if (oldestFiles.length > 0 && activePrinters.length > 0) {
        const hasCapablePrinter = activePrinters.some((p) =>
          oldestFiles.every((f) => checkPrinterFileCapability(p, f).compatible),
        );
        if (!hasCapablePrinter) {
          for (const f of oldestFiles) {
            for (const p of activePrinters) {
              const check = checkPrinterFileCapability(p, f);
              if (!check.compatible && check.missing) {
                oldestMissingCapability = check.missing;
                break;
              }
            }
            if (oldestMissingCapability) break;
          }
          if (!oldestMissingCapability) {
            oldestMissingCapability = "required printer features";
          }
        }
      } else if (activePrinters.length === 0) {
        oldestMissingCapability = "an enabled production printer";
      }

      if (oldestMissingCapability && waitingDuration >= STALL_THRESHOLD_MS) {
        return {
          isStalled: true,
          stalledSinceMs: oldestWaiting.queued_at_ms,
          stalledDurationMs: waitingDuration,
          stalledOrderId: oldestWaiting.id,
          stalledOrderCode: oldestWaiting.public_job_code,
          reason: `Order ${oldestWaiting.public_job_code ?? oldestWaiting.id} requires ${oldestMissingCapability}, but no enabled printer supports this. Run Print Recovery to move to Needs Review.`,
          printerIssue,
          waitingCount,
          activeCount,
          needsReviewCount,
        };
      }

      // Condition 2C: Waiting orders stalled because physical lock held by review order or agent stall for 5+ min
      if (waitingDuration >= STALL_THRESHOLD_MS) {
        const reviewWithLock = reviewOrders.find(
          (r) => r.physical_device_id !== null,
        );
        const reason = reviewWithLock
          ? `Physical printer lock held by review order ${reviewWithLock.public_job_code ?? reviewWithLock.id}.`
          : `Queue has made no progress for over 5 minutes with ${waitingCount} order(s) waiting.`;
        return {
          isStalled: true,
          stalledSinceMs: oldestWaiting.queued_at_ms,
          stalledDurationMs: waitingDuration,
          stalledOrderId: oldestWaiting.id,
          stalledOrderCode: oldestWaiting.public_job_code,
          reason,
          printerIssue,
          waitingCount,
          activeCount,
          needsReviewCount,
        };
      }
    }

    // 3. Also check if ANY queued paid order has been unassigned for 5+ minutes (even if another job is printing)
    const stalledUnassigned = waitingOrders.find(
      (o) => !o.printer_id && nowMs - o.queued_at_ms >= STALL_THRESHOLD_MS,
    );
    if (stalledUnassigned) {
      const durationMs = nowMs - stalledUnassigned.queued_at_ms;
      return {
        isStalled: true,
        stalledSinceMs: stalledUnassigned.queued_at_ms,
        stalledDurationMs: durationMs,
        stalledOrderId: stalledUnassigned.id,
        stalledOrderCode: stalledUnassigned.public_job_code,
        reason: `Order ${stalledUnassigned.public_job_code ?? stalledUnassigned.id} has been queued without printer assignment for over 5 minutes.`,
        printerIssue,
        waitingCount,
        activeCount,
        needsReviewCount,
      };
    }

    // Otherwise not stalled
    return {
      isStalled: false,
      stalledSinceMs: null,
      stalledDurationMs: null,
      stalledOrderId: null,
      stalledOrderCode: null,
      reason: null,
      printerIssue,
      waitingCount,
      activeCount,
      needsReviewCount,
    };
  }

  async recoverQueue(input: {
    adminId: string;
    nowMs: number;
  }): Promise<AdminQueueRecoverResponseData> {
    const STALL_THRESHOLD_MS = 5 * 60 * 1000;
    const details: string[] = [];

    // 1. Identify active printers, primary printer, and agent connectivity in a single query
    const activePrintersRows = await this.db
      .prepare(
        `SELECT p.id, p.agent_id, p.display_name, p.windows_printer_name, p.status, p.status_reason,
                p.capabilities_json, p.verified_capabilities_json, p.enabled_services_json,
                a.last_heartbeat_at_ms, a.is_active
         FROM printers p
         JOIN agents a ON a.id = p.agent_id
         WHERE a.is_active = 1 AND p.enabled = 1
         ORDER BY (p.status = 'ONLINE') DESC, p.priority ASC`,
      )
      .all<{
        id: string;
        agent_id: string;
        display_name: string;
        windows_printer_name: string;
        status: string;
        status_reason: string | null;
        capabilities_json: string | null;
        verified_capabilities_json: string | null;
        enabled_services_json: string | null;
        last_heartbeat_at_ms: number | null;
        is_active: number;
      }>();

    const activePrintersList = activePrintersRows.results ?? [];
    const printerRow = activePrintersList[0] ?? null;
    const isPrinterOnline = printerRow?.status === "ONLINE";
    const printerDisplayName = printerRow?.display_name ?? null;

    if (printerRow) {
      const agentActive =
        printerRow.is_active === 1 &&
        printerRow.last_heartbeat_at_ms !== null &&
        input.nowMs - printerRow.last_heartbeat_at_ms <= 65_000;
      details.push(
        `Printer "${printerRow.display_name}" is ${printerRow.status}. Agent is ${
          agentActive ? "CONNECTED" : "OFFLINE/DISCONNECTED"
        }.`,
      );
    } else {
      details.push("No enabled production printer found in the shop.");
    }

    // 2. Identify active stalled jobs that had reached SUBMISSION_STARTED
    // If an active job has been printing/spooling for 5+ min and reached SUBMISSION_STARTED:
    // Move it to ADMIN_ACTION_REQUIRED to avoid re-printing sheets already physically in printer.
    const stalledInFlight = await this.db
      .prepare(
        `SELECT o.id, o.public_job_code
         FROM orders o
         WHERE o.status IN ('CLAIMED','SPOOLING','PRINTING')
           AND (o.updated_at_ms <= ? OR (o.claim_expires_at_ms IS NOT NULL AND o.claim_expires_at_ms <= ?))
           AND EXISTS (
             SELECT 1 FROM print_attempts pa
             JOIN print_attempt_steps ps ON ps.print_attempt_id = pa.id
             WHERE pa.order_id = o.id
               AND ps.status IN ('SUBMISSION_STARTED','SUBMITTED')
           )`,
      )
      .bind(input.nowMs - STALL_THRESHOLD_MS, input.nowMs)
      .all<{ id: string; public_job_code: string }>();

    for (const stalled of stalledInFlight.results ?? []) {
      await this.db
        .prepare(
          `UPDATE orders
           SET status = 'ADMIN_ACTION_REQUIRED',
               physical_device_id = NULL,
               recovered_at_ms = ?,
               recovery_reason = 'STALLED_IN_SUBMISSION_QUARANTINED',
               updated_at_ms = ?
           WHERE id = ?`,
        )
        .bind(input.nowMs, input.nowMs, stalled.id)
        .run();

      await this.db
        .prepare(
          `UPDATE print_attempt_steps
           SET status = 'UNCERTAIN',
               failure_code = 'UNKNOWN',
               failure_detail = 'Submission stalled without progress for 5+ minutes during print recovery.',
               finished_at_ms = ?,
               updated_at_ms = ?
           WHERE print_attempt_id IN (SELECT id FROM print_attempts WHERE order_id = ?)
             AND status IN ('SUBMISSION_STARTED', 'SUBMITTED', 'PENDING')`,
        )
        .bind(input.nowMs, input.nowMs, stalled.id)
        .run();

      details.push(
        `Job ${stalled.public_job_code ?? stalled.id} was in submission when stalled; quarantined in ADMIN_ACTION_REQUIRED (0 reprint risk).`,
      );
    }

    // 3. Reclaim Safe Pre-Submission Failures & Stale Leases back to QUEUED
    // Orders in CLAIMED, SPOOLING, PRINT_BLOCKED, RETRY_PENDING that NEVER reached SUBMISSION_STARTED
    const safeReclaimable = await this.db
      .prepare(
        `SELECT id, public_job_code FROM orders
         WHERE status IN ('CLAIMED','SPOOLING','PRINT_BLOCKED','RETRY_PENDING')
           AND NOT EXISTS (
             SELECT 1 FROM print_attempts pa
             JOIN print_attempt_steps ps ON ps.print_attempt_id = pa.id
             WHERE pa.order_id = orders.id
               AND ps.status IN ('SUBMISSION_STARTED','SUBMITTED','UNCERTAIN')
           )`,
      )
      .all<{ id: string; public_job_code: string }>();

    let recoveredOrdersCount = 0;
    const safeRows = safeReclaimable.results ?? [];
    if (safeRows.length > 0) {
      await this.db
        .prepare(
          `UPDATE orders
           SET status = 'QUEUED',
               claimed_by_agent_id = NULL,
               claim_id = NULL,
               claim_expires_at_ms = NULL,
               printer_id = NULL,
               physical_device_id = NULL,
               claimed_at_ms = NULL,
               recovered_at_ms = ?,
               recovery_reason = 'SAFE_PRE_SUBMISSION_RECLAIM',
               updated_at_ms = ?
           WHERE status IN ('CLAIMED','SPOOLING','PRINT_BLOCKED','RETRY_PENDING')
             AND NOT EXISTS (
               SELECT 1 FROM print_attempts pa
               JOIN print_attempt_steps ps ON ps.print_attempt_id = pa.id
               WHERE pa.order_id = orders.id
                 AND ps.status IN ('SUBMISSION_STARTED','SUBMITTED','UNCERTAIN')
             )`,
        )
        .bind(input.nowMs, input.nowMs)
        .run();

      // Cancel unstarted attempt records
      await this.db
        .prepare(
          `UPDATE print_attempts
           SET status = 'CANCELLED', finished_at_ms = ?, updated_at_ms = ?
           WHERE order_id IN (${safeRows.map(() => "?").join(",")})
             AND status IN ('CREATED', 'SUBMITTING', 'SPOOLING', 'BLOCKED')
             AND NOT EXISTS (
               SELECT 1 FROM print_attempt_steps ps
               WHERE ps.print_attempt_id = print_attempts.id
                 AND ps.status IN ('SUBMISSION_STARTED','SUBMITTED','UNCERTAIN')
             )`,
        )
        .bind(input.nowMs, input.nowMs, ...safeRows.map((r) => r.id))
        .run();

      recoveredOrdersCount = safeRows.length;
      details.push(
        `Reclaimed ${recoveredOrdersCount} pre-submission order(s) safely back to QUEUED (zero duplicate print risk).`,
      );
    }

    // 3b. Check Waiting Orders for Capability Starvation
    // If any order in QUEUED or RETRY_PENDING cannot be printed by ANY enabled active printer
    // (e.g. order requires Duplex or Color or A3, but no enabled printer supports it):
    // Move it to ADMIN_ACTION_REQUIRED to unblock the queue and notify the operator!
    const waitingForReview = await this.db
      .prepare(
        `SELECT o.id, o.public_job_code, o.status, f.paper_size, f.color_mode, f.sides
         FROM orders o
         JOIN order_files f ON f.order_id = o.id
         WHERE o.status IN ('QUEUED', 'RETRY_PENDING') AND o.cleanup_state = 'ACTIVE'
         ORDER BY o.queued_at_ms ASC`,
      )
      .all<{
        id: string;
        public_job_code: string | null;
        status: string;
        paper_size: string;
        color_mode: string;
        sides: string;
      }>();

    const waitingOrdersMap = new Map<
      string,
      {
        orderId: string;
        publicJobCode: string | null;
        status: string;
        quarantined?: boolean;
        files: Array<{ paper_size: string; color_mode: string; sides: string }>;
      }
    >();
    for (const row of waitingForReview.results ?? []) {
      const existing = waitingOrdersMap.get(row.id) ?? {
        orderId: row.id,
        publicJobCode: row.public_job_code,
        status: row.status,
        files: [],
      };
      existing.files.push({
        paper_size: row.paper_size,
        color_mode: row.color_mode,
        sides: row.sides,
      });
      waitingOrdersMap.set(row.id, existing);
    }

    let capabilityQuarantinedCount = 0;
    for (const [orderId, orderData] of waitingOrdersMap.entries()) {
      const isSupported =
        activePrintersList.length > 0 &&
        activePrintersList.some((p) =>
          orderData.files.every(
            (f) => checkPrinterFileCapability(p, f).compatible,
          ),
        );

      if (!isSupported) {
        let missingReason = "required printer features";
        for (const f of orderData.files) {
          for (const p of activePrintersList) {
            const check = checkPrinterFileCapability(p, f);
            if (!check.compatible && check.missing) {
              missingReason = check.missing;
              break;
            }
          }
          if (missingReason !== "required printer features") break;
        }

        const reasonMsg = `Order requires ${missingReason}, but no enabled printer supports this.`;

        const fallbackAgentId =
          activePrintersList[0]?.agent_id ??
          (
            await this.db
              .prepare("SELECT id FROM agents WHERE is_active = 1 LIMIT 1")
              .first<{ id: string }>()
          )?.id ??
          crypto.randomUUID();
        const claimIdForQuarantine = crypto.randomUUID();
        const claimExpiresAtMs = input.nowMs + 60_000;

        await this.db
          .prepare(
            `UPDATE orders
             SET status = 'ADMIN_ACTION_REQUIRED',
                 claimed_by_agent_id = ?,
                 claim_id = ?,
                 claimed_at_ms = ?,
                 claim_expires_at_ms = ?,
                 error_category = 'PRINTER_CAPABILITY_UNSUPPORTED',
                 raw_error = ?,
                 blocked_reason = ?,
                 recovered_at_ms = ?,
                 recovery_reason = 'CAPABILITY_MISMATCH_QUARANTINED',
                 updated_at_ms = ?
             WHERE id = ?`,
          )
          .bind(
            fallbackAgentId,
            claimIdForQuarantine,
            input.nowMs,
            claimExpiresAtMs,
            reasonMsg,
            reasonMsg,
            input.nowMs,
            input.nowMs,
            orderId,
          )
          .run();

        await this.db
          .prepare(
            `INSERT INTO audit_logs (id, actor_type, actor_id, action, entity_type, entity_id, metadata_json, created_at_ms)
             VALUES (?, 'ADMIN', ?, 'ORDER_QUARANTINED_CAPABILITY_MISMATCH', 'ORDER', ?, ?, ?)`,
          )
          .bind(
            crypto.randomUUID(),
            input.adminId,
            orderId,
            JSON.stringify({
              orderId,
              publicJobCode: orderData.publicJobCode,
              missingReason,
            }),
            input.nowMs,
          )
          .run();

        orderData.quarantined = true;
        capabilityQuarantinedCount++;
        details.push(
          `Order ${orderData.publicJobCode ?? orderId} requires ${missingReason}, but no enabled printer supports this. Moved to Needs Review (queue unblocked).`,
        );
      }
    }

    // 4. Release Physical Printer Locks on Quarantined / Uncertain Orders
    // This allows subsequent waiting orders to print while preserving quarantined orders for physical inspection!
    const reviewWithLocks = await this.db
      .prepare(
        `SELECT id, public_job_code, status FROM orders
         WHERE status IN ('ADMIN_ACTION_REQUIRED', 'COMPLETION_UNKNOWN', 'NEEDS_ADMIN')
           AND physical_device_id IS NOT NULL`,
      )
      .all<{ id: string; public_job_code: string; status: string }>();

    const reviewRows = reviewWithLocks.results ?? [];
    const uncertainOrdersCount =
      reviewRows.length +
      (stalledInFlight.results?.length ?? 0) +
      capabilityQuarantinedCount;
    if (reviewRows.length > 0) {
      await this.db
        .prepare(
          `UPDATE orders
           SET physical_device_id = NULL,
               recovered_at_ms = ?,
               recovery_reason = 'PHYSICAL_LOCK_RELEASED_FOR_QUEUE',
               updated_at_ms = ?
           WHERE status IN ('ADMIN_ACTION_REQUIRED', 'COMPLETION_UNKNOWN', 'NEEDS_ADMIN')
             AND physical_device_id IS NOT NULL`,
        )
        .bind(input.nowMs, input.nowMs)
        .run();

      details.push(
        `Released physical printer locks on ${reviewRows.length} quarantined order(s). They remain in Needs Review for physical operator inspection.`,
      );
    }

    // 4b. If in-flight stalled jobs or locked review jobs existed, auto-dispatch selective CLEAR_SPOOLER
    // to Windows Agent. This guarantees the Windows spooler is cleared of stuck PrintGo jobs before
    // subsequent waiting orders print, preventing duplicate or interleaved prints!
    if (
      ((stalledInFlight.results?.length ?? 0) > 0 || reviewRows.length > 0) &&
      printerRow
    ) {
      try {
        await this.createClearSpoolerCommand({
          printerId: printerRow.id,
          adminId: input.adminId,
          nowMs: input.nowMs,
        });
        details.push(
          `Dispatched selective CLEAR_SPOOLER command to Windows Agent for "${printerRow.display_name}". Any stuck printgo-* jobs will be cleared from Windows spooler before next jobs print.`,
        );
      } catch (err) {
        details.push(
          `Note: Automatic spooler clear could not be queued: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 5. Calculate remaining waiting orders count without redundant D1 query
    let resumedOrdersCount = 0;
    for (const orderData of waitingOrdersMap.values()) {
      if (orderData.status === "QUEUED" && !orderData.quarantined) {
        resumedOrdersCount++;
      }
    }
    details.push(
      `Print queue now has ${resumedOrdersCount} order(s) ready to print in FIFO/priority order.`,
    );

    // 6. Audit log
    await this.db
      .prepare(
        `INSERT INTO audit_logs (id, actor_type, actor_id, action, entity_type, entity_id, metadata_json, created_at_ms)
         VALUES (?, 'ADMIN', ?, 'QUEUE_RECOVERY_EXECUTED', 'PRINT_QUEUE', 'ALL', ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        input.adminId,
        JSON.stringify({
          recoveredOrdersCount,
          resumedOrdersCount,
          uncertainOrdersCount,
          capabilityQuarantinedCount,
        }),
        input.nowMs,
      )
      .run();

    let baseMessage: string;
    if (capabilityQuarantinedCount > 0) {
      baseMessage = `Print Recovery complete: ${capabilityQuarantinedCount} order(s) moved to Needs Review (printer capability mismatch). ${resumedOrdersCount} order(s) ready in queue.`;
    } else if (
      recoveredOrdersCount > 0 ||
      reviewRows.length > 0 ||
      (stalledInFlight.results?.length ?? 0) > 0
    ) {
      baseMessage = `Print Recovery complete: ${recoveredOrdersCount} order(s) reclaimed safely, ${reviewRows.length} lock(s) cleared. ${resumedOrdersCount} order(s) ready in queue.`;
    } else {
      baseMessage = `Print Recovery checked: No stalled in-flight orders or stale locks found. ${resumedOrdersCount} order(s) ready in queue.`;
    }

    if (!isPrinterOnline) {
      details.push(
        `Dispatched hardware probe to Windows Agent to refresh printer readiness for "${printerDisplayName ?? "all printers"}".`,
      );
    }

    const finalMessage = !isPrinterOnline
      ? `${baseMessage} Note: Printer "${printerDisplayName ?? "Unknown"}" is currently ${printerRow?.status ?? "OFFLINE"}. Dispatched hardware probe to Agent.`
      : baseMessage;

    return {
      recoveredOrdersCount,
      resumedOrdersCount,
      uncertainOrdersCount,
      printerOnline: isPrinterOnline,
      printerName: printerDisplayName,
      message: finalMessage,
      details,
    };
  }

  async createClearSpoolerCommand(input: {
    printerId?: string;
    adminId: string;
    nowMs: number;
  }): Promise<AdminClearSpoolerResponseData> {
    let printerRow: {
      id: string;
      agent_id: string;
      display_name: string;
      windows_printer_name: string;
    } | null = null;

    if (input.printerId) {
      printerRow = await this.db
        .prepare(
          `SELECT id, agent_id, display_name, windows_printer_name
           FROM printers WHERE id = ?`,
        )
        .bind(input.printerId)
        .first<{
          id: string;
          agent_id: string;
          display_name: string;
          windows_printer_name: string;
        }>();
    }

    if (!printerRow) {
      printerRow = await this.db
        .prepare(
          `SELECT p.id, p.agent_id, p.display_name, p.windows_printer_name
           FROM printers p
           JOIN agents a ON a.id = p.agent_id
           JOIN installation i ON i.id = 1
           WHERE a.is_active = 1 AND p.enabled = 1
           ORDER BY (i.default_production_printer_id IS NOT NULL AND p.id = i.default_production_printer_id) DESC,
                    p.status = 'ONLINE' DESC
           LIMIT 1`,
        )
        .first<{
          id: string;
          agent_id: string;
          display_name: string;
          windows_printer_name: string;
        }>();
    }

    if (!printerRow) {
      throw new Error("No target printer found to clear spooler.");
    }

    const commandId = crypto.randomUUID();
    const expiresAtMs = input.nowMs + 60_000; // 1 minute expiry

    await this.db.batch([
      this.db
        .prepare(
          `UPDATE agent_control_commands
           SET status = 'EXPIRED', finished_at_ms = ?
           WHERE agent_id = ? AND (printer_id = ? OR windows_printer_name = ?)
             AND command_type = 'CLEAR_SPOOLER'
             AND status IN ('PENDING', 'CLAIMED', 'FAILED', 'EXPIRED')`,
        )
        .bind(
          input.nowMs,
          printerRow.agent_id,
          printerRow.id,
          printerRow.windows_printer_name,
        ),
      this.db
        .prepare(
          `INSERT INTO agent_control_commands (
             id, agent_id, command_type, printer_id, windows_printer_name,
             status, created_at_ms, expires_at_ms
           ) VALUES (?, ?, 'CLEAR_SPOOLER', ?, ?, 'PENDING', ?, ?)`,
        )
        .bind(
          commandId,
          printerRow.agent_id,
          printerRow.id,
          printerRow.windows_printer_name,
          input.nowMs,
          expiresAtMs,
        ),
      this.db
        .prepare(
          `INSERT INTO audit_logs (
             id, actor_type, actor_id, action, entity_type, entity_id, metadata_json, created_at_ms
           ) VALUES (?, 'ADMIN', ?, 'CLEAR_SPOOLER_REQUESTED', 'PRINTER', ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          input.adminId,
          printerRow.id,
          JSON.stringify({
            commandId,
            windowsPrinterName: printerRow.windows_printer_name,
          }),
          input.nowMs,
        ),
    ]);

    return {
      commandId,
      agentId: printerRow.agent_id,
      printerId: printerRow.id,
      windowsPrinterName: printerRow.windows_printer_name,
      status: "PENDING",
      message: `Selective spooler clear command dispatched for printer "${printerRow.display_name}". Only PrintGo documents (printgo-*) will be cancelled.`,
    };
  }

  async convertOrderToSingleSided(input: {
    orderId: string;
    adminId: string;
    nowMs: number;
  }): Promise<{ orderId: string; status: "QUEUED"; message: string }> {
    const order = await this.db
      .prepare(
        `SELECT id, status, cleanup_state, public_job_code,
           EXISTS (
             SELECT 1 FROM uploads u WHERE u.order_id = orders.id
               AND u.storage_status = 'UPLOADED' AND u.deleted_at_ms IS NULL
           ) AS has_printable_file
         FROM orders WHERE id = ?`,
      )
      .bind(input.orderId)
      .first<{
        id: string;
        status: string;
        cleanup_state: string;
        public_job_code: string | null;
        has_printable_file: number;
      }>();

    if (!order) {
      throw new Error("ORDER_NOT_FOUND");
    }
    if (order.cleanup_state !== "ACTIVE") {
      throw new Error("ORDER_CANNOT_BE_MODIFIED");
    }
    if (order.status !== "ADMIN_ACTION_REQUIRED" && order.status !== "QUEUED") {
      throw new Error("ORDER_CANNOT_BE_MODIFIED");
    }
    if (order.has_printable_file !== 1) {
      throw new Error("ORDER_PDF_EXPIRED");
    }

    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `UPDATE order_files
           SET sides = 'SINGLE', print_status = 'PENDING', spooler_job_id = NULL, updated_at_ms = ?
           WHERE order_id = ?`,
        )
        .bind(input.nowMs, input.orderId),
      this.db
        .prepare(
          `UPDATE orders
           SET status = 'QUEUED', claimed_by_agent_id = NULL, claim_id = NULL,
               claim_expires_at_ms = NULL, printer_id = NULL, physical_device_id = NULL,
               claimed_at_ms = NULL, error_category = NULL, raw_error = NULL,
               blocked_reason = NULL, attempt_count = 0, fallback_count = 0,
               next_retry_at_ms = NULL, queued_at_ms = ?, updated_at_ms = ?
           WHERE id = ? AND cleanup_state = 'ACTIVE'`,
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
             id, order_id, event_type, from_status, to_status, actor_type, actor_id, details_json, created_at_ms
           ) VALUES (?, ?, 'ORDER_CONVERTED_SINGLE_SIDED', ?, 'QUEUED', 'ADMIN', ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          input.orderId,
          order.status,
          input.adminId,
          JSON.stringify({ convertedSides: "SINGLE", previousSides: "DOUBLE" }),
          input.nowMs,
        ),
      this.db
        .prepare(
          `INSERT INTO audit_logs (
             id, actor_type, actor_id, action, entity_type, entity_id, metadata_json, created_at_ms
           ) VALUES (?, 'ADMIN', ?, 'ORDER_CONVERTED_SINGLE_SIDED', 'ORDER', ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          input.adminId,
          input.orderId,
          JSON.stringify({ orderId: input.orderId, convertedSides: "SINGLE" }),
          input.nowMs,
        ),
    ];

    await this.db.batch(statements);

    return {
      orderId: input.orderId,
      status: "QUEUED",
      message: `Order ${order.public_job_code ?? order.id} converted to single-sided (1-sided) and returned to queue.`,
    };
  }

  async listPickupOrders(): Promise<AdminPickupOrdersData> {
    const inst = await this.db
      .prepare(
        `SELECT pickup_auto_print_enabled, timezone FROM installation WHERE id = 1`,
      )
      .first<{ pickup_auto_print_enabled: number; timezone?: string | null }>();
    const autoPrintEnabled = (inst?.pickup_auto_print_enabled ?? 0) === 1;
    const timezone = inst?.timezone || "Asia/Kolkata";

    const ordersResult = await this.db
      .prepare(
        `SELECT o.id, o.public_job_code, o.pickup_code, o.customer_name, o.customer_phone,
                o.original_filename, o.total_amount_paise, o.currency, o.status,
                o.is_pickup, o.pickup_target_time_ms, o.pickup_manual_print_requested,
                o.pickup_collected_at_ms, o.created_at_ms, o.paid_at_ms, o.printed_at_ms,
                o.instructions, o.payment_method,
                (SELECT COUNT(*) FROM order_files f WHERE f.order_id = o.id) file_count
         FROM orders o
         WHERE o.is_pickup = 1 AND o.cleanup_state = 'ACTIVE'
           AND o.status IN ('QUEUED','CLAIMED','SPOOLING','PRINTING','PRINT_BLOCKED','PRINT_FAILED',
                            'RETRY_PENDING','ADMIN_ACTION_REQUIRED','NEEDS_ADMIN','COMPLETION_UNKNOWN','PRINTED')
         ORDER BY
           CASE WHEN o.status = 'PRINTED' THEN 1 ELSE 0 END ASC,
           o.pickup_target_time_ms ASC,
           o.created_at_ms ASC`,
      )
      .all<{
        id: string;
        public_job_code: string | null;
        pickup_code: string | null;
        customer_name: string;
        customer_phone: string;
        original_filename: string;
        total_amount_paise: number;
        currency: string;
        status: string;
        is_pickup: number;
        pickup_target_time_ms: number | null;
        pickup_manual_print_requested: number;
        pickup_collected_at_ms: number | null;
        created_at_ms: number;
        paid_at_ms: number | null;
        printed_at_ms: number | null;
        instructions: string | null;
        payment_method: string | null;
        file_count: number;
      }>();

    const orderIds = (ordersResult.results ?? []).map((o) => o.id);
    const filesByOrder = new Map<string, AdminPickupOrderFile[]>();

    if (orderIds.length > 0) {
      const placeholders = orderIds.map(() => "?").join(",");
      const filesResult = await this.db
        .prepare(
          `SELECT id, order_id, position, original_filename, size_bytes, source_page_count,
                  copies, color_mode, paper_size, sides, selected_pages, print_status
           FROM order_files
           WHERE order_id IN (${placeholders})
           ORDER BY order_id, position ASC`,
        )
        .bind(...orderIds)
        .all<{
          id: string;
          order_id: string;
          position: number;
          original_filename: string;
          size_bytes: number | null;
          source_page_count: number;
          copies: number;
          color_mode: ColorMode;
          paper_size: PaperSize;
          sides: SidesMode;
          selected_pages: string;
          print_status: string;
        }>();

      for (const row of filesResult.results ?? []) {
        const list = filesByOrder.get(row.order_id) ?? [];
        list.push({
          id: row.id,
          position: row.position,
          originalFilename: row.original_filename,
          sizeBytes: row.size_bytes,
          pageCount: row.source_page_count,
          copies: row.copies,
          colorMode: row.color_mode,
          paperSize: row.paper_size,
          sides: row.sides,
          selectedPages: row.selected_pages,
          printStatus: row.print_status,
        });
        filesByOrder.set(row.order_id, list);
      }
    }

    const orders: AdminPickupOrder[] = (ordersResult.results ?? []).map(
      (row) => {
        let pickupFormatted: string | null = null;
        let pickupTargetTime: string | null = null;
        if (row.pickup_target_time_ms) {
          pickupTargetTime = new Date(row.pickup_target_time_ms).toISOString();
          try {
            const datePartDtf = new Intl.DateTimeFormat("en-IN", {
              timeZone: timezone,
              day: "numeric",
              month: "short",
            });
            const timePartDtf = new Intl.DateTimeFormat("en-IN", {
              timeZone: timezone,
              hour: "numeric",
              minute: "numeric",
              hour12: true,
            });
            const dPart = datePartDtf.format(
              new Date(row.pickup_target_time_ms),
            );
            const tPart = timePartDtf.format(
              new Date(row.pickup_target_time_ms),
            );
            pickupFormatted = `${dPart}, from ${tPart}`;
          } catch {
            pickupFormatted = pickupTargetTime;
          }
        }

        return {
          orderId: row.id,
          jobCode: row.public_job_code,
          pickupCode: row.pickup_code,
          customerName: row.customer_name,
          customerPhone: row.customer_phone,
          originalFilename: row.original_filename,
          fileCount: row.file_count,
          totalAmountPaise: row.total_amount_paise,
          paymentMethod: row.payment_method === "CASH" ? "CASH" : "ONLINE",
          paymentStatus: row.paid_at_ms !== null ? "PAID" : "PENDING",
          status: row.status as OrderStatus,
          isPickup: true,
          pickupTargetTime,
          pickupFormatted,
          pickupManualPrintRequested: row.pickup_manual_print_requested === 1,
          pickupCollectedAt: row.pickup_collected_at_ms
            ? new Date(row.pickup_collected_at_ms).toISOString()
            : null,
          createdAt: new Date(row.created_at_ms).toISOString(),
          paidAt: row.paid_at_ms
            ? new Date(row.paid_at_ms).toISOString()
            : null,
          printedAt: row.printed_at_ms
            ? new Date(row.printed_at_ms).toISOString()
            : null,
          instructions: row.instructions,
          files: filesByOrder.get(row.id) ?? [],
        };
      },
    );

    return {
      orders,
      autoPrintEnabled,
      nextCursor: null,
    };
  }

  async setAutoPrint(enabled: boolean): Promise<void> {
    await this.db
      .prepare(
        `UPDATE installation SET pickup_auto_print_enabled = ? WHERE id = 1`,
      )
      .bind(enabled ? 1 : 0)
      .run();
  }

  async requestPickupManualPrint(
    orderId: string,
    adminId: string,
    nowMs: number,
  ): Promise<void> {
    const result = await this.db
      .prepare(
        `UPDATE orders
         SET pickup_manual_print_requested = 1,
             status = CASE WHEN status IN ('PRINT_FAILED','PRINT_BLOCKED','RETRY_PENDING') THEN 'QUEUED' ELSE status END,
             error_category = NULL, raw_error = NULL, next_retry_at_ms = NULL, updated_at_ms = ?
         WHERE id = ? AND is_pickup = 1 AND cleanup_state = 'ACTIVE'`,
      )
      .bind(nowMs, orderId)
      .run();

    if (result.meta.changes === 1) {
      await this.db
        .prepare(
          `INSERT INTO order_events
           (id, order_id, event_type, from_status, to_status, actor_type, actor_id, created_at_ms)
           SELECT ?, id, 'ORDER_PICKUP_MANUAL_PRINT_REQUESTED', status, status, 'ADMIN', ?, ?
           FROM orders WHERE id = ?`,
        )
        .bind(crypto.randomUUID(), adminId, nowMs, orderId)
        .run();
    }
  }

  async markPickupCollected(
    orderId: string,
    adminId: string,
    nowMs: number,
  ): Promise<void> {
    const retentionMs = await this.getOrderRetentionMs();
    const result = await this.db.batch([
      this.db
        .prepare(
          `UPDATE orders
           SET status = 'COMPLETED', completed_at_ms = ?, pickup_collected_at_ms = ?,
               purge_at_ms = ?, updated_at_ms = ?
           WHERE id = ? AND is_pickup = 1 AND status = 'PRINTED'`,
        )
        .bind(nowMs, nowMs, nowMs + retentionMs, nowMs, orderId),
      this.db
        .prepare(
          `UPDATE uploads
           SET retention_reason = 'COMPLETED', delete_after_ms = ?, updated_at_ms = ?
           WHERE order_id = ? AND storage_status = 'UPLOADED'`,
        )
        .bind(nowMs + retentionMs, nowMs, orderId),
      this.db
        .prepare(
          `INSERT INTO order_events
           (id, order_id, event_type, from_status, to_status, actor_type, actor_id, created_at_ms)
           VALUES (?, ?, 'ORDER_PICKUP_COLLECTED', 'PRINTED', 'COMPLETED', 'ADMIN', ?, ?)`,
        )
        .bind(crypto.randomUUID(), orderId, adminId, nowMs),
    ]);

    if (result[0]?.meta.changes !== 1) {
      throw new Error("ORDER_NOT_IN_PRINTED_STATE");
    }
  }
}
