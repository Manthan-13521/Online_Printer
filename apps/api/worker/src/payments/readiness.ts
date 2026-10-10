import {
  AGENT_HEARTBEAT_TIMEOUT_MS,
  checkOrderCapabilitiesSupport,
  resolveEffectiveFeatures,
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
        `SELECT id, agent_id, display_name, windows_printer_name, status, status_reason,
                is_paused, auto_fallback_enabled, fallback_printer_id, priority,
                capabilities_json, verified_capabilities_json, enabled_services_json
         FROM printers
         WHERE enabled = 1 AND is_production_eligible = 1 AND is_virtual = 0 AND agent_id IN (${placeholders})
         ORDER BY priority DESC, id ASC`,
      )
      .bind(...onlineAgentIds)
      .all<{
        id: string;
        agent_id: string;
        display_name: string;
        windows_printer_name: string;
        status: string;
        status_reason: string | null;
        is_paused?: number | null;
        auto_fallback_enabled?: number | null;
        fallback_printer_id?: string | null;
        priority?: number | null;
        capabilities_json: string | null;
        verified_capabilities_json: string | null;
        enabled_services_json: string | null;
      }>();

    if (printersResult.results.length === 0) {
      return {
        ready: false,
        reason: "NO_CONFIGURED_PRINTER",
        message: "No enabled printer is configured for the connected agent.",
      };
    }

    const defaultPrinterId = installation.default_production_printer_id;
    if (!defaultPrinterId && printersResult.results.length > 1) {
      return {
        ready: false,
        reason: "NO_CONFIGURED_PRINTER",
        message:
          "No default production printer is configured. Please select a default printer in Admin settings.",
      };
    }

    const onlinePrinters = printersResult.results.filter(
      (p) => p.status === "ONLINE" && p.is_paused !== 1,
    );

    if (onlinePrinters.length === 0) {
      return {
        ready: false,
        reason: "PRINTER_UNAVAILABLE",
        message:
          "The shop printer is currently offline, blocked, or in an error state.",
      };
    }

    // Default printer resolution
    const defaultPrinter = defaultPrinterId
      ? printersResult.results.find((p) => p.id === defaultPrinterId)
      : printersResult.results.length === 1
        ? printersResult.results[0]
        : undefined;

    if (defaultPrinterId && !defaultPrinter) {
      return {
        ready: false,
        reason: "PRINTER_UNAVAILABLE",
        message: "The configured default printer is disabled or unavailable.",
      };
    }

    // If default printer is offline or paused
    if (
      defaultPrinter &&
      (defaultPrinter.status !== "ONLINE" || defaultPrinter.is_paused === 1)
    ) {
      if (
        defaultPrinter.auto_fallback_enabled === 1 &&
        defaultPrinter.fallback_printer_id
      ) {
        const fallback = onlinePrinters.find(
          (p) =>
            p.id === defaultPrinter.fallback_printer_id &&
            p.fallback_printer_id !== defaultPrinter.id,
        );
        if (!fallback) {
          return {
            ready: false,
            reason: "PRINTER_UNAVAILABLE",
            message:
              "The configured fallback printer is offline, blocked, or in an error state.",
          };
        }

        const fallbackFeatures = resolveEffectiveFeatures(fallback);
        if (!fallbackFeatures) {
          return {
            ready: false,
            reason: "PRINTER_UNAVAILABLE",
            message:
              "The target printer configuration requires administrative review.",
          };
        }

        if (!requirements) {
          return { ready: true, source: "LIVE_AGENT", printerId: fallback.id };
        }

        const check = checkOrderCapabilitiesSupport(
          fallbackFeatures,
          requirements,
        );
        if (check.supported) {
          return { ready: true, source: "LIVE_AGENT", printerId: fallback.id };
        }

        if (check.missingFeature === "color") {
          return {
            ready: false,
            reason: "COLOR_MODE_UNSUPPORTED",
            message:
              "Colour printing is currently unavailable on connected printers.",
          };
        }
        if (check.missingFeature === "duplex") {
          return {
            ready: false,
            reason: "SIDES_MODE_UNSUPPORTED",
            message:
              "Double-sided printing is currently unavailable on connected printers.",
          };
        }
        return {
          ready: false,
          reason: "PAPER_SIZE_UNSUPPORTED",
          message: `${requirements.paperSize} paper printing is currently unavailable.`,
        };
      } else {
        return {
          ready: false,
          reason: "PRINTER_UNAVAILABLE",
          message:
            defaultPrinter.status === "ONLINE" && defaultPrinter.is_paused === 1
              ? "The configured default printer is currently paused."
              : "The configured default printer is offline, blocked, or in an error state.",
        };
      }
    }

    // Default printer is ONLINE
    const targetPrinter = defaultPrinter;
    if (targetPrinter) {
      const defaultFeatures = resolveEffectiveFeatures(targetPrinter);
      if (!defaultFeatures) {
        return {
          ready: false,
          reason: "PRINTER_UNAVAILABLE",
          message:
            "The target printer configuration requires administrative review.",
        };
      }

      if (!requirements) {
        return {
          ready: true,
          source: "LIVE_AGENT",
          printerId: targetPrinter.id,
        };
      }

      const defaultCheck = checkOrderCapabilitiesSupport(
        defaultFeatures,
        requirements,
      );
      if (defaultCheck.supported) {
        return {
          ready: true,
          source: "LIVE_AGENT",
          printerId: targetPrinter.id,
        };
      }

      // Default printer lacks the requested capability (e.g. default is mono, order is color)
      // Phase 3 Smart Routing: search other online printers for one that can fulfill it
      const capableSecondary = onlinePrinters.find((p) => {
        if (p.id === targetPrinter.id) return false;
        const feat = resolveEffectiveFeatures(p);
        if (!feat) return false;
        return checkOrderCapabilitiesSupport(feat, requirements).supported;
      });

      if (capableSecondary) {
        return {
          ready: true,
          source: "LIVE_AGENT",
          printerId: capableSecondary.id,
        };
      }

      if (defaultCheck.missingFeature === "color") {
        return {
          ready: false,
          reason: "COLOR_MODE_UNSUPPORTED",
          message:
            "Colour printing is currently unavailable on connected printers.",
        };
      }
      if (defaultCheck.missingFeature === "duplex") {
        return {
          ready: false,
          reason: "SIDES_MODE_UNSUPPORTED",
          message:
            "Double-sided printing is currently unavailable on connected printers.",
        };
      }
      const paperSizeStr = String(requirements.paperSize);
      if (paperSizeStr !== "A4" && paperSizeStr !== "A3") {
        return {
          ready: false,
          reason: "PAPER_SIZE_UNSUPPORTED",
          message: `${paperSizeStr} paper printing is currently unavailable.`,
        };
      }
      if (
        defaultCheck.missingFeature === "a3" ||
        requirements.paperSize === "A3"
      ) {
        return {
          ready: false,
          reason: "PAPER_SIZE_UNSUPPORTED",
          message: "A3 paper printing is currently unavailable.",
        };
      }
      if (defaultCheck.missingFeature === "a4") {
        return {
          ready: false,
          reason: "PAPER_SIZE_UNSUPPORTED",
          message: "A4 paper printing is currently unavailable.",
        };
      }
      return {
        ready: false,
        reason: "PRINTER_UNAVAILABLE",
        message:
          defaultCheck.reason ??
          "No connected printer can handle the requested print options.",
      };
    }

    return {
      ready: false,
      reason: "PRINTER_UNAVAILABLE",
      message:
        "The shop printer is currently offline, blocked, or in an error state.",
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
