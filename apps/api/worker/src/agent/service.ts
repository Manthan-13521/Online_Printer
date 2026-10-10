import type {
  AdminAgentDetails,
  AdminCheckPrinterHealthResponseData,
  AdminRequestTestPrintRequest,
  AdminTestPrintDetails,
  AdminVerifyCapabilitiesResponseData,
  AgentHeartbeatData,
  AgentPairData,
  AgentReportCommandData,
} from "@printgo/api-contract";
import { hashSessionToken } from "@printgo/auth";
import {
  AGENT_HEARTBEAT_TIMEOUT_MS,
  AGENT_PAIR_CODE_LIFETIME_MS,
  TEST_PRINT_COMMAND_LIFETIME_MS,
  computePrinterFingerprint,
  type CapabilityVerificationRecord,
  type PrinterCapabilityFeatures,
} from "@printgo/domain";
import type {
  ValidatedAgentHeartbeatInput,
  ValidatedReportCommandInput,
  ValidatedUpdatePrinterInput,
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
  | "COMMAND_NOT_FOUND"
  | "FALLBACK_SELF_REFERENCE"
  | "FALLBACK_PRINTER_NOT_FOUND"
  | "FALLBACK_LOOP_DETECTED";

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

  async verifyTokenOnly(rawSecret: string): Promise<void> {
    const credentialHash = await hashSessionToken(rawSecret);
    const agent = await this.repository.findAgentByCredentialHash(
      credentialHash,
      this.now(),
    );
    if (!agent || !agent.isActive) {
      throw new AgentError("AGENT_UNAUTHORIZED");
    }
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
      nowMs - agent.lastHeartbeatAtMs >= 65_000
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
    const printJobs =
      agent.hasPrintWork === false
        ? []
        : ((await (this.printing?.claimOrRenewAll
            ? this.printing.claimOrRenewAll(agent.id)
            : this.printing
                ?.claimOrRenew(agent.id)
                .then((j) => (j ? [j] : [])))) ?? []);
    const printJob = printJobs[0] ?? null;

    return {
      acknowledged: true,
      serverTimeMs: nowMs,
      onlinePrintingEnabled: agent.onlinePrintingEnabled ?? true,
      ...(nextCommand ? { nextCommand } : {}),
      ...(printJob ? { printJob } : {}),
      ...(printJobs.length > 0 ? { printJobs } : {}),
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

  async updatePrinter(
    printerId: string,
    input: ValidatedUpdatePrinterInput,
    adminId: string,
  ): Promise<{
    id: string;
    enabled: boolean;
    displayName: string;
    priority: number;
    physicalDeviceId?: string | null;
    fallbackPrinterId: string | null;
    autoFallbackEnabled: boolean;
    verifiedCapabilities?: CapabilityVerificationRecord | null;
    enabledServices?: PrinterCapabilityFeatures | null;
  }> {
    try {
      return await this.repository.updatePrinterConfig({
        printerId,
        enabled: input.enabled,
        displayName: input.displayName,
        priority: input.priority,
        physicalDeviceId: input.physicalDeviceId,
        fallbackPrinterId: input.fallbackPrinterId,
        autoFallbackEnabled: input.autoFallbackEnabled,
        enabledServices: input.enabledServices,
        adminId,
        nowMs: this.now(),
      });
    } catch (err) {
      if (err instanceof Error) {
        if (err.message === "PRINTER_NOT_FOUND") {
          throw new AgentError("PRINTER_NOT_FOUND");
        }
        if (err.message === "CANNOT_ENABLE_VIRTUAL_PRINTER") {
          throw new AgentError("CANNOT_ENABLE_VIRTUAL_PRINTER");
        }
        if (err.message === "FALLBACK_SELF_REFERENCE") {
          throw new AgentError("FALLBACK_SELF_REFERENCE");
        }
        if (err.message === "FALLBACK_PRINTER_NOT_FOUND") {
          throw new AgentError("FALLBACK_PRINTER_NOT_FOUND");
        }
        if (err.message === "FALLBACK_LOOP_DETECTED") {
          throw new AgentError("FALLBACK_LOOP_DETECTED");
        }
      }
      throw err;
    }
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
    options?: AdminRequestTestPrintRequest,
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
      testType: options?.testType ?? "STANDARD",
      testSettings: options?.testSettings,
    });
  }

  async verifyPrinterCapabilities(
    printerId: string,
    adminId: string,
    input: {
      verified: PrinterCapabilityFeatures;
      enabled: PrinterCapabilityFeatures;
      notes?: string;
    },
  ): Promise<AdminVerifyCapabilitiesResponseData> {
    const printer = await this.repository.findPrinterById(printerId);
    if (!printer) {
      throw new AgentError("PRINTER_NOT_FOUND");
    }

    const nowMs = this.now();
    const hardwareFingerprint = computePrinterFingerprint(
      printer.windowsPrinterName,
      printer.portName,
      printer.driverName,
    );

    // Safety invariant: enabled services CANNOT enable a feature that is not verified
    const clampedEnabledServices: PrinterCapabilityFeatures = {
      bw: input.verified.bw ? input.enabled.bw : false,
      color: input.verified.color ? input.enabled.color : false,
      duplex: input.verified.duplex ? input.enabled.duplex : false,
      a4: input.verified.a4 ? input.enabled.a4 : false,
      a3: input.verified.a3 ? input.enabled.a3 : false,
    };

    const verificationRecord: CapabilityVerificationRecord = {
      verified: input.verified,
      enabled: clampedEnabledServices,
      verifiedByAdminId: adminId,
      verifiedAtMs: nowMs,
      fingerprint: hardwareFingerprint,
      requiresReview: false,
      notes: input.notes,
    };

    await this.repository.updatePrinterConfig({
      printerId,
      verifiedCapabilities: verificationRecord,
      enabledServices: clampedEnabledServices,
      adminId,
      nowMs,
    });

    return {
      printerId,
      verifiedCapabilities: verificationRecord,
      enabledServices: clampedEnabledServices,
      verifiedAt: new Date(nowMs).toISOString(),
    };
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

  async configureFallback(
    printerId: string,
    fallbackPrinterId: string | null,
    autoFallbackEnabled: boolean,
    adminId: string,
  ): Promise<{
    printerId: string;
    fallbackPrinterId: string | null;
    autoFallbackEnabled: boolean;
  }> {
    try {
      return await this.repository.configureFallback({
        printerId,
        fallbackPrinterId,
        autoFallbackEnabled,
        adminId,
        nowMs: this.now(),
      });
    } catch (caught: unknown) {
      if (caught instanceof Error) {
        const code = caught.message;
        if (
          code === "PRINTER_NOT_FOUND" ||
          code === "FALLBACK_SELF_REFERENCE" ||
          code === "FALLBACK_PRINTER_NOT_FOUND" ||
          code === "FALLBACK_LOOP_DETECTED"
        ) {
          throw new AgentError(code);
        }
      }
      throw caught;
    }
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
