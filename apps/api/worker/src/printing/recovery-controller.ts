/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { D1PrintingRepository } from "./repository";
import type {
  AdminPrintSystemStatusData,
  AdminRecoverPrintingResponseData,
  PrintSystemRecoverability,
} from "@printgo/api-contract";

// Typed D1 Rows
interface OrderRow {
  id: string;
  public_job_code: string;
  status: string;
  claimed_by_agent_id: string | null;
  printer_id: string | null;
}

interface CountRow {
  count: number;
}

interface InstallationRow {
  default_production_printer_id: string | null;
  claims_paused: number;
  recovery_lock_id: string | null;
}

interface AttemptRow {
  id: string;
  status: string;
  submitted_at_ms: number | null;
  last_progress_at_ms: number | null;
}

interface PrinterAgentRow {
  status: string;
  status_reason: string | null;
  agent_id: string;
  is_active: number;
  last_heartbeat_at_ms: number | null;
}

export class RecoveryController {
  constructor(private readonly printingRepo: D1PrintingRepository) {}

  async getSystemStatus(nowMs: number): Promise<AdminPrintSystemStatusData> {
    const db = (this.printingRepo as unknown as { db: any }).db;

    // We can do everything in 1 batch roundtrip to save costs
    const batchResult = await db.batch([
      // 0: Active Order
      db.prepare(
        `SELECT id, public_job_code, status, claimed_by_agent_id, printer_id 
         FROM orders 
         WHERE status IN ('CLAIMED','SPOOLING','PRINTING','PRINT_BLOCKED','COMPLETION_UNKNOWN')
         ORDER BY updated_at_ms DESC LIMIT 1`,
      ),
      // 1: Waiting Count
      db.prepare(
        `SELECT COUNT(*) as count FROM orders WHERE status = 'QUEUED'`,
      ),
      // 2: Installation info
      db.prepare(
        `SELECT default_production_printer_id, claims_paused, recovery_lock_id FROM installation WHERE id = 1`,
      ),
    ]);

    const currentOrder = batchResult[0].results[0] as OrderRow | undefined;
    const waitingCount = (batchResult[1].results[0] as CountRow).count;
    const inst = batchResult[2].results[0] as InstallationRow | undefined;

    let isStalled = false;
    let targetPrinterId = currentOrder?.printer_id || null;

    if (!targetPrinterId && inst?.default_production_printer_id) {
      targetPrinterId = inst.default_production_printer_id;
    }

    // Second batch for dependencies
    const secondBatch = [];
    if (currentOrder && currentOrder.status === "PRINTING") {
      secondBatch.push(
        db
          .prepare(
            `SELECT last_progress_at_ms FROM print_attempts WHERE order_id = ? ORDER BY attempt_number DESC LIMIT 1`,
          )
          .bind(currentOrder.id),
      );
    } else {
      secondBatch.push(db.prepare(`SELECT 1 WHERE 0`)); // dummy
    }

    if (targetPrinterId) {
      secondBatch.push(
        db
          .prepare(
            `SELECT p.status, p.status_reason, p.agent_id, a.is_active, a.last_heartbeat_at_ms 
                    FROM printers p 
                    JOIN agents a ON p.agent_id = a.id 
                    WHERE p.id = ?`,
          )
          .bind(targetPrinterId),
      );
    } else {
      secondBatch.push(db.prepare(`SELECT 1 WHERE 0`));
    }

    const secondResult = await db.batch(secondBatch);

    const attempt = secondResult[0].results[0] as AttemptRow | undefined;
    if (attempt && attempt.last_progress_at_ms) {
      if (nowMs - attempt.last_progress_at_ms >= 5 * 60 * 1000) {
        isStalled = true;
      }
    }

    const printerData = secondResult[1].results[0] as
      PrinterAgentRow | undefined;

    let agentStatus: AdminPrintSystemStatusData["agentStatus"] = "OFFLINE";
    let printerStatus: AdminPrintSystemStatusData["printerStatus"] = "OFFLINE";
    let printerStatusMessage = "Printer Offline";
    let agentIsActive = false;

    if (printerData) {
      if (printerData.is_active === 0) {
        agentStatus = "OFFLINE";
      } else if (
        !printerData.last_heartbeat_at_ms ||
        nowMs - printerData.last_heartbeat_at_ms > 3 * 60 * 1000
      ) {
        agentStatus = "STALE";
      } else {
        agentStatus = "ONLINE";
        agentIsActive = true;
      }

      if (printerData.status === "ONLINE") {
        printerStatus = "READY";
        printerStatusMessage = "Ready";
      } else {
        const upperReason = (
          printerData.status_reason || printerData.status
        ).toUpperCase();
        if (upperReason.includes("PAPER_JAM") || upperReason.includes("JAM")) {
          printerStatus = "PAPER_JAM";
        } else if (
          upperReason.includes("PAPER_OUT") ||
          upperReason.includes("OUT_OF_PAPER") ||
          upperReason.includes("NO_PAPER")
        ) {
          printerStatus = "PAPER_OUT";
        } else if (
          printerData.status === "OFFLINE" ||
          upperReason.includes("OFFLINE")
        ) {
          printerStatus = "OFFLINE";
        } else {
          printerStatus = "ERROR";
        }
        printerStatusMessage = printerData.status_reason || "Printer Error";
      }
    }

    // eslint-disable-next-line no-useless-assignment
    let recoverability: PrintSystemRecoverability = "READY";

    if (inst?.recovery_lock_id) {
      recoverability = "RECOVERY_ALREADY_RUNNING";
    } else if (!agentIsActive) {
      recoverability =
        agentStatus === "STALE" ? "AGENT_STALE" : "AGENT_OFFLINE";
    } else if (printerStatus !== "READY") {
      recoverability =
        printerStatus === "PAPER_JAM"
          ? "PAPER_JAM"
          : printerStatus === "PAPER_OUT"
            ? "PAPER_OUT"
            : printerStatus === "OFFLINE"
              ? "PRINTER_OFFLINE"
              : "PRINTER_ERROR";
    } else if (currentOrder || inst?.claims_paused) {
      if (
        inst?.claims_paused ||
        isStalled ||
        (currentOrder &&
          [
            "CLAIMED",
            "SPOOLING",
            "PRINT_BLOCKED",
            "COMPLETION_UNKNOWN",
          ].includes(currentOrder.status))
      ) {
        recoverability = "READY";
      } else {
        recoverability = "HEALTHY_PRINTING";
      }
    } else {
      recoverability = "NO_ACTIVE_ORDER";
    }

    return {
      agentStatus,
      printerStatus,
      printerStatusMessage,
      currentOrder: currentOrder
        ? {
            id: currentOrder.id,
            publicJobCode: currentOrder.public_job_code,
            status: currentOrder.status,
            isStalled,
          }
        : null,
      waitingCount,
      recoverability,
    };
  }

