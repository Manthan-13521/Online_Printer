import type {
  AgentPrintJob,
  AgentReportPrintStepRequest,
  PrintPlanStepStatus,
} from "@printgo/api-contract";
import { hashSessionToken } from "@printgo/auth";

import type { DownloadSigner } from "../storage/r2-upload-signer";
import type { PrintingRepository } from "./repository";

export type PrintingErrorCode =
  "AGENT_UNAUTHORIZED" | "PRINT_STEP_NOT_FOUND" | "PRINT_STEP_CONFLICT";

export class PrintingError extends Error {
  constructor(readonly code: PrintingErrorCode) {
    super(code);
    this.name = "PrintingError";
  }
}

export class PrintingService {
  constructor(
    private readonly repository: PrintingRepository,
    private readonly downloadSigner: DownloadSigner,
    private readonly now: () => number = Date.now,
  ) {}

  async claimOrRenew(agentId: string): Promise<AgentPrintJob | null> {
    const record = await this.repository.claimOrRenew(agentId, this.now());
    if (!record) return null;
    const authorization = await this.downloadSigner.createDownloadAuthorization(
      record.objectKey,
    );
    return {
      type: "PAID_PRINT_JOB",
      orderId: record.orderId,
      attemptId: record.attemptId,
      claimId: record.claimId,
      leaseExpiresAtMs: record.leaseExpiresAtMs,
      jobCode: record.jobCode,
      printerId: record.printerId,
      windowsPrinterName: record.windowsPrinterName,
      download: {
        url: authorization.url,
        expiresAtMs: authorization.expiresAtMs,
        expectedSizeBytes: record.expectedSizeBytes,
      },
      sourcePageCount: record.sourcePageCount,
      settings: {
        pageRange: record.pageRange,
        copies: record.copies,
        paperSize: record.paperSize,
        colorMode: record.colorMode,
        sides: record.sides,
      },
      identificationSheet: record.identificationSheet,
      currentStep: record.currentStep,
    };
  }

  private async agentId(rawSecret: string): Promise<string> {
    const credentialHash = await hashSessionToken(rawSecret);
    const agentId = await this.repository.authenticateAgent(credentialHash);
    if (!agentId) throw new PrintingError("AGENT_UNAUTHORIZED");
    return agentId;
  }

  async startStep(
    rawSecret: string,
    orderId: string,
    stepId: string,
    claimId: string,
  ) {
    const agentId = await this.agentId(rawSecret);
    const row = await this.repository.startStep({
      agentId,
      orderId,
      stepId,
      claimId,
      nowMs: this.now(),
    });
    if (!row) throw new PrintingError("PRINT_STEP_NOT_FOUND");
    if (row.step_status !== "SUBMISSION_STARTED") {
      throw new PrintingError("PRINT_STEP_CONFLICT");
    }
    return this.response(row);
  }

  async recordSubmission(
    rawSecret: string,
    orderId: string,
    stepId: string,
    claimId: string,
    spoolerJobId: string,
  ) {
    const agentId = await this.agentId(rawSecret);
    const row = await this.repository.recordSubmission({
      agentId,
      orderId,
      stepId,
      claimId,
      spoolerJobId,
      nowMs: this.now(),
    });
    if (!row) throw new PrintingError("PRINT_STEP_CONFLICT");
    if (row.step_status !== "SUBMITTED" && row.step_status !== "BLOCKED") {
      throw new PrintingError("PRINT_STEP_CONFLICT");
    }
    return this.response(row);
  }

  async recordResult(
    rawSecret: string,
    orderId: string,
    stepId: string,
    input: AgentReportPrintStepRequest,
  ) {
    const agentId = await this.agentId(rawSecret);
    const row = await this.repository.recordResult({
      agentId,
      orderId,
      stepId,
      claimId: input.claimId,
      status: input.status,
      spoolerJobId: input.spoolerJobId ?? null,
      failureCode: input.failureCode ?? null,
      failureDetail: input.failureDetail ?? null,
      nowMs: this.now(),
    });
    if (!row) throw new PrintingError("PRINT_STEP_CONFLICT");
    return this.response(row);
  }

  private response(row: {
    order_id: string;
    attempt_id: string;
    step_id: string;
    step_status: PrintPlanStepStatus;
    order_status: string;
  }) {
    return {
      acknowledged: true as const,
      orderId: row.order_id,
      attemptId: row.attempt_id,
      stepId: row.step_id,
      status: row.step_status,
      orderStatus: row.order_status,
    };
  }
}
