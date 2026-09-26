import { describe, expect, it } from "vitest";

import { EnvironmentPaymentReadiness } from "./readiness";

describe("EnvironmentPaymentReadiness", () => {
  it("permits only an explicit development bypass", async () => {
    await expect(
      new EnvironmentPaymentReadiness({
        APP_ENV: "development",
        PAYMENT_READINESS_DEV_BYPASS: "true",
      }).check(),
    ).resolves.toEqual({ ready: true, source: "DEVELOPMENT_BYPASS" });
  });

  it("fails closed by default", async () => {
    await expect(
      new EnvironmentPaymentReadiness({ APP_ENV: "development" }).check(),
    ).resolves.toEqual({
      ready: false,
      reason: "AGENT_READINESS_UNAVAILABLE",
    });
  });

  it("ignores the bypass in production", async () => {
    await expect(
      new EnvironmentPaymentReadiness({
        APP_ENV: "production",
        PAYMENT_READINESS_DEV_BYPASS: "true",
      }).check(),
    ).resolves.toEqual({
      ready: false,
      reason: "AGENT_READINESS_UNAVAILABLE",
    });
  });
});
