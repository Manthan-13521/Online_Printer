import * as fs from "node:fs/promises";

import type { AgentPrintJob } from "@printgo/api-contract";

import type { AgentClient } from "./agent-client.js";
import { downloadAndValidateCustomerPdf } from "./printing/customer-pdf.js";
import {
  IDENTIFICATION_SHEET_PRINT_SETTINGS,
  createIdentificationSheetFile,
} from "./printing/identification-sheet.js";
import {
  InvalidPrintSettingError,
  PrinterNotFoundError,
  UnsupportedPrintSettingError,
  type PrinterAdapter,
} from "./printing/printer-adapter.js";
import { monitorSpoolJob } from "./printing/spool-monitor.js";
import type { AgentCredentials } from "./storage/credential-store.js";
import { ExecutionJournalStore } from "./storage/execution-journal.js";

export class PaidPrintExecutor {
  constructor(
    private readonly client: AgentClient,
    private readonly printer: PrinterAdapter,
    private readonly journal: ExecutionJournalStore = new ExecutionJournalStore(),
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  async handle(
    credentials: AgentCredentials,
    job: AgentPrintJob,
  ): Promise<void> {
    const saved = await this.journal.load();
    const matching =
      saved?.orderId === job.orderId &&
      saved.attemptId === job.attemptId &&
      saved.stepId === job.currentStep.stepId
        ? saved
        : null;
    if (saved && !matching) await this.journal.clear();

    if (job.currentStep.status === "SUBMISSION_STARTED") {
      if (!matching?.spoolerJobId) {
        await this.client.reportPrintStep(
          credentials.serverUrl,
          credentials.agentId,
          credentials.agentSecret,
          job,
          {
            status: "UNCERTAIN",
            failureCode: "UNKNOWN",
            failureDetail:
              "Agent restarted after submission began; no confirmed spooler job identity is available.",
          },
        );
        await this.journal.clear();
        return;
      }
      await this.client.submitPrintStep(
        credentials.serverUrl,
        credentials.agentId,
        credentials.agentSecret,
        job,
        matching.spoolerJobId,
      );
      await this.observe(credentials, job, matching.spoolerJobId);
      return;
    }

    if (
      job.currentStep.status === "SUBMITTED" ||
      job.currentStep.status === "BLOCKED"
    ) {
      const spoolerJobId =
        job.currentStep.spoolerJobId ?? matching?.spoolerJobId;
      if (!spoolerJobId) {
        await this.client.reportPrintStep(
          credentials.serverUrl,
          credentials.agentId,
          credentials.agentSecret,
          job,
          {
            status: "UNCERTAIN",
            failureCode: "UNKNOWN",
            failureDetail: "Submitted step has no spooler job identity.",
          },
        );
        await this.journal.clear();
        return;
      }
      await this.observe(credentials, job, spoolerJobId);
      return;
    }

    if (job.currentStep.status !== "PENDING") return;

    let localPath: string;
    let cleanup: () => Promise<void>;
    try {
      if (job.currentStep.type === "IDENTIFICATION_SHEET") {
        if (!job.identificationSheet)
          throw new Error("Identification-sheet data is missing.");
        localPath = await createIdentificationSheetFile(
          job.identificationSheet,
        );
        cleanup = () => fs.unlink(localPath).catch(() => undefined);
      } else {
        const local = await downloadAndValidateCustomerPdf({
          url: job.download.url,
          expectedSizeBytes: job.download.expectedSizeBytes,
          sourcePageCount: job.sourcePageCount,
          pageRange: job.settings.pageRange,
        });
        localPath = local.filePath;
        cleanup = () => local.cleanup();
      }
    } catch (error) {
      await this.reportKnownPreSubmissionFailure(credentials, job, error);
      return;
    }

    try {
      await this.client.startPrintStep(
        credentials.serverUrl,
        credentials.agentId,
        credentials.agentSecret,
        job,
      );
      await this.journal.save({
        orderId: job.orderId,
        attemptId: job.attemptId,
        stepId: job.currentStep.stepId,
        spoolerJobId: null,
        updatedAtMs: Date.now(),
      });
      const isId = job.currentStep.type === "IDENTIFICATION_SHEET";
      const settings = isId
        ? IDENTIFICATION_SHEET_PRINT_SETTINGS
        : {
            paperSize: job.settings.paperSize,
            colorMode:
              job.settings.colorMode === "COLOR"
                ? ("COLOUR" as const)
                : ("BLACK_AND_WHITE" as const),
            sides:
              job.settings.sides === "DOUBLE"
                ? ("TWO_SIDED_LONG" as const)
                : ("ONE_SIDED" as const),
            copies: job.settings.copies,
            ...(job.settings.pageRange.toUpperCase() === "ALL"
              ? {}
              : { pageRange: job.settings.pageRange }),
          };
      const submitted = await this.printer.submitPdfJob({
        printerId: job.windowsPrinterName,
        localPdfPath: localPath,
        documentTitle: `${isId ? "printgo-id" : "printgo-order"}-${job.jobCode}-${job.currentStep.stepId}`,
        copies: settings.copies,
        settings: { ...settings, printerName: job.windowsPrinterName },
      });
      await this.journal.save({
        orderId: job.orderId,
        attemptId: job.attemptId,
        stepId: job.currentStep.stepId,
        spoolerJobId: submitted.spoolJobId,
        updatedAtMs: Date.now(),
      });

      if (
        submitted.fastDespooled ||
        submitted.spoolJobId.startsWith("despooled-")
      ) {
        // Fast 1-page print: SumatraPDF exited 0, spooler dispatched directly into physical buffer
        await this.client.submitPrintStep(
          credentials.serverUrl,
          credentials.agentId,
          credentials.agentSecret,
          job,
          submitted.spoolJobId,
        );
        const printerStatus = await this.printer.getStatus(
          job.windowsPrinterName,
        );
        if (
          printerStatus.availability === "ONLINE" ||
          printerStatus.availability === "AVAILABLE"
        ) {
          await this.client.reportPrintStep(
            credentials.serverUrl,
            credentials.agentId,
            credentials.agentSecret,
            job,
            {
              status: "SUCCEEDED",
              spoolerJobId: submitted.spoolJobId,
              failureCode: null,
              failureDetail:
                "Fast despool completed successfully to physical printer buffer.",
            },
          );
          await this.journal.clear();
          return;
        } else if (printerStatus.availability === "BLOCKED") {
          await this.client.reportPrintStep(
            credentials.serverUrl,
            credentials.agentId,
            credentials.agentSecret,
            job,
            {
              status: "BLOCKED",
              spoolerJobId: submitted.spoolJobId,
              failureCode: "PRINTER_ERROR",
              failureDetail:
                printerStatus.message ?? "Printer blocked during print.",
            },
          );
          return;
        }
      }

      if (submitted.spoolJobId.startsWith("unobserved-")) {
        await this.client.reportPrintStep(
          credentials.serverUrl,
          credentials.agentId,
          credentials.agentSecret,
          job,
          {
            status: "UNCERTAIN",
            spoolerJobId: submitted.spoolJobId,
            failureCode: "UNKNOWN",
            failureDetail:
              "Windows accepted the print command but the spooler job could not be correlated safely.",
          },
        );
        await this.journal.clear();
        return;
      }
      await this.client.submitPrintStep(
        credentials.serverUrl,
        credentials.agentId,
        credentials.agentSecret,
        job,
        submitted.spoolJobId,
      );
      await this.observe(credentials, job, submitted.spoolJobId);
    } catch (error) {
      if (
        error instanceof UnsupportedPrintSettingError ||
        error instanceof InvalidPrintSettingError ||
        error instanceof PrinterNotFoundError
      ) {
        await this.client
          .reportPrintStep(
            credentials.serverUrl,
            credentials.agentId,
            credentials.agentSecret,
            job,
            {
              status: "FAILED",
              failureCode: "PRINTER_ERROR",
              failureDetail: error.message,
            },
          )
          .catch(() => undefined);
        await this.journal.clear();
      } else {
        const errorMsg = error instanceof Error ? error.message : String(error);
        this.log(
          `Print submission result is unresolved for ${job.jobCode}: ${errorMsg}`,
        );
        await this.client
          .reportPrintStep(
            credentials.serverUrl,
            credentials.agentId,
            credentials.agentSecret,
            job,
            {
              status: "UNCERTAIN",
              spoolerJobId: null,
              failureCode: "UNKNOWN",
              failureDetail: `Print submission failed with unexpected error: ${errorMsg}`,
            },
          )
          .catch(() => undefined);
        await this.journal.clear();
      }
    } finally {
      await cleanup?.();
    }
  }

  private async reportKnownPreSubmissionFailure(
    credentials: AgentCredentials,
    job: AgentPrintJob,
    error: unknown,
  ) {
    try {
      await this.client.startPrintStep(
        credentials.serverUrl,
        credentials.agentId,
        credentials.agentSecret,
        job,
      );
      await this.client.reportPrintStep(
        credentials.serverUrl,
        credentials.agentId,
        credentials.agentSecret,
        job,
        {
          status: "FAILED",
          failureCode: "PRINTER_ERROR",
          failureDetail:
            error instanceof Error
              ? error.message
              : "Local PDF validation failed.",
        },
      );
    } catch (reportError) {
      this.log(
        `Could not report pre-submission failure for ${job.jobCode}: ${reportError instanceof Error ? reportError.message : String(reportError)}`,
      );
    }
  }

  private async observe(
    credentials: AgentCredentials,
    job: AgentPrintJob,
    spoolerJobId: string,
  ) {
    const observed = await monitorSpoolJob(
      this.printer,
      job.windowsPrinterName,
      spoolerJobId,
    );
    if (
      observed.state === "PRINTING" ||
      observed.state === "QUEUED" ||
      observed.state === "SPOOLING"
    )
      return;
    const status =
      observed.state === "BLOCKED"
        ? "BLOCKED"
        : observed.state === "FAILED"
          ? "FAILED"
          : observed.state === "COMPLETED_OR_REMOVED"
            ? "SUCCEEDED"
            : "UNCERTAIN";
    await this.client.reportPrintStep(
      credentials.serverUrl,
      credentials.agentId,
      credentials.agentSecret,
      job,
      {
        status,
        spoolerJobId,
        failureCode:
          observed.failureCode ?? (status === "UNCERTAIN" ? "UNKNOWN" : null),
        failureDetail: observed.message ?? null,
      },
    );
    if (status !== "BLOCKED") await this.journal.clear();
  }
}
