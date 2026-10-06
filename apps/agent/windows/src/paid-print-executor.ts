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
    private readonly onStepFinished: () => void = () => undefined,
  ) {}

  private currentDeferralState: { stepId: string; count: number } | null = null;

  async handle(
    credentials: AgentCredentials,
    job: AgentPrintJob,
  ): Promise<"PREFLIGHT_DEFERRED" | void> {
    const timing = (event: string, atMs = Date.now()) =>
      this.log(
        `PRINT_TIMING step=${job.currentStep.stepId} event=${event} atMs=${atMs}`,
      );
    timing("preparation_start");

    if (this.currentDeferralState?.stepId !== job.currentStep.stepId) {
      this.currentDeferralState = null;
    }

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

    if (job.currentStep.status === "SUBMITTED") {
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

    if (job.currentStep.status === "BLOCKED") {
      const spoolerJobId =
        job.currentStep.spoolerJobId ?? matching?.spoolerJobId;
      if (spoolerJobId) {
        await this.observe(credentials, job, spoolerJobId);
        return;
      }
      // Step was blocked BEFORE submission (e.g. printer was temporarily offline).
      // Fall through to preflight and submission check below.
    } else if (job.currentStep.status !== "PENDING") {
      return;
    }

    if (typeof this.printer.getStatus === "function") {
      const printerStatus = await this.printer.getStatus(
        job.windowsPrinterName,
      );
      if (
        printerStatus &&
        (printerStatus.availability === "OFFLINE" ||
          printerStatus.availability === "BLOCKED")
      ) {
        const deferrals = (this.currentDeferralState?.count ?? 0) + 1;
        this.currentDeferralState = {
          stepId: job.currentStep.stepId,
          count: deferrals,
        };

        if (deferrals <= 2) {
          this.log(
            `Printer ${job.windowsPrinterName} is not online (${printerStatus.availability}: ${printerStatus.message ?? "Not ready"}). Waiting before print submission (Deferral ${deferrals}/2).`,
          );
          return "PREFLIGHT_DEFERRED";
        }

        this.log(
          `Printer ${job.windowsPrinterName} is persistently not online (${printerStatus.availability}: ${printerStatus.message ?? "Not ready"}). Reporting step BLOCKED before print submission.`,
        );

        this.currentDeferralState = null;
        if (job.currentStep.status !== "BLOCKED") {
          await this.client.reportPrintStep(
            credentials.serverUrl,
            credentials.agentId,
            credentials.agentSecret,
            job,
            {
              status: "BLOCKED",
              spoolerJobId: null,
              failureCode:
                printerStatus.availability === "OFFLINE"
                  ? "PRINTER_OFFLINE"
                  : "PRINTER_ERROR",
              failureDetail:
                printerStatus.message ??
                "Printer is offline or blocked before submission.",
            },
          );
        }
        return "PREFLIGHT_DEFERRED";
      }
    }

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
      timing("submission_start");
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
        documentTitle: `${isId ? "printgo-id" : "printgo-order"}-${job.identificationSheet?.pickupCode ?? job.jobCode}-${job.currentStep.stepId}`,
        copies: settings.copies,
        settings: { ...settings, printerName: job.windowsPrinterName },
      });
      if (submitted.timings) {
        timing("sumatra_start", submitted.timings.processStartedAtMs);
        if (submitted.timings.spoolCapturedAtMs !== null)
          timing("spool_captured", submitted.timings.spoolCapturedAtMs);
        timing("adapter_return", submitted.timings.acceptedAtMs);
      }
      await this.journal.save({
        orderId: job.orderId,
        attemptId: job.attemptId,
        stepId: job.currentStep.stepId,
        spoolerJobId: submitted.spoolJobId,
        updatedAtMs: Date.now(),
      });

      if (
        submitted.fastDespooled ||
        submitted.spoolJobId.startsWith("despooled-") ||
        submitted.spoolJobId.startsWith("unobserved-")
      ) {
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
      timing("spool_identity_persisted");
      await cleanup();
      cleanup = () => Promise.resolve();
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
        const errDetails =
          error instanceof Error ? error.stack || error.message : String(error);
        this.log(
          `Print submission result is unresolved (${errDetails}); human review required.`,
        );
        // Keep a positively correlated local spool identity if the server is unreachable.
        const savedSubmission = await this.journal.load();
        try {
          await this.client.reportPrintStep(
            credentials.serverUrl,
            credentials.agentId,
            credentials.agentSecret,
            job,
            {
              status: "UNCERTAIN",
              spoolerJobId: savedSubmission?.spoolerJobId ?? null,
              failureCode: "UNKNOWN",
              failureDetail:
                "Print submission failed with an unexpected error; outcome uncertain.",
            },
          );
          await this.journal.clear();
        } catch {
          this.log(
            "Uncertain print report is pending; recovery journal retained.",
          );
        }
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
    if (observed.state === "BLOCKED") {
      await this.client.reportPrintStep(
        credentials.serverUrl,
        credentials.agentId,
        credentials.agentSecret,
        job,
        {
          status: "BLOCKED",
          spoolerJobId,
          failureCode: observed.failureCode ?? "UNKNOWN",
          failureDetail:
            observed.message ?? "Printer is blocked and requires attention.",
        },
      );
      return;
    }
    if (observed.state === "FAILED") {
      await this.client.reportPrintStep(
        credentials.serverUrl,
        credentials.agentId,
        credentials.agentSecret,
        job,
        {
          status: "FAILED",
          spoolerJobId,
          failureCode: observed.failureCode ?? "PRINTER_ERROR",
          failureDetail: observed.message ?? "Spooler rejected the print job.",
        },
      );
      await this.journal.clear();
      return;
    }

    if (
      observed.state === "PRINTING" ||
      observed.state === "SPOOLING" ||
      observed.state === "QUEUED"
    ) {
      return;
    }

    if (observed.state === "COMPLETED_OR_REMOVED") {
      if (typeof this.printer.getStatus === "function") {
        const postStatus = await this.printer.getStatus(job.windowsPrinterName);
        if (
          postStatus &&
          (postStatus.availability === "BLOCKED" ||
            postStatus.availability === "OFFLINE")
        ) {
          await this.client.reportPrintStep(
            credentials.serverUrl,
            credentials.agentId,
            credentials.agentSecret,
            job,
            {
              status: "BLOCKED",
              spoolerJobId,
              failureCode:
                postStatus.availability === "OFFLINE"
                  ? "PRINTER_OFFLINE"
                  : "PRINTER_ERROR",
              failureDetail:
                postStatus.message ??
                "Printer encountered a hardware fault during print completion.",
            },
          );
          return;
        }
      }

      await this.client.reportPrintStep(
        credentials.serverUrl,
        credentials.agentId,
        credentials.agentSecret,
        job,
        {
          status: "UNCERTAIN",
          spoolerJobId,
          failureCode: null,
          failureDetail:
            observed.message ?? "Spool handoff complete; print outcome uncertain.",
        },
      );
      await this.journal.clear();
      this.log(
        `PRINT_TIMING step=${job.currentStep.stepId} event=step_acknowledged atMs=${Date.now()}`,
      );
      this.onStepFinished();
      return;
    }

    await this.client.reportPrintStep(
      credentials.serverUrl,
      credentials.agentId,
      credentials.agentSecret,
      job,
      {
        status: "UNCERTAIN",
        spoolerJobId,
        failureCode: observed.failureCode ?? "UNKNOWN",
        failureDetail: observed.message ?? "Spool outcome uncertain.",
      },
    );
    await this.journal.clear();
  }
}
