import type {
  AdminAgentDetails,
  AgentHeartbeatData,
  AgentPairData,
} from "@printgo/api-contract";
import { hashSessionToken } from "@printgo/auth";
import { AGENT_PAIR_CODE_LIFETIME_MS } from "@printgo/domain";
import type { ValidatedAgentHeartbeatInput } from "@printgo/validation";

import {
  generateAgentSecret,
  generatePairCode,
  normalizePairCode,
} from "./pair-code";
import type { AgentRepository } from "./repository";

export type AgentErrorCode =
  | "PAIR_CODE_INVALID"
  | "PAIR_CODE_EXPIRED"
  | "PAIR_CODE_ALREADY_USED"
  | "AGENT_UNAUTHORIZED"
  | "AGENT_NOT_FOUND"
  | "PRINTER_NOT_FOUND";

export class AgentError extends Error {
  constructor(readonly code: AgentErrorCode) {
    super(code);
    this.name = "AgentError";
  }
}

export interface AgentPairInput {
  pairCode: string;
  displayName: string;
}

export class AgentService {
  constructor(
    private readonly repository: AgentRepository,
    private readonly now: () => number = Date.now,
  ) {}

  async createPairCode(): Promise<{ pairCode: string; expiresAt: string }> {
    const pairCode = generatePairCode();
    const normalized = normalizePairCode(pairCode);
    const codeHash = await hashSessionToken(normalized);
    const nowMs = this.now();
    const expiresAtMs = nowMs + AGENT_PAIR_CODE_LIFETIME_MS;

    await this.repository.createPairCode({
      id: crypto.randomUUID(),
      codeHash,
      expiresAtMs,
      nowMs,
    });

    return {
      pairCode,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  async pair(input: AgentPairInput): Promise<AgentPairData> {
    const normalized = normalizePairCode(input.pairCode);
    const codeHash = await hashSessionToken(normalized);
    const storedCode = await this.repository.findPairCode(codeHash);

    if (!storedCode) {
      throw new AgentError("PAIR_CODE_INVALID");
    }

    const nowMs = this.now();
    if (storedCode.expiresAtMs <= nowMs) {
      throw new AgentError("PAIR_CODE_EXPIRED");
    }

    if (storedCode.usedAtMs !== null) {
      throw new AgentError("PAIR_CODE_ALREADY_USED");
    }

    const agentId = crypto.randomUUID();
    const agentSecret = generateAgentSecret();
    const credentialHash = await hashSessionToken(agentSecret);

    const consumed = await this.repository.consumePairCodeAndCreateAgent({
      pairCodeId: storedCode.id,
      agentId,
      displayName: input.displayName.trim() || "Shop Printer Agent",
      credentialHash,
      nowMs,
    });

    if (!consumed) {
      throw new AgentError("PAIR_CODE_ALREADY_USED");
    }

    return {
      agentId,
      agentSecret,
      displayName: input.displayName.trim() || "Shop Printer Agent",
    };
  }

  async heartbeat(
    rawSecret: string,
    input: ValidatedAgentHeartbeatInput,
  ): Promise<AgentHeartbeatData> {
    const credentialHash = await hashSessionToken(rawSecret);
    const agent =
      await this.repository.findAgentByCredentialHash(credentialHash);

    if (!agent || !agent.isActive) {
      throw new AgentError("AGENT_UNAUTHORIZED");
    }

    const nowMs = this.now();
    await this.repository.updateHeartbeat({
      agentId: agent.id,
      nowMs,
      printers: input.printers,
    });

    return {
      acknowledged: true,
      serverTimeMs: nowMs,
    };
  }

  async listAgentsWithPrinters(): Promise<AdminAgentDetails[]> {
    return this.repository.listAgentsWithPrinters(this.now());
  }

  async revokeAgent(agentId: string, adminId: string): Promise<boolean> {
    const revoked = await this.repository.revokeAgent({
      agentId,
      adminId,
      nowMs: this.now(),
    });
    if (!revoked) {
      throw new AgentError("AGENT_NOT_FOUND");
    }
    return true;
  }

  async togglePrinter(
    printerId: string,
    enabled: boolean,
    adminId: string,
  ): Promise<boolean> {
    const toggled = await this.repository.togglePrinter({
      printerId,
      enabled,
      adminId,
      nowMs: this.now(),
    });
    if (!toggled) {
      throw new AgentError("PRINTER_NOT_FOUND");
    }
    return true;
  }
}
