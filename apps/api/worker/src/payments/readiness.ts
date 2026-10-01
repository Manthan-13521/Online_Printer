import {
  AGENT_HEARTBEAT_TIMEOUT_MS,
  type ColorMode,
  type PaperSize,
  type SidesMode,
} from "@printgo/domain";

import type { WorkerEnv } from "../env";

export type PaymentReadinessFailureReason =
  | "ONLINE_PRINTING_DISABLED"
  | "AGENT_OFFLINE"
  | "NO_CONFIGURED_PRINTER"
  | "PRINTER_UNAVAILABLE"
  | "PAPER_SIZE_UNSUPPORTED"
  | "COLOR_MODE_UNSUPPORTED"
  | "SIDES_MODE_UNSUPPORTED"
  | "AGENT_READINESS_UNAVAILABLE";

export type PaymentReadinessResult =
  | {
      ready: true;
      source: "LIVE_AGENT" | "DEVELOPMENT_BYPASS";
      printerId?: string;
    }
  | {
      ready: false;
      reason: PaymentReadinessFailureReason;
      message: string;
    };

export interface PrintRequirements {
  paperSize: PaperSize;
  colorMode: ColorMode;
  sides: SidesMode;
}

export interface PaymentReadiness {
  check(requirements?: PrintRequirements): Promise<PaymentReadinessResult>;
}

export class D1PaymentReadiness implements PaymentReadiness {
  constructor(
    private readonly db: D1Database,
    private readonly env: Pick<
      WorkerEnv,
      "APP_ENV" | "PAYMENT_READINESS_DEV_BYPASS"
    >,
    private readonly now: () => number = Date.now,
  ) {}

