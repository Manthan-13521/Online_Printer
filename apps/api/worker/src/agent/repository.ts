import type {
  AdminAgentDetails,
  AdminCheckPrinterHealthResponseData,
  AdminPrinterDetails,
  AdminTestPrintDetails,
  AgentTestPrintCommand,
  PrinterCapabilitySummary,
  TestPrintCommandStatus,
} from "@printgo/api-contract";
import {
  AGENT_HEARTBEAT_TIMEOUT_MS,
  normalizePrinterFailure,
  isPrinterWideFailure,
} from "@printgo/domain";
import type { ValidatedPrinterReport } from "@printgo/validation";

export interface StoredAgent {
  id: string;
  displayName: string;
  isActive: boolean;
  lastHeartbeatAtMs: number | null;
  onlinePrintingEnabled?: boolean;
  hasPendingCommand?: boolean;
  hasPrintWork?: boolean;
}

export interface StoredPairCode {
  id: string;
  codeHash: string;
  expiresAtMs: number;
  usedAtMs: number | null;
  pairedAgentId: string | null;
}

export interface PrinterTestCommandRow {
  id: string;
  printer_id: string;
  agent_id: string;
  status: string;
  spooler_job_id: string | null;
  failure_code: string | null;
  failure_detail: string | null;
  created_at_ms: number;
  expires_at_ms: number;
  claimed_at_ms: number | null;
  finished_at_ms: number | null;
}

export function toAdminTestPrintDetails(
  row: PrinterTestCommandRow,
  nowMs?: number,
): AdminTestPrintDetails {
  let status = row.status;
  if (
    ["PENDING", "CLAIMED", "SUBMITTED"].includes(status) &&
    nowMs !== undefined &&
    nowMs >= row.expires_at_ms
  ) {
    status = "EXPIRED";
  }
  return {
    commandId: row.id,
    printerId: row.printer_id,
    agentId: row.agent_id,
    status: status as TestPrintCommandStatus,
    spoolerJobId: row.spooler_job_id,
    failureCode: row.failure_code,
    failureDetail: row.failure_detail,
    createdAt: new Date(row.created_at_ms).toISOString(),
    expiresAt: new Date(row.expires_at_ms).toISOString(),
    claimedAt: row.claimed_at_ms
      ? new Date(row.claimed_at_ms).toISOString()
      : null,
    finishedAt: row.finished_at_ms
      ? new Date(row.finished_at_ms).toISOString()
      : null,
  };
}

export interface AgentRepository {
  createPairCode(input: {
    id: string;
    codeHash: string;
    expiresAtMs: number;
    nowMs: number;
  }): Promise<void>;
  findPairCode(codeHash: string): Promise<StoredPairCode | null>;
  consumePairCodeAndCreateAgent(input: {
    pairCodeId: string;
    agentId: string;
    displayName: string;
    credentialHash: string;
    nowMs: number;
  }): Promise<boolean>;
  findAgentByCredentialHash(
    credentialHash: string,
    nowMs?: number,
  ): Promise<StoredAgent | null>;
  findAgentById(agentId: string): Promise<StoredAgent | null>;
  updateHeartbeat(input: {
    agentId: string;
    nowMs: number;
    printers?: readonly ValidatedPrinterReport[];
  }): Promise<void>;
  listAgentsWithPrinters(nowMs: number): Promise<AdminAgentDetails[]>;
  revokeAgent(input: {
    agentId: string;
    adminId: string;
    nowMs: number;
  }): Promise<boolean>;
  togglePrinter(input: {
    printerId: string;
    enabled: boolean;
    adminId: string;
    nowMs: number;
  }): Promise<boolean>;
  findPrinterById(printerId: string): Promise<{
    id: string;
    agentId: string;
    displayName: string;
    windowsPrinterName: string;
    enabled: boolean;
    status: string;
    isProductionEligible: boolean;
    isVirtual: boolean;
  } | null>;
  setDefaultProductionPrinter(input: {
    printerId: string;
    adminId: string;
    nowMs: number;
  }): Promise<{ printerId: string; windowsPrinterName: string }>;
  getDefaultProductionPrinterId(): Promise<string | null>;
  createTestPrintCommand(input: {
    id: string;
    printerId: string;
    agentId: string;
    adminId: string;
    expiresAtMs: number;
    nowMs: number;
  }): Promise<AdminTestPrintDetails>;
  claimPendingTestPrintCommand(
    agentId: string,
    nowMs: number,
  ): Promise<AgentTestPrintCommand | null>;
  reportTestPrintCommand(input: {
    commandId: string;
    agentId: string;
    status: "SUBMITTED" | "BLOCKED" | "SUCCEEDED" | "FAILED";
    spoolerJobId?: string | null;
    failureCode?: string | null;
    failureDetail?: string | null;
    nowMs: number;
  }): Promise<boolean>;
  getLatestTestPrintCommand(
    printerId: string,
    nowMs?: number,
  ): Promise<AdminTestPrintDetails | null>;
  configureFallback(input: {
    printerId: string;
    fallbackPrinterId: string | null;
    autoFallbackEnabled: boolean;
    adminId: string;
    nowMs: number;
  }): Promise<{
    printerId: string;
    fallbackPrinterId: string | null;
    autoFallbackEnabled: boolean;
  }>;
  checkPrinterHealth(
    printerId: string,
    adminId: string,
    nowMs: number,
  ): Promise<AdminCheckPrinterHealthResponseData>;
}