  async executeRecovery(
    _adminId: string,
    nowMs: number,
  ): Promise<AdminRecoverPrintingResponseData> {
    const db = (this.printingRepo as unknown as { db: any }).db;
    const lockId = crypto.randomUUID();

    interface MetaResult {
      meta: { changes: number };
    }

    const lockResult = (await db
      .prepare(
        `UPDATE installation SET recovery_lock_id = ?, recovery_locked_at_ms = ?, claims_paused = 1 
       WHERE id = 1 AND recovery_lock_id IS NULL`,
      )
      .bind(lockId, nowMs)
      .run()) as MetaResult;

    if (lockResult.meta.changes !== 1) {
      throw new Error("RECOVERY_ALREADY_RUNNING");
    }

    try {
      const status = await this.getSystemStatus(nowMs);
      if (
        status.recoverability !== "READY" &&
        status.recoverability !== "RECOVERY_ALREADY_RUNNING"
      ) {
        throw new Error(status.recoverability);
      }

      const currentOrder = (await db
        .prepare(
          `SELECT id, status FROM orders 
         WHERE status IN ('CLAIMED','SPOOLING','PRINTING','PRINT_BLOCKED','COMPLETION_UNKNOWN')
         ORDER BY updated_at_ms DESC LIMIT 1`,
        )
        .first()) as OrderRow | undefined;

      if (!currentOrder) {
        // Only unpause claims, since no order needs recovery
        return { recoveredOrderId: null, message: "No active order found." };
      }

      const attempt = (await db
        .prepare(
          `SELECT id, status, submitted_at_ms FROM print_attempts 
         WHERE order_id = ? ORDER BY attempt_number DESC LIMIT 1`,
        )
        .bind(currentOrder.id)
        .first()) as AttemptRow | undefined;

      // Classify
      if (
        !attempt ||
        attempt.status === "CREATED" ||
        !attempt.submitted_at_ms
      ) {
        // Definitely not submitted
        const batchStatements = [];
        if (attempt) {
          batchStatements.push(
            db
              .prepare(
                `UPDATE print_attempts SET status = 'FAILED', updated_at_ms = ? WHERE id = ?`,
              )
              .bind(nowMs, attempt.id),
          );
          batchStatements.push(
            db
              .prepare(
                `UPDATE print_attempt_steps SET status = 'FAILED', updated_at_ms = ? WHERE print_attempt_id = ? AND status IN ('PENDING', 'SUBMISSION_STARTED')`,
              )
              .bind(nowMs, attempt.id),
          );
        }

        batchStatements.push(
          db
            .prepare(
              `UPDATE orders SET status = 'QUEUED', claim_id = NULL, claimed_by_agent_id = NULL, claim_expires_at_ms = NULL, updated_at_ms = ? WHERE id = ?`,
            )
            .bind(nowMs, currentOrder.id),
        );

        await db.batch(batchStatements);

        return {
          recoveredOrderId: currentOrder.id,
          message: "Unsubmitted order safely requeued.",
        };
      }

      // If it got past CREATED and has submitted_at_ms, it's uncertain.
      if (
        [
          "SUBMITTING",
          "PRINTING",
          "BLOCKED",
          "SUCCEEDED",
          "FAILED",
          "UNCERTAIN",
        ].includes(attempt.status) ||
        attempt.submitted_at_ms
      ) {
        await db.batch([
          db
            .prepare(
              `UPDATE print_attempts SET status = 'FAILED', updated_at_ms = ? WHERE id = ? AND status NOT IN ('SUCCEEDED', 'FAILED')`,
            )
            .bind(nowMs, attempt.id),
          db
            .prepare(
              `UPDATE orders SET status = 'COMPLETION_UNKNOWN', claimed_by_agent_id = NULL, claim_id = NULL, claim_expires_at_ms = NULL, updated_at_ms = ? WHERE id = ?`,
            )
            .bind(nowMs, currentOrder.id),
        ]);

        return {
          recoveredOrderId: currentOrder.id,
          message: "Order submission uncertain. Marked as COMPLETION_UNKNOWN.",
        };
      }

      return {
        recoveredOrderId: currentOrder.id,
        message: "Recovery processed.",
      };
    } finally {
      await db
        .prepare(
          `UPDATE installation SET recovery_lock_id = NULL, recovery_locked_at_ms = NULL, claims_paused = 0 WHERE id = 1 AND recovery_lock_id = ?`,
        )
        .bind(lockId)
        .run();
    }
  }
}