  async check(
    requirements?: PrintRequirements,
  ): Promise<PaymentReadinessResult> {
    if (
      this.env.APP_ENV === "development" &&
      this.env.PAYMENT_READINESS_DEV_BYPASS === "true"
    ) {
      return { ready: true, source: "DEVELOPMENT_BYPASS" };
    }

    const installation = await this.db
      .prepare(
        `SELECT online_printing_enabled, default_production_printer_id FROM installation WHERE id = 1`,
      )
      .first<{
        online_printing_enabled: number;
        default_production_printer_id?: string | null;
      }>();

    if (!installation || installation.online_printing_enabled !== 1) {
      return {
        ready: false,
        reason: "ONLINE_PRINTING_DISABLED",
        message: "Online printing is currently disabled by the shop.",
      };
    }

    const nowMs = this.now();
    const minHeartbeatMs = nowMs - AGENT_HEARTBEAT_TIMEOUT_MS;

    const agents = await this.db
      .prepare(
        `SELECT id FROM agents
         WHERE is_active = 1
           AND last_heartbeat_at_ms IS NOT NULL
           AND last_heartbeat_at_ms >= ?`,
      )
      .bind(minHeartbeatMs)
      .all<{ id: string }>();

    const onlineAgentIds = agents.results.map((a) => a.id);

    if (onlineAgentIds.length === 0) {
      if (
        this.env.APP_ENV === "development" &&
        this.env.PAYMENT_READINESS_DEV_BYPASS === "true"
      ) {
        return { ready: true, source: "DEVELOPMENT_BYPASS" };
      }
      return {
        ready: false,
        reason: "AGENT_OFFLINE",
        message: "The shop printer agent is currently offline.",
      };
    }

    const placeholders = onlineAgentIds.map(() => "?").join(",");
    const printersResult = await this.db
      .prepare(
        `SELECT id, agent_id, display_name, windows_printer_name, status, status_reason, capabilities_json
         FROM printers
         WHERE enabled = 1 AND is_production_eligible = 1 AND is_virtual = 0 AND agent_id IN (${placeholders})`,
      )
      .bind(...onlineAgentIds)
      .all<{
        id: string;
        agent_id: string;
        display_name: string;
        windows_printer_name: string;
        status: string;
        status_reason: string | null;
        capabilities_json: string | null;
      }>();

    if (printersResult.results.length === 0) {
      return {
        ready: false,
        reason: "NO_CONFIGURED_PRINTER",
        message: "No enabled printer is configured for the connected agent.",
      };
    }

    const availablePrinters = printersResult.results.filter(
      (p) => p.status === "ONLINE",
    );

    if (availablePrinters.length === 0) {
      return {
        ready: false,
        reason: "PRINTER_UNAVAILABLE",
        message:
          "The shop printer is currently offline, blocked, or in an error state.",
      };
    }

    const defaultPrinterId = installation.default_production_printer_id;
    let targetPrinters = availablePrinters;
    if (defaultPrinterId) {
      const defaultMatch = availablePrinters.filter(
        (p) => p.id === defaultPrinterId,
      );
      if (defaultMatch.length > 0) {
        targetPrinters = defaultMatch;
      } else {
        return {
          ready: false,
          reason: "PRINTER_UNAVAILABLE",
          message:
            "The configured default printer is offline, blocked, or in an error state.",
        };
      }
    }

    if (!requirements) {
      const first = targetPrinters[0];
      return {
        ready: true,
        source: "LIVE_AGENT",
        ...(first ? { printerId: first.id } : {}),
      };
    }

    interface PrinterCapsParsed {
      colour?: boolean | "UNKNOWN";
      duplex?: boolean | "UNKNOWN";
      paperSizes?: string[];
    }

    let paperSizeMatch = false;
    let colorModeMatch = false;
    let sidesMatch = false;

    for (const printer of targetPrinters) {
      let caps: PrinterCapsParsed | null = null;

      if (printer.capabilities_json) {
        try {
          caps = JSON.parse(printer.capabilities_json) as PrinterCapsParsed;
        } catch {
          caps = null;
        }
      }

      const supportsPaperSize =
        !caps?.paperSizes ||
        caps.paperSizes.length === 0 ||
        caps.paperSizes.includes(requirements.paperSize);
      if (supportsPaperSize) paperSizeMatch = true;

      const supportsColor =
        requirements.colorMode === "BW" || caps?.colour === true;
      if (supportsColor) colorModeMatch = true;

      const supportsSides =
        requirements.sides === "SINGLE" || caps?.duplex === true;
      if (supportsSides) sidesMatch = true;

      if (supportsPaperSize && supportsColor && supportsSides) {
        return {
          ready: true,
          source: "LIVE_AGENT",
          printerId: printer.id,
        };
      }
    }

    if (!colorModeMatch) {
      return {
        ready: false,
        reason: "COLOR_MODE_UNSUPPORTED",
        message:
          "Colour printing is currently unavailable on connected printers.",
      };
    }

    if (!paperSizeMatch) {
      return {
        ready: false,
        reason: "PAPER_SIZE_UNSUPPORTED",
        message: `${requirements.paperSize} paper printing is currently unavailable.`,
      };
    }

    if (!sidesMatch) {
      return {
        ready: false,
        reason: "SIDES_MODE_UNSUPPORTED",
        message:
          "Double-sided printing is currently unavailable on connected printers.",
      };
    }

    return {
      ready: false,
      reason: "PRINTER_UNAVAILABLE",
      message: "No connected printer can handle the requested print options.",
    };
  }
}

/**
 * Retained for Phase 5 backward compatibility and unit tests.
 */
export class EnvironmentPaymentReadiness implements PaymentReadiness {
  constructor(
    private readonly env: Pick<
      WorkerEnv,
      "APP_ENV" | "PAYMENT_READINESS_DEV_BYPASS"
    >,
  ) {}

  check(): Promise<PaymentReadinessResult> {
    if (
      this.env.APP_ENV === "development" &&
      this.env.PAYMENT_READINESS_DEV_BYPASS === "true"
    ) {
      return Promise.resolve({
        ready: true,
        source: "DEVELOPMENT_BYPASS",
      });
    }
    return Promise.resolve({
      ready: false,
      reason: "AGENT_READINESS_UNAVAILABLE",
      message: "Payment readiness is not available.",
    });
  }
}
