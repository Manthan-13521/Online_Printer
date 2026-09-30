import type { PaperSize } from "@printgo/domain";
import { describe, expect, it } from "vitest";

import { D1PaymentReadiness, EnvironmentPaymentReadiness } from "./readiness";

interface FakeStatement {
  sql: string;
  bindings: unknown[];
  bind(...values: unknown[]): FakeStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
}

function createMockDb(handlers: {
  installation?: () => Promise<Record<string, unknown> | null>;
  agents?: () => Promise<Array<Record<string, unknown>>>;
  printers?: () => Promise<Array<Record<string, unknown>>>;
}) {
  return {
    prepare(sql: string) {
      const statement: FakeStatement = {
        sql,
        bindings: [],
        bind(...values: unknown[]) {
          this.bindings = values;
          return this;
        },
        async first<T>() {
          if (sql.includes("FROM installation")) {
            return (
              handlers.installation ? await handlers.installation() : null
            ) as T | null;
          }
          return null;
        },
        async all<T>() {
          if (sql.includes("FROM agents")) {
            const results = handlers.agents ? await handlers.agents() : [];
            return { results: results as T[] };
          }
          if (sql.includes("FROM printers")) {
            const results = handlers.printers ? await handlers.printers() : [];
            return { results: results as T[] };
          }
          return { results: [] };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

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
      message: "Payment readiness is not available.",
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
      message: "Payment readiness is not available.",
    });
  });
});

describe("D1PaymentReadiness", () => {
  it("permits explicit development bypass in development env", async () => {
    const mockDb = createMockDb({});
    const readiness = new D1PaymentReadiness(mockDb, {
      APP_ENV: "development",
      PAYMENT_READINESS_DEV_BYPASS: "true",
    });

    await expect(readiness.check()).resolves.toEqual({
      ready: true,
      source: "DEVELOPMENT_BYPASS",
    });
  });

  it("ignores development bypass in production env", async () => {
    const mockDb = createMockDb({
      installation: () => Promise.resolve({ online_printing_enabled: 0 }),
    });
    const readiness = new D1PaymentReadiness(mockDb, {
      APP_ENV: "production",
      PAYMENT_READINESS_DEV_BYPASS: "true",
    });

    await expect(readiness.check()).resolves.toEqual({
      ready: false,
      reason: "ONLINE_PRINTING_DISABLED",
      message: "Online printing is currently disabled by the shop.",
    });
  });

  it("fails closed when online printing is disabled in shop settings", async () => {
    const mockDb = createMockDb({
      installation: () => Promise.resolve({ online_printing_enabled: 0 }),
    });
    const readiness = new D1PaymentReadiness(mockDb, {
      APP_ENV: "development",
    });

    await expect(readiness.check()).resolves.toEqual({
      ready: false,
      reason: "ONLINE_PRINTING_DISABLED",
      message: "Online printing is currently disabled by the shop.",
    });
  });

  it("fails closed when no agent has a heartbeat within 90s", async () => {
    const mockDb = createMockDb({
      installation: () => Promise.resolve({ online_printing_enabled: 1 }),
      agents: () => Promise.resolve([]),
    });
    const readiness = new D1PaymentReadiness(mockDb, { APP_ENV: "production" });

    await expect(readiness.check()).resolves.toEqual({
      ready: false,
      reason: "AGENT_OFFLINE",
      message: "The shop printer agent is currently offline.",
    });
  });

  it("fails closed when agent is online but no printers are enabled", async () => {
    const mockDb = createMockDb({
      installation: () => Promise.resolve({ online_printing_enabled: 1 }),
      agents: () => Promise.resolve([{ id: "agent_1" }]),
      printers: () => Promise.resolve([]),
    });
    const readiness = new D1PaymentReadiness(mockDb, { APP_ENV: "production" });

    await expect(readiness.check()).resolves.toEqual({
      ready: false,
      reason: "NO_CONFIGURED_PRINTER",
      message: "No enabled printer is configured for the connected agent.",
    });
  });

  it("fails closed when enabled printer is offline or in error state", async () => {
    const mockDb = createMockDb({
      installation: () => Promise.resolve({ online_printing_enabled: 1 }),
      agents: () => Promise.resolve([{ id: "agent_1" }]),
      printers: () =>
        Promise.resolve([
          {
            id: "printer_1",
            status: "OFFLINE",
            capabilities_json: null,
          },
        ]),
    });
    const readiness = new D1PaymentReadiness(mockDb, { APP_ENV: "production" });

    await expect(readiness.check()).resolves.toEqual({
      ready: false,
      reason: "PRINTER_UNAVAILABLE",
      message:
        "The shop printer is currently offline, blocked, or in an error state.",
    });
  });

  it("checks capability matching for colour, duplex, and paper size", async () => {
    const mockDb = createMockDb({
      installation: () => Promise.resolve({ online_printing_enabled: 1 }),
      agents: () => Promise.resolve([{ id: "agent_1" }]),
      printers: () =>
        Promise.resolve([
          {
            id: "printer_mono",
            status: "ONLINE",
            capabilities_json: JSON.stringify({
              colour: false,
              duplex: true,
              paperSizes: ["A4"],
            }),
          },
        ]),
    });
    const readiness = new D1PaymentReadiness(mockDb, { APP_ENV: "production" });

    // Colour mismatch
    await expect(
      readiness.check({
        paperSize: "A4",
        colorMode: "COLOR",
        sides: "SINGLE",
      }),
    ).resolves.toEqual({
      ready: false,
      reason: "COLOR_MODE_UNSUPPORTED",
      message:
        "Colour printing is currently unavailable on connected printers.",
    });

    // Paper size mismatch
    await expect(
      readiness.check({
        paperSize: "LEGAL" as unknown as PaperSize,
        colorMode: "BW",
        sides: "SINGLE",
      }),
    ).resolves.toEqual({
      ready: false,
      reason: "PAPER_SIZE_UNSUPPORTED",
      message: "LEGAL paper printing is currently unavailable.",
    });

    // Valid BW request succeeds
    await expect(
      readiness.check({
        paperSize: "A4",
        colorMode: "BW",
        sides: "DOUBLE",
      }),
    ).resolves.toEqual({
      ready: true,
      source: "LIVE_AGENT",
      printerId: "printer_mono",
    });
  });

  it("regression: agent process alive but heartbeat stops updating -> fails closed as AGENT_OFFLINE", async () => {
    let agentHeartbeatQueryCount = 0;
    const mockDb = createMockDb({
      installation: () => Promise.resolve({ online_printing_enabled: 1 }),
      agents: () => {
        agentHeartbeatQueryCount++;
        // Simulates D1 query: WHERE last_heartbeat_at_ms >= (nowMs - 90_000)
        // When heartbeat stopped 8 minutes ago, no agent rows match
        return Promise.resolve([]);
      },
      printers: () =>
        Promise.resolve([
          {
            id: "printer_hp",
            status: "ONLINE",
            capabilities_json: JSON.stringify({
              colour: false,
              duplex: true,
              paperSizes: ["A4"],
            }),
          },
        ]),
    });
    const readiness = new D1PaymentReadiness(mockDb, { APP_ENV: "production" });

    const result = await readiness.check({
      paperSize: "A4",
      colorMode: "BW",
      sides: "DOUBLE",
    });

    expect(result).toEqual({
      ready: false,
      reason: "AGENT_OFFLINE",
      message: "The shop printer agent is currently offline.",
    });
    expect(agentHeartbeatQueryCount).toBe(1);
  });
});
