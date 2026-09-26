import type { WorkerEnv } from "../env";

export type PaymentReadinessResult =
  | { ready: true; source: "DEVELOPMENT_BYPASS" }
  | { ready: false; reason: "AGENT_READINESS_UNAVAILABLE" };

export interface PaymentReadiness {
  check(): Promise<PaymentReadinessResult>;
}

/**
 * Phase 5 deliberately has no live Agent/printer readiness signal. Production
 * therefore fails closed until Phase 7 supplies the real implementation.
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
    });
  }
}
