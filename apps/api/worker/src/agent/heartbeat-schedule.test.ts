import { describe, expect, it, vi } from "vitest";
import { AGENT_HEARTBEAT_TIMEOUT_MS } from "@printgo/domain";
import type { ValidatedAgentHeartbeatInput } from "@printgo/validation";
import type { AgentRepository } from "./repository.js";
import { AgentService } from "./service.js";

function createMockRepo(lastHeartbeatAtMs: number | null = null) {
  let currentHeartbeat = lastHeartbeatAtMs;
  let updateCount = 0;
  const repo: AgentRepository = {
    createPairCode: vi.fn(),
    findPairCode: vi.fn(),
    consumePairCodeAndCreateAgent: vi.fn(),
    findAgentByCredentialHash: vi.fn(() =>
      Promise.resolve({
        id: "agent_test",
        displayName: "Front Desk PC",
        isActive: true,
        lastHeartbeatAtMs: currentHeartbeat,
        onlinePrintingEnabled: true,
        hasPendingCommand: false,
        hasPrintWork: false,
      }),
    ),
    findAgentById: vi.fn(),
    updateHeartbeat: vi.fn((input: { agentId: string; nowMs: number }) => {
      currentHeartbeat = input.nowMs;
      updateCount++;
      return Promise.resolve();
    }),
    listAgentsWithPrinters: vi.fn(),
    revokeAgent: vi.fn(),
    togglePrinter: vi.fn(),
    updatePrinterConfig: vi.fn(),
    findPrinterById: vi.fn(),
    createTestPrintCommand: vi.fn(),
    claimPendingTestPrintCommand: vi.fn(() => Promise.resolve(null)),
    reportTestPrintCommand: vi.fn(),
    getLatestTestPrintCommand: vi.fn(),
    setDefaultProductionPrinter: vi.fn(),
    getDefaultProductionPrinterId: vi.fn(),
    checkPrinterHealth: vi.fn(),
    configureFallback: vi.fn(),
  };

  return {
    repo,
    getUpdateCount: () => updateCount,
    getLastHeartbeat: () => currentHeartbeat,
  };
}

const emptyPulseInput: ValidatedAgentHeartbeatInput = {
  agentVersion: "2.0.0",
  operationalState: "ONLINE",
  printers: [],
};

describe("Agent Heartbeat Scheduling & Write Throttle", () => {
  it("idle polling at 60s intervals with 65s throttle executes writes on alternating polls (every 120s)", async () => {
    let now = 1_000_000;
    const { repo, getUpdateCount, getLastHeartbeat } = createMockRepo(now);
    const service = new AgentService(repo, () => now);

    // Initial state: heartbeat was written at t=0
    expect(getUpdateCount()).toBe(0);
    expect(getLastHeartbeat()).toBe(now);

    // Poll 1 at t = 60s (60,000ms): elapsed is 60s < 65s -> THROTTLED (0 writes)
    now += 60_000;
    const p1 = await service.heartbeat("secret", emptyPulseInput, false);
    expect(p1.acknowledged).toBe(true);
    expect(getUpdateCount()).toBe(0);

    // Poll 2 at t = 120s (120,000ms): elapsed is 120s >= 65s -> WRITTEN (1 write)
    now += 60_000;
    const p2 = await service.heartbeat("secret", emptyPulseInput, false);
    expect(p2.acknowledged).toBe(true);
    expect(getUpdateCount()).toBe(1);
    expect(getLastHeartbeat()).toBe(1_120_000);

    // Poll 3 at t = 180s: elapsed is 60s < 65s -> THROTTLED (1 write total)
    now += 60_000;
    const p3 = await service.heartbeat("secret", emptyPulseInput, false);
    expect(p3.acknowledged).toBe(true);
    expect(getUpdateCount()).toBe(1);

    // Poll 4 at t = 240s: elapsed is 120s >= 65s -> WRITTEN (2 writes total)
    now += 60_000;
    const p4 = await service.heartbeat("secret", emptyPulseInput, false);
    expect(p4.acknowledged).toBe(true);
    expect(getUpdateCount()).toBe(2);
    expect(getLastHeartbeat()).toBe(1_240_000);

    // Simulate full 15-hour idle period (900 polls of 60s each)
    // Over 900 polls starting from poll 5 to 900 (896 more polls):
    // Alternating polls trigger writes every 120s.
    for (let poll = 5; poll <= 900; poll++) {
      now += 60_000;
      await service.heartbeat("secret", emptyPulseInput, false);
    }

    // In 900 polls spanning 54,000s, exactly 54,000 / 120 = 450 writes occur!
    expect(getUpdateCount()).toBe(450);
  });

  it("active polling at 6s intervals triggers writes every 66s (every 11th poll)", async () => {
    let now = 1_000_000;
    const { repo, getUpdateCount } = createMockRepo(now);
    const service = new AgentService(repo, () => now);

    // 10 active polls at 6s intervals (t = 6s through t = 60s): all throttled
    for (let i = 1; i <= 10; i++) {
      now += 6_000;
      await service.heartbeat("secret", emptyPulseInput, false);
      expect(getUpdateCount()).toBe(0);
    }

    // 11th active poll at t = 66s: elapsed is 66s >= 65s -> write occurs!
    now += 6_000;
    await service.heartbeat("secret", emptyPulseInput, false);
    expect(getUpdateCount()).toBe(1);

    // In 1 hour of continuous active printing (600 polls at 6s intervals):
    // Writes occur every 66s -> Math.floor(3600 / 66) = 54 writes
    for (let i = 12; i <= 600; i++) {
      now += 6_000;
      await service.heartbeat("secret", emptyPulseInput, false);
    }
    expect(getUpdateCount()).toBe(54);
  });

  it("reconnecting agent after 90s disconnect writes immediately and remains within 150s offline threshold", async () => {
    let now = 1_000_000;
    const { repo, getUpdateCount, getLastHeartbeat } = createMockRepo(now);
    const service = new AgentService(repo, () => now);

    // Network disconnection: 90 seconds elapse with zero polls
    now += 90_000;

    // Check offline threshold: 90s < 150s -> agent is still considered online
    expect(now - getLastHeartbeat()!).toBeLessThan(AGENT_HEARTBEAT_TIMEOUT_MS);

    // Reconnection pulse arrives at 90s: elapsed >= 65s -> write triggers immediately
    await service.heartbeat("secret", emptyPulseInput, false);
    expect(getUpdateCount()).toBe(1);
    expect(getLastHeartbeat()).toBe(now);
  });

  it("printer inventory change forces immediate write regardless of the 65s throttle", async () => {
    let now = 1_000_000;
    const { repo, getUpdateCount, getLastHeartbeat } = createMockRepo(now);
    const service = new AgentService(repo, () => now);

    // Only 10s elapsed since last heartbeat (far below 65s throttle)
    now += 10_000;

    // But printer status changed (e.g. Paper Jam detected) -> reportPrinters = true
    await service.heartbeat(
      "secret",
      {
        agentVersion: "2.0.0",
        operationalState: "ONLINE",
        printers: [
          {
            windowsPrinterName: "HP_Laser",
            displayName: "HP LaserJet",
            isDefault: true,
            status: "BLOCKED",
            statusReason: "Tray 2 jammed",
            capabilities: { colour: false, duplex: true, paperSizes: ["A4"] },
            isProductionEligible: true,
            isVirtual: false,
            portName: null,
            driverName: null,
          },
        ],
      },
      true,
    );

    // Must write immediately despite <65s interval
    expect(getUpdateCount()).toBe(1);
    expect(getLastHeartbeat()).toBe(now);
  });
});
