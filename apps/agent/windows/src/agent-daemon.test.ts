/* eslint-disable @typescript-eslint/unbound-method -- Vitest inspects method mocks without invoking them. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentAuthError, type AgentClient } from "./agent-client";
import { AgentDaemon } from "./agent-daemon";
import type {
  PrinterAdapter,
  PrinterChangeEvent,
} from "./printing/printer-adapter";
import type {
  AgentCredentials,
  CredentialStore,
} from "./storage/credential-store";

vi.mock("./storage/status-file", () => ({
  writeAgentStatus: vi.fn(() => Promise.resolve()),
}));

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
    verifyReadiness: vi.fn(() => Promise.resolve()),
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

  it("does not write the one-time pair code to status logs", async () => {
    const messages: string[] = [];
    const daemon = new AgentDaemon({
      client: {
        pair: vi.fn(() =>
          Promise.resolve({
            agentId: "agent_1",
            agentSecret: "secret_1",
            displayName: "Front Desk PC",
          }),
        ),
      } as unknown as AgentClient,
      credentialStore: createMockStore(),
      printerAdapter: createMockAdapter(),
      onStatusChange: (message) => messages.push(message),
    });

    await daemon.pair(
      "https://api.printgo.shop",
      "SECRET-PAIR-CODE",
      "Front Desk PC",
    );

    expect(messages.join(" ")).not.toContain("SECRET-PAIR-CODE");
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

    // Advance 60 seconds
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockClient.sendHeartbeat).toHaveBeenCalledTimes(2);

    daemon.stop();
    expect(daemon.isRunning()).toBe(false);

    // Should not pulse after stop
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockClient.sendHeartbeat).toHaveBeenCalledTimes(2);
  });

  it("uses 60s idle polling and executes commands when they arrive", async () => {
    let polls = 0;
    const client = {
      sendHeartbeat: vi.fn(() => {
        polls++;
        return Promise.resolve({
          acknowledged: true,
          serverTimeMs: Date.now(),
          ...(polls === 3
            ? {
                nextCommand: {
                  type: "TEST_PRINT" as const,
                  commandId: "cmd-after-idle",
                  printerId: "printer-1",
                  windowsPrinterName: "p1",
                  printerDisplayName: "Printer 1",
                  shopName: "Test Shop",
                  expiresAtMs: Date.now() - 1,
                },
              }
            : {}),
        });
      }),
    } as unknown as AgentClient;
    const daemon = new AgentDaemon({
      client,
      credentialStore: createMockStore({
        agentId: "agent_1",
        agentSecret: "secret_1",
        serverUrl: "https://api.printgo.shop",
        displayName: "Front Desk PC",
      }),
      printerAdapter: createMockAdapter(),
    });

    const startedAt = Date.now();
    await daemon.start(); // poll 1

    await vi.advanceTimersToNextTimerAsync(); // +60s
    expect(client.sendHeartbeat).toHaveBeenCalledTimes(2);
    expect(Date.now() - startedAt).toBe(60_000);

    await vi.advanceTimersToNextTimerAsync(); // +60s (poll 3 gets command)
    expect(client.sendHeartbeat).toHaveBeenCalledTimes(3);
    expect(Date.now() - startedAt).toBe(120_000);

    daemon.stop();
  });

  it("checks a blocked printer every 30 seconds while keeping Agent liveness pulses", async () => {
    const adapter = createMockAdapter();
    vi.mocked(adapter.getStatus).mockResolvedValue({
      availability: "BLOCKED",
      message: "Paper jam",
    });
    const client = {
      sendHeartbeat: vi.fn(() =>
        Promise.resolve({ acknowledged: true, serverTimeMs: Date.now() }),
      ),
    } as unknown as AgentClient;
    const daemon = new AgentDaemon({
      client,
      credentialStore: createMockStore({
        agentId: "agent_1",
        agentSecret: "secret_1",
        serverUrl: "https://api.printgo.shop",
        displayName: "Front Desk PC",
      }),
      printerAdapter: adapter,
    });

    await daemon.start();
    expect(adapter.listPrinters).toHaveBeenCalledTimes(1);
    expect(client.sendHeartbeat).toHaveBeenCalledTimes(1);

    // At t=30s: with a blocked printer, nextDelayMs is 30s. Second pulse runs and re-probes hardware.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(client.sendHeartbeat).toHaveBeenCalledTimes(2);
    expect(adapter.listPrinters).toHaveBeenCalledTimes(2);

    // At t=60s: third pulse runs and re-probes hardware.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(client.sendHeartbeat).toHaveBeenCalledTimes(3);
    expect(adapter.listPrinters).toHaveBeenCalledTimes(3);

    // At t=90s: fourth pulse runs.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(client.sendHeartbeat).toHaveBeenCalledTimes(4);
    expect(adapter.listPrinters).toHaveBeenCalledTimes(4);
    daemon.stop();
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

  it("does not pair with server if credential store preflight verification fails", async () => {
    const store = createMockStore(null);
    store.verifyReadiness = vi.fn(() =>
      Promise.reject(
        new Error(
          "Windows DPAPI credential encryption is unavailable on this machine: DPAPI_UNAVAILABLE",
        ),
      ),
    );
    const mockClient = {
      pair: vi.fn(),
    } as unknown as AgentClient;

    const daemon = new AgentDaemon({
      client: mockClient,
      credentialStore: store,
      printerAdapter: createMockAdapter(),
    });

    await expect(
      daemon.pair("https://api.printgo.shop", "PREF-LIGHT", "Shop PC"),
    ).rejects.toThrow(/DPAPI credential encryption is unavailable/i);

    // CRITICAL: client.pair must NEVER be called, preserving the server's one-time pair code!
    expect(mockClient.pair).not.toHaveBeenCalled();
  });

  it("keeps running and schedules the next pulse after a successful test print", async () => {
    const store = createMockStore({
      agentId: "agent_1",
      agentSecret: "secret_1",
      serverUrl: "https://api.printgo.shop",
      displayName: "Front Desk PC",
    });
    const adapter = createMockAdapter();
    vi.mocked(adapter.submitPdfJob).mockResolvedValue({ spoolJobId: "451" });
    vi.mocked(adapter.getJobStatus).mockResolvedValue({
      state: "COMPLETED_OR_REMOVED",
      spoolJobId: "451",
    });
    const client = {
      sendHeartbeat: vi
        .fn()
        .mockResolvedValueOnce({
          acknowledged: true,
          serverTimeMs: 1,
          nextCommand: {
            type: "TEST_PRINT",
            commandId: "cmd-success",
            printerId: "printer-1",
            windowsPrinterName: "p1",
            printerDisplayName: "Front Desk Canon",
            shopName: "Central Xerox Shop",
            expiresAtMs: Date.now() + 60_000,
          },
        })
        .mockResolvedValue({ acknowledged: true, serverTimeMs: 2 }),
      reportCommand: vi.fn(() => Promise.resolve()),
    } as unknown as AgentClient;
    const daemon = new AgentDaemon({
      client,
      credentialStore: store,
      printerAdapter: adapter,
    });

    await daemon.start();
    expect(daemon.isRunning()).toBe(true);
    expect(client.reportCommand).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(65_000);
    expect(client.sendHeartbeat).toHaveBeenCalledTimes(2);
    expect(daemon.isRunning()).toBe(true);
    daemon.stop();
  });

  it("regression: reports FAILED when test print cannot be correlated safely in spooler", async () => {
    const store = createMockStore({
      agentId: "agent_1",
      agentSecret: "secret_1",
      serverUrl: "https://api.printgo.shop",
      displayName: "Front Desk PC",
    });
    const adapter = createMockAdapter();
    vi.mocked(adapter.submitPdfJob).mockResolvedValue({
      spoolJobId: "unobserved-1760288000000",
    });
    const client = {
      sendHeartbeat: vi.fn().mockResolvedValueOnce({
        acknowledged: true,
        serverTimeMs: 1,
        nextCommand: {
          type: "TEST_PRINT",
          commandId: "cmd-unobserved",
          printerId: "printer-1",
          windowsPrinterName: "p1",
          printerDisplayName: "HP Laser MFP 131",
          shopName: "Central Xerox Shop",
          expiresAtMs: Date.now() + 60_000,
        },
      }),
      reportCommand: vi.fn(() => Promise.resolve()),
    } as unknown as AgentClient;
    const daemon = new AgentDaemon({
      client,
      credentialStore: store,
      printerAdapter: adapter,
    });

    await daemon.start();
    expect(client.reportCommand).toHaveBeenCalledTimes(1);
    const reportCall = vi.mocked(client.reportCommand).mock.calls[0];
    expect(reportCall?.[3]).toBe("cmd-unobserved");
    expect(reportCall?.[4]).toMatchObject({
      status: "FAILED",
      failureCode: "PRINTER_ERROR",
    });
    expect(reportCall?.[4]?.failureDetail).toContain(
      "could not be correlated safely",
    );
    daemon.stop();
  });

  it.each([
    ["child process failure", "submit", new Error("Sumatra exited 1")],
    ["printer discovery error", "discover", new Error("CIM unavailable")],
  ])(
    "keeps running after test-print %s",
    async (_label, failurePoint, failure) => {
      const store = createMockStore({
        agentId: "agent_1",
        agentSecret: "secret_1",
        serverUrl: "https://api.printgo.shop",
        displayName: "Front Desk PC",
      });
      const adapter = createMockAdapter();
      if (failurePoint === "submit") {
        vi.mocked(adapter.submitPdfJob).mockRejectedValue(failure);
      } else {
        vi.mocked(adapter.listPrinters)
          .mockResolvedValueOnce([
            { id: "p1", displayName: "Printer 1", isDefault: true },
          ])
          .mockRejectedValueOnce(failure);
      }
      const client = {
        sendHeartbeat: vi.fn(() =>
          Promise.resolve({
            acknowledged: true,
            serverTimeMs: 1,
            nextCommand: {
              type: "TEST_PRINT" as const,
              commandId: `cmd-${failurePoint}`,
              printerId: "printer-1",
              windowsPrinterName: "p1",
              printerDisplayName: "Printer 1",
              shopName: "Test Shop",
              expiresAtMs: Date.now() + 60_000,
            },
          }),
        ),
        reportCommand: vi.fn(() => Promise.resolve()),
      } as unknown as AgentClient;
      const daemon = new AgentDaemon({
        client,
        credentialStore: store,
        printerAdapter: adapter,
      });

      await daemon.start();
      expect(daemon.isRunning()).toBe(true);
      expect(client.reportCommand).toHaveBeenCalledWith(
        expect.any(String),
        "agent_1",
        "secret_1",
        `cmd-${failurePoint}`,
        expect.objectContaining({ status: "FAILED" }),
      );
      daemon.stop();
    },
  );

  it("keeps running when test-print acknowledgement and the error callback fail", async () => {
    const adapter = createMockAdapter();
    vi.mocked(adapter.submitPdfJob).mockResolvedValue({ spoolJobId: "452" });
    vi.mocked(adapter.getJobStatus).mockResolvedValue({
      state: "COMPLETED_OR_REMOVED",
      spoolJobId: "452",
    });
    const client = {
      sendHeartbeat: vi.fn(() =>
        Promise.resolve({
          acknowledged: true,
          serverTimeMs: 1,
          nextCommand: {
            type: "TEST_PRINT" as const,
            commandId: "cmd-ack-failure",
            printerId: "printer-1",
            windowsPrinterName: "p1",
            printerDisplayName: "Printer 1",
            shopName: "Test Shop",
            expiresAtMs: Date.now() + 60_000,
          },
        }),
      ),
      reportCommand: vi.fn(() => Promise.reject(new Error("network down"))),
    } as unknown as AgentClient;
    const daemon = new AgentDaemon({
      client,
      credentialStore: createMockStore({
        agentId: "agent_1",
        agentSecret: "secret_1",
        serverUrl: "https://api.printgo.shop",
        displayName: "Front Desk PC",
      }),
      printerAdapter: adapter,
      onError: () => {
        throw new Error("observer failed");
      },
    });

    await expect(daemon.start()).resolves.toBe(true);
    expect(daemon.isRunning()).toBe(true);
    daemon.stop();
  });

  it("survives a scheduled network interruption and resumes polling", async () => {
    const client = {
      sendHeartbeat: vi
        .fn()
        .mockResolvedValueOnce({ acknowledged: true, serverTimeMs: 1 })
        .mockRejectedValueOnce(new Error("network interrupted"))
        .mockResolvedValue({ acknowledged: true, serverTimeMs: 2 }),
    } as unknown as AgentClient;
    const daemon = new AgentDaemon({
      client,
      credentialStore: createMockStore({
        agentId: "agent_1",
        agentSecret: "secret_1",
        serverUrl: "https://api.printgo.shop",
        displayName: "Front Desk PC",
      }),
      printerAdapter: createMockAdapter(),
      random: () => 1,
    });

    await daemon.start();
    await vi.advanceTimersToNextTimerAsync(); // call 2 (error)
    expect(daemon.isRunning()).toBe(true);
    await vi.advanceTimersToNextTimerAsync(); // call 3 (success)
    expect(client.sendHeartbeat).toHaveBeenCalledTimes(3);
    expect(daemon.isRunning()).toBe(true);
    daemon.stop();
  });

  it("warns and re-throws if credential store save fails after server pairing", async () => {
    const messages: string[] = [];
    const store = createMockStore(null);
    store.save = vi.fn(() => Promise.reject(new Error("Disk quota exceeded")));
    const mockClient = {
      pair: vi.fn(() =>
        Promise.resolve({
          agentId: "agent_paired_ghost",
          agentSecret: "secret_paired_ghost",
          displayName: "Front Desk PC",
        }),
      ),
    } as unknown as AgentClient;

    const daemon = new AgentDaemon({
      client: mockClient,
      credentialStore: store,
      printerAdapter: createMockAdapter(),
      onStatusChange: (m) => messages.push(m),
    });

    await expect(
      daemon.pair("https://api.printgo.shop", "VALID-CODE", "Shop PC"),
    ).rejects.toThrow("Disk quota exceeded");

    // Warning log with recovery advice must be present
    expect(
      messages.some((m) =>
        m.includes(
          "WARNING: Agent was paired on server, but saving credentials locally failed",
        ),
      ),
    ).toBe(true);
    expect(
      messages.some((m) =>
        m.includes("revoke the unpaired agent in PrintGo Admin"),
      ),
    ).toBe(true);
  });

  describe("Phase 8C: OPT-7 and OPT-8 Smart Optimizations", () => {
    it("OPT-7: uses 60s idle heartbeat schedule aligned with 40s D1 write throttle and 90s claim cutoff", async () => {
      const client = {
        sendHeartbeat: vi.fn(() =>
          Promise.resolve({
            acknowledged: true,
            serverTimeMs: Date.now(),
            onlinePrintingEnabled: true,
          }),
        ),
      } as unknown as AgentClient;
      const daemon = new AgentDaemon({
        client,
        credentialStore: createMockStore({
          agentId: "agent_opt7",
          agentSecret: "secret_opt7",
          serverUrl: "https://api.printgo.shop",
          displayName: "Front Desk PC",
        }),
        printerAdapter: createMockAdapter(),
      });

      await daemon.start();
      expect(client.sendHeartbeat).toHaveBeenCalledTimes(1);

      // Advance 60s -> pulse 2 runs
      await vi.advanceTimersByTimeAsync(60_000);
      expect(client.sendHeartbeat).toHaveBeenCalledTimes(2);

      // Simulate WebSocket connected
      (
        daemon as unknown as { ws: { readyState: number; close: () => void } }
      ).ws = {
        readyState: 1,
        close: vi.fn(),
      };
      expect(daemon.isWebSocketConnected()).toBe(true);

      // Advance 60s -> pulse 3 runs while WS is connected (never stalls for 120s)
      await vi.advanceTimersByTimeAsync(60_000);
      expect(client.sendHeartbeat).toHaveBeenCalledTimes(3);

      // At +30s (halfway through 60s), heartbeat should NOT fire
      await vi.advanceTimersByTimeAsync(30_000);
      expect(client.sendHeartbeat).toHaveBeenCalledTimes(3);

      // At +30s (total 60s), next heartbeat fires (call 4)
      await vi.advanceTimersByTimeAsync(30_000);
      expect(client.sendHeartbeat).toHaveBeenCalledTimes(4);

      daemon.stop();
    });

    it("OPT-8: transitions to stable mode after 5 consecutive healthy checks and backs off to 15-minute fallback", async () => {
      let eventCallback: ((event: PrinterChangeEvent) => void) | null = null;
      const adapter = createMockAdapter();
      adapter.subscribePrinterEvents = vi.fn(
        (cb: (event: PrinterChangeEvent) => void) => {
          eventCallback = cb;
          return vi.fn();
        },
      );

      const client = {
        sendHeartbeat: vi.fn(() =>
          Promise.resolve({
            acknowledged: true,
            serverTimeMs: Date.now(),
            onlinePrintingEnabled: true,
          }),
        ),
      } as unknown as AgentClient;
      const daemon = new AgentDaemon({
        client,
        credentialStore: createMockStore({
          agentId: "agent_opt8",
          agentSecret: "secret_opt8",
          serverUrl: "https://api.printgo.shop",
          displayName: "Front Desk PC",
        }),
        printerAdapter: adapter,
      });

      await daemon.start(); // Check 1
      expect(adapter.listPrinters).toHaveBeenCalledTimes(1);
      expect(daemon.getConsecutiveHealthyChecks()).toBe(1);
      expect(daemon.isPrinterStable()).toBe(false);

      // Advance 60s -> Check 2
      await vi.advanceTimersByTimeAsync(60_000);
      expect(adapter.listPrinters).toHaveBeenCalledTimes(2);
      expect(daemon.getConsecutiveHealthyChecks()).toBe(2);

      // Advance 60s -> Check 3
      await vi.advanceTimersByTimeAsync(60_000);
      expect(adapter.listPrinters).toHaveBeenCalledTimes(3);
      expect(daemon.getConsecutiveHealthyChecks()).toBe(3);

      // Advance 60s -> Check 4
      await vi.advanceTimersByTimeAsync(60_000);
      expect(adapter.listPrinters).toHaveBeenCalledTimes(4);
      expect(daemon.getConsecutiveHealthyChecks()).toBe(4);
      expect(daemon.isPrinterStable()).toBe(false);

      // Advance 60s -> Check 5: Stable!
      await vi.advanceTimersByTimeAsync(60_000);
      expect(adapter.listPrinters).toHaveBeenCalledTimes(5);
      expect(daemon.getConsecutiveHealthyChecks()).toBe(5);
      expect(daemon.isPrinterStable()).toBe(true);
      expect(adapter.subscribePrinterEvents).toHaveBeenCalledTimes(1);

      // In stable mode, printer checks do NOT run at 60s or 120s
      await vi.advanceTimersByTimeAsync(120_000);
      expect(adapter.listPrinters).toHaveBeenCalledTimes(5); // Still 5!

      // After 15 minutes (13 min additional), 15-minute safety fallback probe fires!
      await vi.advanceTimersByTimeAsync(13 * 60 * 1_000);
      expect(adapter.listPrinters).toHaveBeenCalledTimes(6); // Triggered at 15m
      expect(daemon.isPrinterStable()).toBe(true);

      // Triggering a printer fault resets stability and forces immediate re-check
      daemon.markPrinterFault("p1", "OFFLINE");
      expect(daemon.isPrinterStable()).toBe(false);
      expect(daemon.getConsecutiveHealthyChecks()).toBe(0);

      // Next pulse refreshes printers immediately
      await vi.advanceTimersByTimeAsync(0);
      expect(adapter.listPrinters).toHaveBeenCalledTimes(7);

      // Also verify event callback triggers fault reset
      expect(eventCallback).toBeDefined();
      if (eventCallback) {
        // Fast-forward back to stability
        for (let i = 0; i < 4; i++) {
          await vi.advanceTimersByTimeAsync(60_000);
        }
        expect(daemon.isPrinterStable()).toBe(true);

        // Event fires JAM
        (
          eventCallback as (e: {
            printerName: string;
            eventType: "JAM";
          }) => void
        )({
          printerName: "p1",
          eventType: "JAM",
        });
        expect(daemon.isPrinterStable()).toBe(false);
        expect(daemon.getConsecutiveHealthyChecks()).toBe(0);
      }

      daemon.stop();
    });

    describe("Instant Print Dispatch Optimizations (Phases 1 & 2)", () => {
      it("Phase 1: WAKE_UP while pulse is in flight sets pendingWakeup and schedules immediate follow-up", async () => {
        let resolveHeartbeat: (val: unknown) => void = () => undefined;
        let heartbeatCount = 0;
        const client = {
          sendHeartbeat: vi.fn(() => {
            heartbeatCount++;
            if (heartbeatCount === 1) {
              return Promise.resolve({
                acknowledged: true,
                serverTimeMs: Date.now(),
                onlinePrintingEnabled: true,
                printJobs: [],
              });
            }
            // Second heartbeat stays in flight until resolveHeartbeat is called
            return new Promise((resolve) => {
              resolveHeartbeat = resolve;
            });
          }),
        };

        const daemon = new AgentDaemon({
          credentialStore: createMockStore({
            agentId: "a1",
            agentSecret: "s1",
            serverUrl: "http://localhost:8787",
            displayName: "Test Agent",
          }),
          client: client as unknown as AgentClient,
          printerAdapter: createMockAdapter(),
          heartbeatIntervalMs: 5_000,
        });

        await daemon.start();
        expect(client.sendHeartbeat).toHaveBeenCalledTimes(1);

        // Advance 60s to let schedulePulse trigger the second pulse
        vi.advanceTimersByTime(60_000);
        await vi.waitFor(() =>
          expect(client.sendHeartbeat).toHaveBeenCalledTimes(2),
        );

        // While pulse 2 is in flight, simulate WAKE_UP arriving
        (
          daemon as unknown as {
            nextDelayMs: number;
            wakeupTriggered: boolean;
            isBeating: boolean;
            pendingWakeup: boolean;
            reschedulePulse: () => void;
          }
        ).nextDelayMs = 0;
        (daemon as unknown as { wakeupTriggered: boolean }).wakeupTriggered =
          true;
        if ((daemon as unknown as { isBeating: boolean }).isBeating) {
          (daemon as unknown as { pendingWakeup: boolean }).pendingWakeup =
            true;
        }
        (
          daemon as unknown as { reschedulePulse: () => void }
        ).reschedulePulse();

        expect(daemon.isPendingWakeup()).toBe(true);
        expect(daemon.isWakeupTriggered()).toBe(true);

        // Complete the in-flight heartbeat
        resolveHeartbeat({
          acknowledged: true,
          serverTimeMs: Date.now(),
          onlinePrintingEnabled: true,
          printJobs: [],
        });
        await vi.waitFor(() => expect(daemon.isPendingWakeup()).toBe(false));

        // Advance 0ms timer to fire immediate follow-up pulse
        vi.advanceTimersByTime(0);
        await vi.waitFor(() =>
          expect(client.sendHeartbeat).toHaveBeenCalledTimes(3),
        );

        daemon.stop();
      });

      it("Phase 2: wakeup-triggered pulse skips redundant listPrinters call when healthy printers exist", async () => {
        const client = {
          sendHeartbeat: vi.fn(() =>
            Promise.resolve({
              acknowledged: true,
              serverTimeMs: Date.now(),
              onlinePrintingEnabled: true,
              printJobs: [],
            }),
          ),
        };
        const adapter = createMockAdapter();

        const daemon = new AgentDaemon({
          credentialStore: createMockStore({
            agentId: "a1",
            agentSecret: "s1",
            serverUrl: "http://localhost:8787",
            displayName: "Test Agent",
          }),
          client: client as unknown as AgentClient,
          printerAdapter: adapter,
          heartbeatIntervalMs: 5_000,
        });

        await daemon.start();
        expect(client.sendHeartbeat).toHaveBeenCalledTimes(1);
        expect(adapter.listPrinters).toHaveBeenCalledTimes(1); // initial enumeration

        // Mark that a wakeup event just arrived
        (daemon as unknown as { wakeupTriggered: boolean }).wakeupTriggered =
          true;
        (daemon as unknown as { nextDelayMs: number }).nextDelayMs = 0;

        // Run the wakeup pulse
        await (daemon as unknown as { pulse: () => Promise<void> }).pulse();

        expect(client.sendHeartbeat).toHaveBeenCalledTimes(2);
        // Crucial verification: listPrinters should NOT have been called again!
        expect(adapter.listPrinters).toHaveBeenCalledTimes(1);

        daemon.stop();
      });

      it("Phase 2: wakeup-triggered pulse still queries printers if no healthy reports exist", async () => {
        const client = {
          sendHeartbeat: vi.fn(() =>
            Promise.resolve({
              acknowledged: true,
              serverTimeMs: Date.now(),
              onlinePrintingEnabled: true,
              printJobs: [],
            }),
          ),
        };
        const adapter = createMockAdapter();
        // Return OFFLINE printer
        adapter.getStatus = vi.fn(() =>
          Promise.resolve({ availability: "OFFLINE" as const }),
        );

        const daemon = new AgentDaemon({
          credentialStore: createMockStore({
            agentId: "a1",
            agentSecret: "s1",
            serverUrl: "http://localhost:8787",
            displayName: "Test Agent",
          }),
          client: client as unknown as AgentClient,
          printerAdapter: adapter,
          heartbeatIntervalMs: 5_000,
        });

        await daemon.start();
        expect(client.sendHeartbeat).toHaveBeenCalledTimes(1);
        expect(adapter.listPrinters).toHaveBeenCalledTimes(1);

        // Force last printer refresh to be past the threshold
        (
          daemon as unknown as { lastPrinterRefreshMs: number }
        ).lastPrinterRefreshMs = 0;
        (daemon as unknown as { wakeupTriggered: boolean }).wakeupTriggered =
          true;

        // Run wakeup pulse - because printer was OFFLINE, it must NOT skip refresh
        await (daemon as unknown as { pulse: () => Promise<void> }).pulse();

        expect(client.sendHeartbeat).toHaveBeenCalledTimes(2);
        expect(adapter.listPrinters).toHaveBeenCalledTimes(2);

        daemon.stop();
      });

      it("Phase 2: agent daemon schedules 30s delay when a printer is faulty and executes repeated probes at 30s intervals", async () => {
        vi.useFakeTimers();
        const client = {
          sendHeartbeat: vi.fn(() =>
            Promise.resolve({
              acknowledged: true,
              serverTimeMs: Date.now(),
              onlinePrintingEnabled: true,
              printJobs: [],
            }),
          ),
        };
        const adapter = createMockAdapter();
        adapter.getStatus = vi.fn(() =>
          Promise.resolve({
            availability: "BLOCKED" as const,
            message: "Paper Jam",
          }),
        );

        const daemon = new AgentDaemon({
          credentialStore: createMockStore({
            agentId: "a1",
            agentSecret: "s1",
            serverUrl: "http://localhost:8787",
            displayName: "Test Agent",
          }),
          client: client as unknown as AgentClient,
          printerAdapter: adapter,
          heartbeatIntervalMs: 5_000,
        });

        await daemon.start();
        expect(adapter.listPrinters).toHaveBeenCalledTimes(1);
        expect(client.sendHeartbeat).toHaveBeenCalledTimes(1);
        expect((daemon as unknown as { nextDelayMs: number }).nextDelayMs).toBe(
          30_000,
        );

        // Advance 30 seconds
        await vi.advanceTimersByTimeAsync(30_000);
        expect(adapter.listPrinters).toHaveBeenCalledTimes(2);
        expect(client.sendHeartbeat).toHaveBeenCalledTimes(2);
        expect((daemon as unknown as { nextDelayMs: number }).nextDelayMs).toBe(
          30_000,
        );

        // Advance another 30 seconds
        await vi.advanceTimersByTimeAsync(30_000);
        expect(adapter.listPrinters).toHaveBeenCalledTimes(3);
        expect(client.sendHeartbeat).toHaveBeenCalledTimes(3);

        daemon.stop();
        vi.useRealTimers();
      });

      it("PROBE_PRINTER forces immediate hardware probe and sends fresh printer report in heartbeat", async () => {
        vi.useFakeTimers();
        const client = {
          sendHeartbeat: vi.fn(() =>
            Promise.resolve({
              acknowledged: true,
              serverTimeMs: Date.now(),
              onlinePrintingEnabled: true,
              printJobs: [],
            }),
          ),
        };
        const adapter = createMockAdapter();

        const daemon = new AgentDaemon({
          credentialStore: createMockStore({
            agentId: "a1",
            agentSecret: "s1",
            serverUrl: "http://localhost:8787",
            displayName: "Test Agent",
          }),
          client: client as unknown as AgentClient,
          printerAdapter: adapter,
          heartbeatIntervalMs: 5_000,
        });

        await daemon.start();
        expect(adapter.listPrinters).toHaveBeenCalledTimes(1);
        expect(client.sendHeartbeat).toHaveBeenCalledTimes(1);

        // Simulate WebSocket receiving PROBE_PRINTER
        (
          daemon as unknown as {
            pendingProbe: boolean;
            wakeupTriggered: boolean;
            lastPrinterRefreshMs: number;
            nextDelayMs: number;
            reschedulePulse: () => void;
          }
        ).pendingProbe = true;
        (daemon as unknown as { wakeupTriggered: boolean }).wakeupTriggered =
          false;
        (
          daemon as unknown as { lastPrinterRefreshMs: number }
        ).lastPrinterRefreshMs = -Infinity;
        (daemon as unknown as { nextDelayMs: number }).nextDelayMs = 0;
        (
          daemon as unknown as { reschedulePulse: () => void }
        ).reschedulePulse();

        expect(daemon.isPendingProbe()).toBe(true);

        // Advance 0ms timer to trigger pulse
        await vi.advanceTimersByTimeAsync(0);

        // Hardware probe must be called again immediately
        expect(adapter.listPrinters).toHaveBeenCalledTimes(2);
        expect(client.sendHeartbeat).toHaveBeenCalledTimes(2);
        expect(daemon.isPendingProbe()).toBe(false);

        daemon.stop();
        vi.useRealTimers();
      });

      it("PROBE_PRINTER while pulse is in flight preserves pendingProbe and executes hardware probe on follow-up", async () => {
        vi.useFakeTimers();
        let resolveHeartbeat: (val: unknown) => void = () => undefined;
        let heartbeatCount = 0;
        const client = {
          sendHeartbeat: vi.fn(() => {
            heartbeatCount++;
            if (heartbeatCount === 1) {
              return Promise.resolve({
                acknowledged: true,
                serverTimeMs: Date.now(),
                onlinePrintingEnabled: true,
                printJobs: [],
              });
            }
            return new Promise((resolve) => {
              resolveHeartbeat = resolve;
            });
          }),
        };
        const adapter = createMockAdapter();

        const daemon = new AgentDaemon({
          credentialStore: createMockStore({
            agentId: "a1",
            agentSecret: "s1",
            serverUrl: "http://localhost:8787",
            displayName: "Test Agent",
          }),
          client: client as unknown as AgentClient,
          printerAdapter: adapter,
          heartbeatIntervalMs: 5_000,
        });

        await daemon.start();
        expect(adapter.listPrinters).toHaveBeenCalledTimes(1);
        expect(client.sendHeartbeat).toHaveBeenCalledTimes(1);

        // Advance 60s for pulse 2
        vi.advanceTimersByTime(60_000);
        await vi.waitFor(() =>
          expect(client.sendHeartbeat).toHaveBeenCalledTimes(2),
        );

        // While pulse 2 is in flight, PROBE_PRINTER arrives
        (
          daemon as unknown as {
            pendingProbe: boolean;
            wakeupTriggered: boolean;
            lastPrinterRefreshMs: number;
            nextDelayMs: number;
            isBeating: boolean;
            pendingWakeup: boolean;
            reschedulePulse: () => void;
          }
        ).pendingProbe = true;
        (daemon as unknown as { wakeupTriggered: boolean }).wakeupTriggered =
          false;
        (
          daemon as unknown as { lastPrinterRefreshMs: number }
        ).lastPrinterRefreshMs = -Infinity;
        (daemon as unknown as { nextDelayMs: number }).nextDelayMs = 0;
        if ((daemon as unknown as { isBeating: boolean }).isBeating) {
          (daemon as unknown as { pendingWakeup: boolean }).pendingWakeup =
            true;
        }
        (
          daemon as unknown as { reschedulePulse: () => void }
        ).reschedulePulse();

        expect(daemon.isPendingProbe()).toBe(true);
        expect(daemon.isPendingWakeup()).toBe(true);

        // Complete the in-flight heartbeat
        resolveHeartbeat({
          acknowledged: true,
          serverTimeMs: Date.now(),
          onlinePrintingEnabled: true,
          printJobs: [],
        });
        await vi.waitFor(() => expect(daemon.isPendingWakeup()).toBe(false));

        // Advance 0ms timer for follow-up pulse
        await vi.advanceTimersByTimeAsync(0);

        // Follow-up pulse must execute the probe (adapter called)
        expect(adapter.listPrinters).toHaveBeenCalledTimes(3);
        expect(client.sendHeartbeat).toHaveBeenCalledTimes(3);

        daemon.stop();
        vi.useRealTimers();
      });
    });
  });
});