interface AgentRow {
  id: string;
  display_name: string;
  is_active: number;
  paired_at_ms: number | null;
  last_heartbeat_at_ms: number | null;
}

interface PrinterRow {
  id: string;
  agent_id: string;
  display_name: string;
  windows_printer_name: string;
  enabled: number;
  status: "ONLINE" | "OFFLINE" | "BLOCKED" | "ERROR" | "UNKNOWN";
  status_reason: string | null;
  capabilities_json: string | null;
  last_status_at_ms: number | null;
  is_production_eligible: number;
  is_virtual: number;
  port_name: string | null;
  driver_name: string | null;
  is_paused?: number | null;
  paused_reason?: string | null;
  paused_at_ms?: number | null;
  last_health_check_at_ms?: number | null;
  health_check_requested?: number | null;
  fallback_printer_id?: string | null;
  auto_fallback_enabled?: number | null;
}

export class D1AgentRepository implements AgentRepository {
  constructor(private readonly db: D1Database) {}

  async createPairCode(input: {
    id: string;
    codeHash: string;
    expiresAtMs: number;
    nowMs: number;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO agent_pair_codes (id, code_hash, expires_at_ms, created_at_ms)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(input.id, input.codeHash, input.expiresAtMs, input.nowMs)
      .run();
  }

  async findPairCode(codeHash: string): Promise<StoredPairCode | null> {
    const row = await this.db
      .prepare(
        `SELECT id, code_hash, expires_at_ms, used_at_ms, paired_agent_id
         FROM agent_pair_codes WHERE code_hash = ?`,
      )
      .bind(codeHash)
      .first<{
        id: string;
        code_hash: string;
        expires_at_ms: number;
        used_at_ms: number | null;
        paired_agent_id: string | null;
      }>();
    return row
      ? {
          id: row.id,
          codeHash: row.code_hash,
          expiresAtMs: row.expires_at_ms,
          usedAtMs: row.used_at_ms,
          pairedAgentId: row.paired_agent_id,
        }
      : null;
  }

  async consumePairCodeAndCreateAgent(input: {
    pairCodeId: string;
    agentId: string;
    displayName: string;
    credentialHash: string;
    nowMs: number;
  }): Promise<boolean> {
    // D1 batches are transactional. Create the Agent first so the pair-code
    // foreign key never points at a row that does not yet exist, while the
    // guarded INSERT still makes one-time code consumption race-safe.
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO agents (
             id, display_name, credential_hash, is_active, paired_at_ms,
             last_heartbeat_at_ms, created_at_ms, updated_at_ms
           )
           SELECT ?, ?, ?, 1, ?, NULL, ?, ?
           FROM agent_pair_codes
           WHERE id = ? AND used_at_ms IS NULL AND expires_at_ms > ?`,
        )
        .bind(
          input.agentId,
          input.displayName,
          input.credentialHash,
          input.nowMs,
          input.nowMs,
          input.nowMs,
          input.pairCodeId,
          input.nowMs,
        ),
      this.db
        .prepare(
          `UPDATE agent_pair_codes
           SET used_at_ms = ?, paired_agent_id = ?
           WHERE id = ? AND used_at_ms IS NULL AND expires_at_ms > ?
             AND EXISTS (SELECT 1 FROM agents WHERE id = ?)`,
        )
        .bind(
          input.nowMs,
          input.agentId,
          input.pairCodeId,
          input.nowMs,
          input.agentId,
        ),
      this.db
        .prepare(
          `INSERT INTO audit_logs (
             id, actor_type, actor_id, action, entity_type, entity_id, created_at_ms
           )
           SELECT ?, 'AGENT', ?, 'AGENT_PAIRED', 'AGENT', ?, ?
           FROM agent_pair_codes
           WHERE id = ? AND paired_agent_id = ?`,
        )
        .bind(
          crypto.randomUUID(),
          input.agentId,
          input.agentId,
          input.nowMs,
          input.pairCodeId,
          input.agentId,
        ),
    ]);

    const inserted = results[0]?.meta.changes ?? 0;
    const consumed = results[1]?.meta.changes ?? 0;
    if (inserted === 0 && consumed === 0) {
      return false;
    }
    if (inserted !== 1 || consumed !== 1) {
      throw new Error(
        "Agent pairing transaction produced an inconsistent result.",
      );
    }
    return true;
  }

  async findAgentByCredentialHash(
    credentialHash: string,
    nowMs: number = Date.now(),
  ): Promise<StoredAgent | null> {
    const row = await this.db
      .prepare(
        `SELECT id, display_name, is_active, last_heartbeat_at_ms,
          (SELECT online_printing_enabled FROM installation WHERE id = 1) online_printing_enabled,
          EXISTS(SELECT 1 FROM printer_test_commands c WHERE c.agent_id = agents.id AND c.status = 'PENDING') has_pending_command,
          (EXISTS(
            SELECT 1 FROM orders
            WHERE status IN ('QUEUED','CLAIMED','SPOOLING','PRINTING','PRINT_BLOCKED')
          ) OR EXISTS(
            SELECT 1 FROM orders
            WHERE status = 'PRINT_FAILED' AND cleanup_state = 'ACTIVE' AND updated_at_ms <= (? - 60000)
          )) has_print_work
         FROM agents WHERE credential_hash = ?`,
      )
      .bind(nowMs, credentialHash)
      .first<{
        id: string;
        display_name: string;
        is_active: number;
        last_heartbeat_at_ms: number | null;
        online_printing_enabled: number | null;
        has_pending_command: number;
        has_print_work: number;
      }>();
    return row
      ? {
          id: row.id,
          displayName: row.display_name,
          isActive: row.is_active === 1,
          lastHeartbeatAtMs: row.last_heartbeat_at_ms,
          onlinePrintingEnabled: row.online_printing_enabled === 1,
          hasPendingCommand: row.has_pending_command === 1,
          hasPrintWork: row.has_print_work === 1,
        }
      : null;
  }

  async findAgentById(agentId: string): Promise<StoredAgent | null> {
    const row = await this.db
      .prepare(
        `SELECT id, display_name, is_active, last_heartbeat_at_ms
         FROM agents WHERE id = ?`,
      )
      .bind(agentId)
      .first<{
        id: string;
        display_name: string;
        is_active: number;
        last_heartbeat_at_ms: number | null;
      }>();
    return row
      ? {
          id: row.id,
          displayName: row.display_name,
          isActive: row.is_active === 1,
          lastHeartbeatAtMs: row.last_heartbeat_at_ms,
        }
      : null;
  }

  async updateHeartbeat(input: {
    agentId: string;
    nowMs: number;
    printers?: readonly ValidatedPrinterReport[];
  }): Promise<void> {
    const heartbeat = this.db
      .prepare(
        `UPDATE agents SET last_heartbeat_at_ms = ?, updated_at_ms = ?
       WHERE id = ? AND is_active = 1
       AND (last_heartbeat_at_ms IS NULL OR last_heartbeat_at_ms <= ?)`,
      )
      .bind(input.nowMs, input.nowMs, input.agentId, input.nowMs - 60_000);
    if (input.printers === undefined) {
      await heartbeat.run();
      return;
    }
    const existingPrinters = await this.db
      .prepare(
        `SELECT id, windows_printer_name, display_name, enabled, status,
                status_reason, capabilities_json, is_production_eligible,
                is_virtual, port_name, driver_name
         FROM printers WHERE agent_id = ?`,
      )
      .bind(input.agentId)
      .all<{
        id: string;
        windows_printer_name: string;
        display_name: string;
        enabled: number;
        status: string;
        status_reason: string | null;
        capabilities_json: string | null;
        is_production_eligible: number;
        is_virtual: number;
        port_name: string | null;
        driver_name: string | null;
      }>();

    const existingMap = new Map(
      existingPrinters.results.map((p) => [p.windows_printer_name, p]),
    );

    const statements: D1PreparedStatement[] = [];

    const isFirstRegistration = existingPrinters.results.length === 0;

    for (const [index, p] of input.printers.entries()) {
      const capsJson = p.capabilities ? JSON.stringify(p.capabilities) : null;
      const existing = existingMap.get(p.windowsPrinterName);

      if (existing) {
        const capsChanged = existing.capabilities_json !== capsJson;
        const statusChanged = existing.status !== p.status;
        const reasonChanged =
          existing.status_reason !== (p.statusReason ?? null);
        const nameChanged = existing.display_name !== p.displayName;
        const eligibleChanged =
          existing.is_production_eligible !== (p.isProductionEligible ? 1 : 0);
        const virtualChanged = existing.is_virtual !== (p.isVirtual ? 1 : 0);
        const portChanged = existing.port_name !== (p.portName ?? null);
        const driverChanged = existing.driver_name !== (p.driverName ?? null);
        const forceDisable = p.isVirtual && existing.enabled === 1;

        if (
          capsChanged ||
          statusChanged ||
          reasonChanged ||
          nameChanged ||
          eligibleChanged ||
          virtualChanged ||
          portChanged ||
          driverChanged ||
          forceDisable
        ) {
          statements.push(
            this.db
              .prepare(
                `UPDATE printers
                 SET display_name = ?, status = ?, status_reason = ?,
                     capabilities_json = ?, is_production_eligible = ?,
                     is_virtual = ?, port_name = ?, driver_name = ?,
                     enabled = CASE WHEN ? = 1 THEN 0 ELSE enabled END,
                     last_status_at_ms = ?, updated_at_ms = ?
                 WHERE id = ?`,
              )
              .bind(
                p.displayName,
                p.status,
                p.statusReason,
                capsJson,
                p.isProductionEligible ? 1 : 0,
                p.isVirtual ? 1 : 0,
                p.portName ?? null,
                p.driverName ?? null,
                p.isVirtual ? 1 : 0,
                input.nowMs,
                input.nowMs,
                existing.id,
              ),
          );
        }
      } else {
        const autoEnable =
          !p.isVirtual && isFirstRegistration && (p.isDefault || index === 0);
        statements.push(
          this.db
            .prepare(
              `INSERT INTO printers (
                 id, agent_id, display_name, windows_printer_name, enabled,
                 status, status_reason, capabilities_json, is_production_eligible,
                 is_virtual, port_name, driver_name, last_status_at_ms,
                 created_at_ms, updated_at_ms
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              crypto.randomUUID(),
              input.agentId,
              p.displayName,
              p.windowsPrinterName,
              autoEnable ? 1 : 0,
              p.status,
              p.statusReason,
              capsJson,
              p.isProductionEligible ? 1 : 0,
              p.isVirtual ? 1 : 0,
              p.portName ?? null,
              p.driverName ?? null,
              input.nowMs,
              input.nowMs,
              input.nowMs,
            ),
        );
      }
    }

    const reportedPrinterNames = new Set(
      input.printers.map((printer) => printer.windowsPrinterName),
    );
    for (const existing of existingPrinters.results) {
      if (
        !reportedPrinterNames.has(existing.windows_printer_name) &&
        existing.status !== "OFFLINE"
      ) {
        statements.push(
          this.db
            .prepare(
              `UPDATE printers
               SET status = 'OFFLINE',
                   status_reason = 'Not reported by latest Agent heartbeat',
                   last_status_at_ms = ?, updated_at_ms = ?
               WHERE id = ? AND status <> 'OFFLINE'`,
            )
            .bind(input.nowMs, input.nowMs, existing.id),
        );
      }
    }

    // A state change proves current liveness immediately; otherwise persist once/minute.
    statements.unshift(
      statements.length > 0
        ? this.db
            .prepare(
              `UPDATE agents SET last_heartbeat_at_ms = ?, updated_at_ms = ? WHERE id = ? AND is_active = 1`,
            )
            .bind(input.nowMs, input.nowMs, input.agentId)
        : heartbeat,
    );
    // Auto-select default production printer if currently unset or invalid
    statements.push(
      this.db
        .prepare(
          `UPDATE installation
           SET default_production_printer_id = (
             SELECT id FROM printers
             WHERE enabled = 1 AND is_production_eligible = 1 AND is_virtual = 0
             ORDER BY id ASC LIMIT 1
           ), updated_at_ms = ?
           WHERE id = 1 AND (
             default_production_printer_id IS NULL
             OR NOT EXISTS (
               SELECT 1 FROM printers p
               WHERE p.id = installation.default_production_printer_id
                 AND p.is_production_eligible = 1 AND p.is_virtual = 0
             )
           )
           AND EXISTS (
             SELECT 1 FROM printers
             WHERE enabled = 1 AND is_production_eligible = 1 AND is_virtual = 0
           )`,
        )
        .bind(input.nowMs),
    );

    await this.db.batch(statements);
  }

  async listAgentsWithPrinters(nowMs: number): Promise<AdminAgentDetails[]> {
    const [agentResults, printerResults, testCommandResults, installResult] =
      await this.db.batch([
        this.db.prepare(
          `SELECT id, display_name, is_active, paired_at_ms, last_heartbeat_at_ms
         FROM agents WHERE is_active = 1 ORDER BY created_at_ms ASC`,
        ),
        this.db.prepare(
          `SELECT id, agent_id, display_name, windows_printer_name, enabled,
                status, status_reason, capabilities_json, last_status_at_ms,
                is_production_eligible, is_virtual, port_name, driver_name,
                is_paused, paused_reason, paused_at_ms, last_health_check_at_ms, health_check_requested,
                fallback_printer_id, auto_fallback_enabled
         FROM printers ORDER BY windows_printer_name ASC`,
        ),
        this.db.prepare(
          `SELECT ptc.id, ptc.printer_id, ptc.agent_id, ptc.status, ptc.spooler_job_id,
                ptc.failure_code, ptc.failure_detail, ptc.created_at_ms, ptc.expires_at_ms,
                ptc.claimed_at_ms, ptc.finished_at_ms
         FROM printers p JOIN printer_test_commands ptc ON ptc.id = (
           SELECT id FROM printer_test_commands WHERE printer_id = p.id
           ORDER BY created_at_ms DESC, id DESC LIMIT 1
         )`,
        ),
        this.db.prepare(
          `SELECT default_production_printer_id FROM installation WHERE id = 1`,
        ),
      ]);

    const agentRows = (agentResults?.results ?? []) as unknown as AgentRow[];
    const printerRows = (printerResults?.results ??
      []) as unknown as PrinterRow[];
    const testCommandRows = (testCommandResults?.results ??
      []) as unknown as PrinterTestCommandRow[];
    const defaultProductionPrinterId =
      (
        installResult?.results[0] as
          { default_production_printer_id: string | null } | undefined
      )?.default_production_printer_id ?? null;

    const latestTestPrintByPrinter = new Map<string, AdminTestPrintDetails>();
    for (const tcr of testCommandRows) {
      latestTestPrintByPrinter.set(
        tcr.printer_id,
        toAdminTestPrintDetails(tcr, nowMs),
      );
    }

    const printersByAgent = new Map<string, AdminPrinterDetails[]>();
    for (const pr of printerRows) {
      let capabilities: PrinterCapabilitySummary | null = null;
      if (pr.capabilities_json) {
        try {
          capabilities = JSON.parse(
            pr.capabilities_json,
          ) as PrinterCapabilitySummary;
        } catch {
          capabilities = null;
        }
      }
      const list = printersByAgent.get(pr.agent_id) ?? [];
      list.push({
        id: pr.id,
        agentId: pr.agent_id,
        displayName: pr.display_name,
        windowsPrinterName: pr.windows_printer_name,
        enabled: pr.enabled === 1,
        status: pr.status,
        statusReason: pr.status_reason,
        capabilities,
        lastStatusAt: pr.last_status_at_ms
          ? new Date(pr.last_status_at_ms).toISOString()
          : null,
        latestTestPrint: latestTestPrintByPrinter.get(pr.id) ?? null,
        isProductionEligible: pr.is_production_eligible === 1,
        isVirtual: pr.is_virtual === 1,
        isProductionDefault: pr.id === defaultProductionPrinterId,
        portName: pr.port_name ?? null,
        driverName: pr.driver_name ?? null,
        isPaused: pr.is_paused === 1,
        pausedReason: pr.paused_reason ?? null,
        pausedAt: pr.paused_at_ms
          ? new Date(pr.paused_at_ms).toISOString()
          : null,
        lastHealthCheckAt: pr.last_health_check_at_ms
          ? new Date(pr.last_health_check_at_ms).toISOString()
          : null,
        healthCheckRequested: pr.health_check_requested === 1,
        fallbackPrinterId: pr.fallback_printer_id ?? null,
        autoFallbackEnabled: pr.auto_fallback_enabled === 1,
      });
      printersByAgent.set(pr.agent_id, list);
    }

    return agentRows.map((ar) => {
      const isOnline =
        ar.is_active === 1 &&
        ar.last_heartbeat_at_ms !== null &&
        nowMs - ar.last_heartbeat_at_ms <= AGENT_HEARTBEAT_TIMEOUT_MS;

      return {
        id: ar.id,
        displayName: ar.display_name,
        isActive: ar.is_active === 1,
        isOnline,
        pairedAt: ar.paired_at_ms
          ? new Date(ar.paired_at_ms).toISOString()
          : null,
        lastHeartbeatAt: ar.last_heartbeat_at_ms
          ? new Date(ar.last_heartbeat_at_ms).toISOString()
          : null,
        printers: printersByAgent.get(ar.id) ?? [],
      };
    });
  }

  async revokeAgent(input: {
    agentId: string;
    adminId: string;
    nowMs: number;
  }): Promise<boolean> {
    // Check if agent exists at all (regardless of active status)
    const existing = await this.db
      .prepare(`SELECT id, is_active FROM agents WHERE id = ?`)
      .bind(input.agentId)
      .first<{ id: string; is_active: number }>();

    if (!existing) {
      // Agent does not exist — not found
      return false;
    }

    if (existing.is_active === 0) {
      // Already revoked — idempotent success
      return true;
    }

    // Newly revoking — update agent, mark printers OFFLINE, write audit log
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE agents SET is_active = 0, updated_at_ms = ? WHERE id = ?`,
        )
        .bind(input.nowMs, input.agentId),
      this.db
        .prepare(
          `UPDATE printers
           SET status = 'OFFLINE', status_reason = 'Agent revoked by administrator',
               last_status_at_ms = ?, updated_at_ms = ?
           WHERE agent_id = ?`,
        )
        .bind(input.nowMs, input.nowMs, input.agentId),
      this.db
        .prepare(
          `INSERT INTO audit_logs (
             id, actor_type, actor_id, action, entity_type, entity_id, created_at_ms
           ) VALUES (?, 'ADMIN', ?, 'AGENT_REVOKED', 'AGENT', ?, ?)`,
        )
        .bind(crypto.randomUUID(), input.adminId, input.agentId, input.nowMs),
    ]);

    return true;
  }

  async togglePrinter(input: {
    printerId: string;
    enabled: boolean;
    adminId: string;
    nowMs: number;
  }): Promise<boolean> {
    if (input.enabled) {
      const printer = await this.db
        .prepare(
          `SELECT is_virtual, is_production_eligible FROM printers WHERE id = ?`,
        )
        .bind(input.printerId)
        .first<{ is_virtual: number; is_production_eligible: number }>();
      if (!printer) {
        return false;
      }
      if (printer.is_virtual === 1 || printer.is_production_eligible === 0) {
        throw new Error("CANNOT_ENABLE_VIRTUAL_PRINTER");
      }
    }

    const result = await this.db
      .prepare(
        `UPDATE printers
         SET enabled = ?, updated_at_ms = ?
         WHERE id = ?`,
      )
      .bind(input.enabled ? 1 : 0, input.nowMs, input.printerId)
      .run();

    if (result.meta.changes === 1) {
      await this.db
        .prepare(
          `INSERT INTO audit_logs (
             id, actor_type, actor_id, action, entity_type, entity_id, created_at_ms
           ) VALUES (?, 'ADMIN', ?, ?, 'PRINTER', ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          input.adminId,
          input.enabled ? "PRINTER_ENABLED" : "PRINTER_DISABLED",
          input.printerId,
          input.nowMs,
        )
        .run();
      return true;
    }
    return false;
  }

  async findPrinterById(printerId: string): Promise<{
    id: string;
    agentId: string;
    displayName: string;
    windowsPrinterName: string;
    enabled: boolean;
    status: string;
    isProductionEligible: boolean;
    isVirtual: boolean;
  } | null> {
    const row = await this.db
      .prepare(
        `SELECT id, agent_id, display_name, windows_printer_name, enabled, status,
                is_production_eligible, is_virtual
         FROM printers WHERE id = ?`,
      )
      .bind(printerId)
      .first<{
        id: string;
        agent_id: string;
        display_name: string;
        windows_printer_name: string;
        enabled: number;
        status: string;
        is_production_eligible: number;
        is_virtual: number;
      }>();
    return row
      ? {
          id: row.id,
          agentId: row.agent_id,
          displayName: row.display_name,
          windowsPrinterName: row.windows_printer_name,
          enabled: row.enabled === 1,
          status: row.status,
          isProductionEligible: row.is_production_eligible === 1,
          isVirtual: row.is_virtual === 1,
        }
      : null;
  }

  async getDefaultProductionPrinterId(): Promise<string | null> {
    const row = await this.db
      .prepare(
        `SELECT default_production_printer_id FROM installation WHERE id = 1`,
      )
      .first<{ default_production_printer_id: string | null }>();
    return row?.default_production_printer_id ?? null;
  }

  async setDefaultProductionPrinter(input: {
    printerId: string;
    adminId: string;
    nowMs: number;
  }): Promise<{ printerId: string; windowsPrinterName: string }> {
    const printer = await this.db
      .prepare(
        `SELECT id, windows_printer_name, enabled, is_production_eligible, is_virtual
         FROM printers WHERE id = ?`,
      )
      .bind(input.printerId)
      .first<{
        id: string;
        windows_printer_name: string;
        enabled: number;
        is_production_eligible: number;
        is_virtual: number;
      }>();

    if (!printer) {
      throw new Error("PRINTER_NOT_FOUND");
    }
    if (printer.is_virtual === 1 || printer.is_production_eligible !== 1) {
      throw new Error("PRINTER_NOT_ELIGIBLE");
    }

    await this.db.batch([
      this.db
        .prepare(
          `UPDATE installation
           SET default_production_printer_id = ?, updated_at_ms = ?
           WHERE id = 1`,
        )
        .bind(printer.id, input.nowMs),
      this.db
        .prepare(
          `UPDATE printers SET enabled = 1, updated_at_ms = ? WHERE id = ?`,
        )
        .bind(input.nowMs, printer.id),
      this.db
        .prepare(
          `INSERT INTO audit_logs (
             id, actor_type, actor_id, action, entity_type, entity_id, created_at_ms
           ) VALUES (?, 'ADMIN', ?, 'DEFAULT_PRODUCTION_PRINTER_SET', 'PRINTER', ?, ?)`,
        )
        .bind(crypto.randomUUID(), input.adminId, printer.id, input.nowMs),
    ]);

    return {
      printerId: printer.id,
      windowsPrinterName: printer.windows_printer_name,
    };
  }

  async createTestPrintCommand(input: {
    id: string;
    printerId: string;
    agentId: string;
    adminId: string;
    expiresAtMs: number;
    nowMs: number;
  }): Promise<AdminTestPrintDetails> {
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO printer_test_commands (
             id, printer_id, agent_id, status, created_at_ms, expires_at_ms
           ) VALUES (?, ?, ?, 'PENDING', ?, ?)`,
        )
        .bind(
          input.id,
          input.printerId,
          input.agentId,
          input.nowMs,
          input.expiresAtMs,
        ),
      this.db
        .prepare(
          `INSERT INTO audit_logs (
             id, actor_type, actor_id, action, entity_type, entity_id, created_at_ms
           ) VALUES (?, 'ADMIN', ?, 'TEST_PRINT_REQUESTED', 'PRINTER', ?, ?)`,
        )
        .bind(crypto.randomUUID(), input.adminId, input.printerId, input.nowMs),
    ]);

    return {
      commandId: input.id,
      printerId: input.printerId,
      agentId: input.agentId,
      status: "PENDING",
      spoolerJobId: null,
      failureCode: null,
      failureDetail: null,
      createdAt: new Date(input.nowMs).toISOString(),
      expiresAt: new Date(input.expiresAtMs).toISOString(),
      claimedAt: null,
      finishedAt: null,
    };
  }

  async claimPendingTestPrintCommand(
    agentId: string,
    nowMs: number,
  ): Promise<AgentTestPrintCommand | null> {
    const hasPending = await this.db
      .prepare(
        "SELECT 1 FROM printer_test_commands WHERE agent_id = ? AND status = 'PENDING' LIMIT 1",
      )
      .bind(agentId)
      .first();
    if (!hasPending) return null;
    // 1. Mark expired pending commands for this agent
    await this.db
      .prepare(
        `UPDATE printer_test_commands
         SET status = 'EXPIRED', finished_at_ms = ?
         WHERE agent_id = ? AND status = 'PENDING' AND expires_at_ms <= ?`,
      )
      .bind(nowMs, agentId, nowMs)
      .run();

    // 2. Find oldest pending command with printer info
    const pending = await this.db
      .prepare(
        `SELECT c.id, c.printer_id, c.expires_at_ms,
                p.windows_printer_name, p.display_name AS printer_display_name,
                i.shop_name
         FROM printer_test_commands c
         JOIN printers p ON c.printer_id = p.id
         JOIN installation i ON i.id = 1
         WHERE c.agent_id = ? AND c.status = 'PENDING' AND c.expires_at_ms > ?
           AND p.enabled = 1
         ORDER BY c.created_at_ms ASC
         LIMIT 1`,
      )
      .bind(agentId, nowMs)
      .first<{
        id: string;
        printer_id: string;
        expires_at_ms: number;
        windows_printer_name: string;
        printer_display_name: string;
        shop_name: string;
      }>();

    if (!pending) {
      return null;
    }

    // 3. Atomically claim it
    const updateResult = await this.db
      .prepare(
        `UPDATE printer_test_commands
         SET status = 'CLAIMED', claimed_at_ms = ?
         WHERE id = ? AND status = 'PENDING'`,
      )
      .bind(nowMs, pending.id)
      .run();

    if (updateResult.meta.changes !== 1) {
      return null;
    }

    return {
      commandId: pending.id,
      type: "TEST_PRINT",
      printerId: pending.printer_id,
      windowsPrinterName: pending.windows_printer_name,
      printerDisplayName: pending.printer_display_name,
      shopName: pending.shop_name,
      expiresAtMs: pending.expires_at_ms,
    };
  }

  async reportTestPrintCommand(input: {
    commandId: string;
    agentId: string;
    status: "SUBMITTED" | "BLOCKED" | "SUCCEEDED" | "FAILED";
    spoolerJobId?: string | null;
    failureCode?: string | null;
    failureDetail?: string | null;
    nowMs: number;
  }): Promise<boolean> {
    const isTerminal =
      input.status === "SUCCEEDED" ||
      input.status === "FAILED" ||
      input.status === "BLOCKED";
    const finishedAtMs = isTerminal ? input.nowMs : null;

    const current = await this.db
      .prepare(
        `SELECT status FROM printer_test_commands
         WHERE id = ? AND agent_id = ?`,
      )
      .bind(input.commandId, input.agentId)
      .first<{ status: string }>();
    if (!current) {
      return false;
    }
    if (current.status === input.status) {
      return true;
    }

    const allowed =
      (current.status === "CLAIMED" &&
        ["SUBMITTED", "BLOCKED", "SUCCEEDED", "FAILED"].includes(
          input.status,
        )) ||
      (current.status === "SUBMITTED" &&
        ["BLOCKED", "SUCCEEDED", "FAILED"].includes(input.status));
    if (!allowed) {
      return false;
    }

    const updateResult = await this.db
      .prepare(
        `UPDATE printer_test_commands
         SET status = ?,
             spooler_job_id = COALESCE(?, spooler_job_id),
             failure_code = ?,
             failure_detail = ?,
             finished_at_ms = COALESCE(?, finished_at_ms)
         WHERE id = ? AND agent_id = ? AND status = ?`,
      )
      .bind(
        input.status,
        input.spoolerJobId ?? null,
        input.failureCode ?? null,
        input.failureDetail ?? null,
        finishedAtMs,
        input.commandId,
        input.agentId,
        current.status,
      )
      .run();

    if (updateResult.meta.changes !== 1) {
      return false;
    }

    // The command row is the authoritative diagnostic audit record: it keeps
    // shop-scoped printer/Agent identity, timestamps, status, failure and exact
    // spool identity. Avoid duplicating every harmless status transition into
    // audit_logs; the admin request audit above still records who initiated it.
    return true;
  }

  async getLatestTestPrintCommand(
    printerId: string,
    nowMs?: number,
  ): Promise<AdminTestPrintDetails | null> {
    const row = await this.db
      .prepare(
        `SELECT id, printer_id, agent_id, status, spooler_job_id,
                failure_code, failure_detail, created_at_ms, expires_at_ms,
                claimed_at_ms, finished_at_ms
         FROM printer_test_commands
         WHERE printer_id = ?
         ORDER BY created_at_ms DESC
         LIMIT 1`,
      )
      .bind(printerId)
      .first<PrinterTestCommandRow>();

    return row ? toAdminTestPrintDetails(row, nowMs) : null;
  }

  async configureFallback(input: {
    printerId: string;
    fallbackPrinterId: string | null;
    autoFallbackEnabled: boolean;
    adminId: string;
    nowMs: number;
  }): Promise<{
    printerId: string;
    fallbackPrinterId: string | null;
    autoFallbackEnabled: boolean;
  }> {
    const printer = await this.db
      .prepare(`SELECT id FROM printers WHERE id = ?`)
      .bind(input.printerId)
      .first<{ id: string }>();
    if (!printer) throw new Error("PRINTER_NOT_FOUND");

    if (input.fallbackPrinterId) {
      if (input.fallbackPrinterId === input.printerId) {
        throw new Error("FALLBACK_SELF_REFERENCE");
      }
      const fallback = await this.db
        .prepare(
          `SELECT id, fallback_printer_id FROM printers WHERE id = ?`,
        )
        .bind(input.fallbackPrinterId)
        .first<{ id: string; fallback_printer_id: string | null }>();
      if (!fallback) throw new Error("FALLBACK_PRINTER_NOT_FOUND");
      // Prevent loop: if fallback's own fallback is this printer
      if (fallback.fallback_printer_id === input.printerId) {
        throw new Error("FALLBACK_LOOP_DETECTED");
      }
    }

    await this.db.batch([
      this.db
        .prepare(
          `UPDATE printers
           SET fallback_printer_id = ?, auto_fallback_enabled = ?, updated_at_ms = ?
           WHERE id = ?`,
        )
        .bind(
          input.fallbackPrinterId,
          input.autoFallbackEnabled ? 1 : 0,
          input.nowMs,
          input.printerId,
        ),
      this.db
        .prepare(
          `INSERT INTO audit_logs (
             id, actor_type, actor_id, action, entity_type, entity_id, created_at_ms
           ) VALUES (?, 'ADMIN', ?, 'FALLBACK_CONFIGURED', 'PRINTER', ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          input.adminId,
          input.printerId,
          input.nowMs,
        ),
    ]);

    return {
      printerId: input.printerId,
      fallbackPrinterId: input.fallbackPrinterId,
      autoFallbackEnabled: input.autoFallbackEnabled,
    };
  }

  async checkPrinterHealth(
    printerId: string,
    _adminId: string,
    nowMs: number,
  ): Promise<AdminCheckPrinterHealthResponseData> {
    const printer = await this.db
      .prepare(
        `SELECT p.id, p.agent_id, p.display_name, p.status, p.status_reason, p.is_paused,
                p.paused_reason, p.paused_at_ms, a.is_active, a.last_heartbeat_at_ms
         FROM printers p
         JOIN agents a ON a.id = p.agent_id
         WHERE p.id = ?`,
      )
      .bind(printerId)
      .first<{
        id: string;
        agent_id: string;
        display_name: string;
        status: string;
        status_reason: string | null;
        is_paused: number;
        paused_reason: string | null;
        paused_at_ms: number | null;
        is_active: number;
        last_heartbeat_at_ms: number | null;
      }>();

    if (!printer) {
      throw new Error("PRINTER_NOT_FOUND");
    }

    const agentIsOnline =
      printer.is_active === 1 &&
      printer.last_heartbeat_at_ms !== null &&
      nowMs - printer.last_heartbeat_at_ms <= AGENT_HEARTBEAT_TIMEOUT_MS;

    if (!agentIsOnline) {
      return {
        printerId: printer.id,
        isPaused: true,
        status: "OFFLINE",
        message: "Agent is offline. Cannot verify printer health.",
      };
    }

    const normReason = normalizePrinterFailure(
      printer.status_reason ||
        (printer.status !== "ONLINE" ? printer.status : null),
    );

    if (printer.status !== "ONLINE" || isPrinterWideFailure(normReason)) {
      await this.db
        .prepare(
          `UPDATE printers SET last_health_check_at_ms = ?, health_check_requested = 1, updated_at_ms = ? WHERE id = ?`,
        )
        .bind(nowMs, nowMs, printer.id)
        .run();

      return {
        printerId: printer.id,
        isPaused: true,
        status: printer.status,
        message: `Printer is still reporting issue (${printer.status_reason || normReason}). Queue remains paused.`,
      };
    }

    await this.db
      .prepare(
        `UPDATE printers
         SET is_paused = 0, paused_reason = NULL, paused_at_ms = NULL,
             last_health_check_at_ms = ?, health_check_requested = 0, updated_at_ms = ?
         WHERE id = ?`,
      )
      .bind(nowMs, nowMs, printer.id)
      .run();

    return {
      printerId: printer.id,
      isPaused: false,
      status: "ONLINE",
      message: "Printer is healthy and online. Queue resumed.",
    };
  }
}
