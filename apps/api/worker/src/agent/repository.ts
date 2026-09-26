import type {
  AdminAgentDetails,
  AdminPrinterDetails,
  PrinterCapabilitySummary,
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
    const updateResult = await this.db
      .prepare(
        `UPDATE agent_pair_codes
         SET used_at_ms = ?, paired_agent_id = ?
         WHERE id = ? AND used_at_ms IS NULL AND expires_at_ms > ?`,
      )
      .bind(input.nowMs, input.agentId, input.pairCodeId, input.nowMs)
      .run();

    if (updateResult.meta.changes !== 1) {
      return false;
    }

    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO agents (
             id, display_name, credential_hash, is_active, paired_at_ms,
             last_heartbeat_at_ms, created_at_ms, updated_at_ms
           ) VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
        )
        .bind(
          input.agentId,
          input.displayName,
          input.credentialHash,
          input.nowMs,
          input.nowMs,
          input.nowMs,
          input.nowMs,
        ),
      this.db
        .prepare(
          `INSERT INTO audit_logs (
             id, actor_type, actor_id, action, entity_type, entity_id, created_at_ms
           ) VALUES (?, 'AGENT', ?, 'AGENT_PAIRED', 'AGENT', ?, ?)`,
        )
        .bind(crypto.randomUUID(), input.agentId, input.agentId, input.nowMs),
    ]);

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
        const changed =
          existing.status !== p.status ||
          existing.status_reason !== p.statusReason ||
          existing.capabilities_json !== capsJson ||
          existing.display_name !== p.displayName;

        if (changed) {
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

    await this.db.batch(statements);
  }

  async listAgentsWithPrinters(nowMs: number): Promise<AdminAgentDetails[]> {
    const [agentResults, printerResults] = await this.db.batch([
      this.db.prepare(
        `SELECT id, display_name, is_active, paired_at_ms, last_heartbeat_at_ms
         FROM agents ORDER BY created_at_ms ASC`,
      ),
      this.db.prepare(
        `SELECT id, agent_id, display_name, windows_printer_name, enabled,
                status, status_reason, capabilities_json, last_status_at_ms
         FROM printers ORDER BY windows_printer_name ASC`,
      ),
    ]);

    const agentRows = (agentResults?.results ?? []) as unknown as AgentRow[];
    const printerRows = (printerResults?.results ??
      []) as unknown as PrinterRow[];

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
}
