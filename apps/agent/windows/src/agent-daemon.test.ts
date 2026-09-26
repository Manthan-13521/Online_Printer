/* eslint-disable @typescript-eslint/unbound-method -- Vitest inspects method mocks without invoking them. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentAuthError, type AgentClient } from "./agent-client";
import { AgentDaemon } from "./agent-daemon";
import type { PrinterAdapter } from "./printing/printer-adapter";
import type {
  AgentCredentials,
  CredentialStore,
} from "./storage/credential-store";

function createMockStore(
  initialCreds: AgentCredentials | null = null,
): CredentialStore {
  let creds = initialCreds;
  return {
    load: vi.fn(() => Promise.resolve(creds)),
    save: vi.fn((c: AgentCredentials) => {
      creds = c;
      return Promise.resolve();
    }),
    clear: vi.fn(() => {
      creds = null;
      return Promise.resolve();
    }),
  };
}

function createMockAdapter(): PrinterAdapter {
  return {
    listPrinters: vi.fn(() =>
      Promise.resolve([
        { id: "p1", displayName: "Printer 1", isDefault: true },
      ]),
    ),
    getCapabilities: vi.fn(() =>
      Promise.resolve({
        colour: false,
        duplex: true,
        paperSizes: ["A4"],
      }),
    ),
    getStatus: vi.fn(() =>
      Promise.resolve({
        availability: "ONLINE" as const,
      }),
    ),
    submitPdfJob: vi.fn(),
    getJobStatus: vi.fn(),
    cancelJob: vi.fn(),
  };
}

describe("AgentDaemon", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not start if no credentials are configured", async () => {
    const store = createMockStore(null);
    const adapter = createMockAdapter();
    const daemon = new AgentDaemon({
      credentialStore: store,
      printerAdapter: adapter,
    });

    const started = await daemon.start();
    expect(started).toBe(false);
    expect(daemon.isRunning()).toBe(false);
  });

  it("pairs with server and saves credentials", async () => {
    const store = createMockStore(null);
    const adapter = createMockAdapter();
    const mockClient = {
      pair: vi.fn(() =>
        Promise.resolve({
          agentId: "agent_paired_1",
          agentSecret: "secret_paired_1",
          displayName: "Front Desk PC",
        }),
      ),
      sendHeartbeat: vi.fn(() =>
        Promise.resolve({ acknowledged: true, serverTimeMs: 1000 }),
      ),
    } as unknown as AgentClient;

    const daemon = new AgentDaemon({
      client: mockClient,
      credentialStore: store,
      printerAdapter: adapter,
    });

    const creds = await daemon.pair(
      "https://api.printgo.shop",
      "ABCD-EFGH",
      "Front Desk PC",
    );

    expect(creds.agentId).toBe("agent_paired_1");
    expect(store.save).toHaveBeenCalledWith(creds);
  });

  it("sends heartbeats on start and on timer intervals", async () => {
    const store = createMockStore({
      agentId: "agent_1",
      agentSecret: "secret_1",
      serverUrl: "https://api.printgo.shop",
      displayName: "Front Desk PC",
    });
    const adapter = createMockAdapter();
    const mockClient = {
      pair: vi.fn(),
      sendHeartbeat: vi.fn(() =>
        Promise.resolve({ acknowledged: true, serverTimeMs: 1000 }),
      ),
    } as unknown as AgentClient;

    const daemon = new AgentDaemon({
      client: mockClient,
      credentialStore: store,
      printerAdapter: adapter,
      heartbeatIntervalMs: 30_000,
    });

    const started = await daemon.start();
    expect(started).toBe(true);
    expect(daemon.isRunning()).toBe(true);

    // Initial pulse
    expect(mockClient.sendHeartbeat).toHaveBeenCalledTimes(1);

    // Advance 30 seconds
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockClient.sendHeartbeat).toHaveBeenCalledTimes(2);

    daemon.stop();
    expect(daemon.isRunning()).toBe(false);

    // Should not pulse after stop
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockClient.sendHeartbeat).toHaveBeenCalledTimes(2);
  });

  it("stops automatically when server indicates agent is unauthorized / revoked", async () => {
    const store = createMockStore({
      agentId: "agent_1",
      agentSecret: "revoked_secret",
      serverUrl: "https://api.printgo.shop",
      displayName: "Front Desk PC",
    });
    const adapter = createMockAdapter();
    const mockClient = {
      pair: vi.fn(),
      sendHeartbeat: vi
        .fn()
        .mockRejectedValue(new AgentAuthError("Agent revoked")),
    } as unknown as AgentClient;

    const daemon = new AgentDaemon({
      client: mockClient,
      credentialStore: store,
      printerAdapter: adapter,
    });

    await daemon.start();
    // After immediate pulse fails with auth error, daemon should stop
    expect(daemon.isRunning()).toBe(false);
  });
});
