import type {
  AdminAgentDetails,
  AdminPrinterDetails,
  AdminTestPrintDetails,
  AgentTestPrintCommand,
  PrinterCapabilitySummary,
  TestPrintCommandStatus,
} from "@printgo/api-contract";
import { AGENT_HEARTBEAT_TIMEOUT_MS } from "@printgo/domain";
import type { ValidatedPrinterReport } from "@printgo/validation";

export interface StoredAgent {
  id: string;
  displayName: string;
  isActive: boolean;
  lastHeartbeatAtMs: number | null;
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
    status === "PENDING" &&
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
  ): Promise<StoredAgent | null>;
  findAgentById(agentId: string): Promise<StoredAgent | null>;
  updateHeartbeat(input: {
    agentId: string;
    nowMs: number;
    printers: readonly ValidatedPrinterReport[];
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
  } | null>;
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
  ): Promise<StoredAgent | null> {
    const row = await this.db
      .prepare(
        `SELECT id, display_name, is_active, last_heartbeat_at_ms
         FROM agents WHERE credential_hash = ?`,
      )
      .bind(credentialHash)
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
    printers: readonly ValidatedPrinterReport[];
  }): Promise<void> {
    const existingPrinters = await this.db
      .prepare(
        `SELECT id, windows_printer_name, display_name, enabled, status,
                status_reason, capabilities_json
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
      }>();

    const existingMap = new Map(
      existingPrinters.results.map((p) => [p.windows_printer_name, p]),
    );

    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `UPDATE agents
           SET last_heartbeat_at_ms = ?, updated_at_ms = ?
           WHERE id = ? AND is_active = 1`,
        )
        .bind(input.nowMs, input.nowMs, input.agentId),
    ];

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

        if (capsChanged || statusChanged || reasonChanged || nameChanged) {
          statements.push(
            this.db
              .prepare(
                `UPDATE printers
                 SET display_name = ?, status = ?, status_reason = ?,
                     capabilities_json = ?, last_status_at_ms = ?, updated_at_ms = ?
                 WHERE id = ?`,
              )
              .bind(
                p.displayName,
                p.status,
                p.statusReason,
                capsJson,
                input.nowMs,
                input.nowMs,
                existing.id,
              ),
          );
        }
      } else {
        const autoEnable = isFirstRegistration && (p.isDefault || index === 0);
        statements.push(
          this.db
            .prepare(
              `INSERT INTO printers (
                 id, agent_id, display_name, windows_printer_name, enabled,
                 status, status_reason, capabilities_json, last_status_at_ms,
                 created_at_ms, updated_at_ms
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      if (!reportedPrinterNames.has(existing.windows_printer_name)) {
        statements.push(
          this.db
            .prepare(
              `UPDATE printers
               SET status = 'OFFLINE',
                   status_reason = 'Not reported by latest Agent heartbeat',
                   last_status_at_ms = ?, updated_at_ms = ?
               WHERE id = ?`,
            )
            .bind(input.nowMs, input.nowMs, existing.id),
        );
      }
    }

    await this.db.batch(statements);
  }

  async listAgentsWithPrinters(nowMs: number): Promise<AdminAgentDetails[]> {
    const [agentResults, printerResults, testCommandResults] =
      await this.db.batch([
        this.db.prepare(
          `SELECT id, display_name, is_active, paired_at_ms, last_heartbeat_at_ms
         FROM agents ORDER BY created_at_ms ASC`,
        ),
        this.db.prepare(
          `SELECT id, agent_id, display_name, windows_printer_name, enabled,
                status, status_reason, capabilities_json, last_status_at_ms
         FROM printers ORDER BY windows_printer_name ASC`,
        ),
        this.db.prepare(
          `SELECT ptc.id, ptc.printer_id, ptc.agent_id, ptc.status, ptc.spooler_job_id,
                ptc.failure_code, ptc.failure_detail, ptc.created_at_ms, ptc.expires_at_ms,
                ptc.claimed_at_ms, ptc.finished_at_ms
         FROM printer_test_commands ptc
         INNER JOIN (
           SELECT printer_id, MAX(created_at_ms) as max_created
           FROM printer_test_commands
           GROUP BY printer_id
         ) latest ON ptc.printer_id = latest.printer_id AND ptc.created_at_ms = latest.max_created`,
        ),
      ]);

    const agentRows = (agentResults?.results ?? []) as unknown as AgentRow[];
    const printerRows = (printerResults?.results ??
      []) as unknown as PrinterRow[];
    const testCommandRows = (testCommandResults?.results ??
      []) as unknown as PrinterTestCommandRow[];

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
    const result = await this.db
      .prepare(
        `UPDATE agents
         SET is_active = 0, updated_at_ms = ?
         WHERE id = ? AND is_active = 1`,
      )
      .bind(input.nowMs, input.agentId)
      .run();

    if (result.meta.changes === 1) {
      await this.db
        .prepare(
          `INSERT INTO audit_logs (
             id, actor_type, actor_id, action, entity_type, entity_id, created_at_ms
           ) VALUES (?, 'ADMIN', ?, 'AGENT_REVOKED', 'AGENT', ?, ?)`,
        )
        .bind(crypto.randomUUID(), input.adminId, input.agentId, input.nowMs)
        .run();
      return true;
    }
    return false;
  }

  async togglePrinter(input: {
    printerId: string;
    enabled: boolean;
    adminId: string;
    nowMs: number;
  }): Promise<boolean> {
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
  } | null> {
    const row = await this.db
      .prepare(
        `SELECT id, agent_id, display_name, windows_printer_name, enabled, status
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
      }>();
    return row
      ? {
          id: row.id,
          agentId: row.agent_id,
          displayName: row.display_name,
          windowsPrinterName: row.windows_printer_name,
          enabled: row.enabled === 1,
          status: row.status,
        }
      : null;
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
        `SELECT c.id, c.printer_id, c.expires_at_ms, p.windows_printer_name
         FROM printer_test_commands c
         JOIN printers p ON c.printer_id = p.id
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

    await this.db
      .prepare(
        `INSERT INTO audit_logs (
           id, actor_type, actor_id, action, entity_type, entity_id, created_at_ms
         ) VALUES (?, 'AGENT', ?, ?, 'PRINTER_TEST_COMMAND', ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        input.agentId,
        `TEST_PRINT_${input.status}`,
        input.commandId,
        input.nowMs,
      )
      .run();

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
}
