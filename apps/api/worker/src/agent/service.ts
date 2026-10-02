import type {
  AdminAgentDetails,
  AdminCheckPrinterHealthResponseData,
  AdminTestPrintDetails,
  AgentHeartbeatData,
  AgentPairData,
  AgentReportCommandData,
} from "@printgo/api-contract";
import { hashSessionToken } from "@printgo/auth";
import {
  AGENT_HEARTBEAT_TIMEOUT_MS,
  AGENT_PAIR_CODE_LIFETIME_MS,
  TEST_PRINT_COMMAND_LIFETIME_MS,
} from "@printgo/domain";
import type {
  ValidatedAgentHeartbeatInput,
  ValidatedReportCommandInput,
} from "@printgo/validation";

import {
  generateAgentSecret,
  generatePairCode,
  normalizePairCode,
} from "./pair-code";
import type { AgentRepository } from "./repository";
import type { PrintingService } from "../printing/service";

export type AgentErrorCode =
  | "PAIR_CODE_INVALID"
  | "PAIR_CODE_EXPIRED"
  | "PAIR_CODE_ALREADY_USED"
  | "AGENT_UNAUTHORIZED"
  | "AGENT_NOT_FOUND"
  | "PRINTER_NOT_FOUND"
  | "PRINTER_DISABLED"
  | "PRINTER_NOT_ELIGIBLE"
  | "CANNOT_ENABLE_VIRTUAL_PRINTER"
  | "AGENT_OFFLINE"
  | "COMMAND_NOT_FOUND";

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
    private readonly printing?: PrintingService,
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
    reportPrinters = true,
  ): Promise<AgentHeartbeatData> {
    const credentialHash = await hashSessionToken(rawSecret);
    const nowMs = this.now();
    const agent = await this.repository.findAgentByCredentialHash(
      credentialHash,
      nowMs,
    );

    if (!agent || !agent.isActive) {
      throw new AgentError("AGENT_UNAUTHORIZED");
    }
    if (
      reportPrinters ||
      agent.lastHeartbeatAtMs === null ||
      nowMs - agent.lastHeartbeatAtMs >= 60_000
    ) {
      await this.repository.updateHeartbeat({
        agentId: agent.id,
        nowMs,
        ...(reportPrinters ? { printers: input.printers } : {}),
      });
    }

    const nextCommand =
      agent.hasPendingCommand === false
        ? null
        : await this.repository.claimPendingTestPrintCommand(agent.id, nowMs);
    const printJob =
      agent.hasPrintWork === false
        ? null
        : await this.printing?.claimOrRenew(agent.id);

    return {
      acknowledged: true,
      serverTimeMs: nowMs,
      onlinePrintingEnabled: agent.onlinePrintingEnabled ?? true,
      ...(nextCommand ? { nextCommand } : {}),
      ...(printJob ? { printJob } : {}),
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
    try {
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
    } catch (err) {
      if (
        err instanceof Error &&
        err.message === "CANNOT_ENABLE_VIRTUAL_PRINTER"
      ) {
        throw new AgentError("CANNOT_ENABLE_VIRTUAL_PRINTER");
      }
      throw err;
    }
  }

  async getDefaultProductionPrinterId(): Promise<string | null> {
    return this.repository.getDefaultProductionPrinterId();
  }

  async setDefaultProductionPrinter(
    printerId: string,
    adminId: string,
  ): Promise<{ printerId: string; windowsPrinterName: string }> {
    try {
      return await this.repository.setDefaultProductionPrinter({
        printerId,
        adminId,
        nowMs: this.now(),
      });
    } catch (err) {
      if (err instanceof Error) {
        if (err.message === "PRINTER_NOT_FOUND") {
          throw new AgentError("PRINTER_NOT_FOUND");
        }
        if (err.message === "PRINTER_NOT_ELIGIBLE") {
          throw new AgentError("PRINTER_NOT_ELIGIBLE");
        }
      }
      throw err;
    }
  }

  async requestTestPrint(
    printerId: string,
    adminId: string,
  ): Promise<AdminTestPrintDetails> {
    const printer = await this.repository.findPrinterById(printerId);
    if (!printer) {
      throw new AgentError("PRINTER_NOT_FOUND");
    }
    if (!printer.enabled) {
      throw new AgentError("PRINTER_DISABLED");
    }

    const agent = await this.repository.findAgentById(printer.agentId);
    if (!agent || !agent.isActive) {
      throw new AgentError("AGENT_NOT_FOUND");
    }

    const nowMs = this.now();
    if (
      !agent.lastHeartbeatAtMs ||
      nowMs - agent.lastHeartbeatAtMs > AGENT_HEARTBEAT_TIMEOUT_MS
    ) {
      throw new AgentError("AGENT_OFFLINE");
    }

    const existing = await this.repository.getLatestTestPrintCommand(
      printerId,
      nowMs,
    );
    if (
      existing &&
      (existing.status === "PENDING" ||
        existing.status === "CLAIMED" ||
        existing.status === "SUBMITTED")
    ) {
      return existing;
    }

    const commandId = crypto.randomUUID();
    const expiresAtMs = nowMs + TEST_PRINT_COMMAND_LIFETIME_MS;

    return this.repository.createTestPrintCommand({
      id: commandId,
      printerId,
      agentId: printer.agentId,
      adminId,
      expiresAtMs,
      nowMs,
    });
  }

  async reportCommand(
    rawSecret: string,
    commandId: string,
    input: ValidatedReportCommandInput,
  ): Promise<AgentReportCommandData> {
    const credentialHash = await hashSessionToken(rawSecret);
    const agent =
      await this.repository.findAgentByCredentialHash(credentialHash);

    if (!agent || !agent.isActive) {
      throw new AgentError("AGENT_UNAUTHORIZED");
    }

    const nowMs = this.now();
    const reported = await this.repository.reportTestPrintCommand({
      commandId,
      agentId: agent.id,
      status: input.status,
      spoolerJobId: input.spoolerJobId ?? null,
      failureCode: input.failureCode ?? null,
      failureDetail: input.failureDetail ?? null,
      nowMs,
    });

    if (!reported) {
      throw new AgentError("COMMAND_NOT_FOUND");
    }

    return {
      acknowledged: true,
      commandId,
      status: input.status,
    };
  }

  async getLatestTestPrint(
    printerId: string,
  ): Promise<AdminTestPrintDetails | null> {
    const printer = await this.repository.findPrinterById(printerId);
    if (!printer) {
      throw new AgentError("PRINTER_NOT_FOUND");
    }
    return this.repository.getLatestTestPrintCommand(printerId, this.now());
  }

  async checkPrinterHealth(
    printerId: string,
    adminId: string,
  ): Promise<AdminCheckPrinterHealthResponseData> {
    try {
      return await this.repository.checkPrinterHealth(
        printerId,
        adminId,
        this.now(),
      );
    } catch (caught: unknown) {
      if (caught instanceof Error && caught.message === "PRINTER_NOT_FOUND") {
        throw new AgentError("PRINTER_NOT_FOUND");
      }
      throw caught;
    }
  }
}
