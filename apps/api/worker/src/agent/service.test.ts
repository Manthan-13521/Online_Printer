/* eslint-disable @typescript-eslint/unbound-method -- Vitest inspects method mocks without invoking them. */

import { describe, expect, it, vi } from "vitest";

import { AGENT_PAIR_CODE_LIFETIME_MS } from "@printgo/domain";
import type { AgentRepository } from "./repository";
import { AgentService } from "./service";

function createMockRepository(
  overrides?: Partial<AgentRepository>,
): AgentRepository {
  return {
    createPairCode: vi.fn(() => Promise.resolve()),
    findPairCode: vi.fn(),
    consumePairCodeAndCreateAgent: vi.fn(() => Promise.resolve(true)),
    findAgentByCredentialHash: vi.fn(),
    findAgentById: vi.fn(),
    updateHeartbeat: vi.fn(() => Promise.resolve()),
    listAgentsWithPrinters: vi.fn(() => Promise.resolve([])),
    revokeAgent: vi.fn(() => Promise.resolve(true)),
    togglePrinter: vi.fn(() => Promise.resolve(true)),
    findPrinterById: vi.fn(),
    createTestPrintCommand: vi.fn(),
    claimPendingTestPrintCommand: vi.fn(() => Promise.resolve(null)),
    reportTestPrintCommand: vi.fn(() => Promise.resolve(true)),
    getLatestTestPrintCommand: vi.fn(() => Promise.resolve(null)),
    setDefaultProductionPrinter: vi.fn(),
    getDefaultProductionPrinterId: vi.fn(() => Promise.resolve(null)),
    ...overrides,
  };
}

describe("AgentService", () => {
  it("creates a pair code with a 10-minute lifetime", async () => {
    const repo = createMockRepository();
    const service = new AgentService(repo, () => 1_000_000);

    const result = await service.createPairCode();
    expect(result.pairCode).toMatch(
      /^[0-9A-HJ-KM-NP-TV-Z]{4}-[0-9A-HJ-KM-NP-TV-Z]{4}$/,
    );
    expect(new Date(result.expiresAt).getTime()).toBe(
      1_000_000 + AGENT_PAIR_CODE_LIFETIME_MS,
    );
    expect(repo.createPairCode).toHaveBeenCalledOnce();
  });

  it("pairs an agent successfully with an active code", async () => {
    const repo = createMockRepository({
      findPairCode: vi.fn(() =>
        Promise.resolve({
          id: "pair_1",
          codeHash: "hash",
          expiresAtMs: 2_000_000,
          usedAtMs: null,
          pairedAgentId: null,
        }),
      ),
      consumePairCodeAndCreateAgent: vi.fn(() => Promise.resolve(true)),
    });

    const service = new AgentService(repo, () => 1_500_000);
    const result = await service.pair({
      pairCode: "abcd-efgh",
      displayName: "Front Desk PC",
    });

    expect(result.agentId).toBeDefined();
    expect(result.displayName).toBe("Front Desk PC");
    expect(result.agentSecret).toBeDefined();
    expect(repo.consumePairCodeAndCreateAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: result.agentId,
        displayName: "Front Desk PC",
      }),
    );
  });

  it("rejects pairing when the pair code is expired", async () => {
    const repo = createMockRepository({
      findPairCode: vi.fn(() =>
        Promise.resolve({
          id: "pair_1",
          codeHash: "hash",
          expiresAtMs: 1_000_000, // expired
          usedAtMs: null,
          pairedAgentId: null,
        }),
      ),
    });

    const service = new AgentService(repo, () => 1_500_000);
    await expect(
      service.pair({ pairCode: "ABCD-EFGH", displayName: "Test PC" }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "PAIR_CODE_EXPIRED",
      }),
    );
  });

  it("rejects pairing when the pair code was already used", async () => {
    const repo = createMockRepository({
      findPairCode: vi.fn(() =>
        Promise.resolve({
          id: "pair_1",
          codeHash: "hash",
          expiresAtMs: 2_000_000,
          usedAtMs: 1_200_000, // already used
          pairedAgentId: "agent_prev",
        }),
      ),
    });

    const service = new AgentService(repo, () => 1_500_000);
    await expect(
      service.pair({ pairCode: "ABCD-EFGH", displayName: "Test PC" }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "PAIR_CODE_ALREADY_USED",
      }),
    );
  });

  it("accepts a heartbeat from an active agent and reports acknowledgement", async () => {
    const repo = createMockRepository({
      findAgentByCredentialHash: vi.fn(() =>
        Promise.resolve({
          id: "agent_123",
          displayName: "Front Desk PC",
          isActive: true,
          lastHeartbeatAtMs: 1_000_000,
        }),
      ),
      updateHeartbeat: vi.fn(() => Promise.resolve()),
    });

    const service = new AgentService(repo, () => 1_500_000);
    const result = await service.heartbeat("valid_secret", {
      agentVersion: "2.0.0",
      operationalState: "ONLINE",
      printers: [
        {
          windowsPrinterName: "Canon_MF4700",
          displayName: "Front Desk Canon",
          isDefault: true,
          status: "ONLINE",
          statusReason: null,
          capabilities: {
            colour: false,
            duplex: true,
            paperSizes: ["A4"],
          },
          isProductionEligible: true,
          isVirtual: false,
          portName: null,
          driverName: null,
        },
      ],
    });

    expect(result.acknowledged).toBe(true);
    expect(result.serverTimeMs).toBe(1_500_000);
    expect(result.nextCommand).toBeUndefined();
    expect(repo.updateHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent_123",
        nowMs: 1_500_000,
      }),
    );
  });

  it("heartbeat delivers pending test print command via nextCommand", async () => {
    const repo = createMockRepository({
      findAgentByCredentialHash: vi.fn(() =>
        Promise.resolve({
          id: "agent_123",
          displayName: "Front Desk PC",
          isActive: true,
          lastHeartbeatAtMs: 1_000_000,
        }),
      ),
      claimPendingTestPrintCommand: vi.fn(() =>
        Promise.resolve({
          commandId: "cmd-test-1",
          type: "TEST_PRINT" as const,
          printerId: "printer-1",
          windowsPrinterName: "Canon_MF4700",
          printerDisplayName: "Front Desk Canon",
          shopName: "Central Xerox Shop",
          expiresAtMs: 1_800_000,
        }),
      ),
    });

    const service = new AgentService(repo, () => 1_500_000);
    const result = await service.heartbeat("valid_secret", {
      agentVersion: "2.0.0",
      operationalState: "ONLINE",
      printers: [],
    });

    expect(result.acknowledged).toBe(true);
    expect(result.nextCommand).toEqual({
      commandId: "cmd-test-1",
      type: "TEST_PRINT",
      printerId: "printer-1",
      windowsPrinterName: "Canon_MF4700",
      printerDisplayName: "Front Desk Canon",
      shopName: "Central Xerox Shop",
      expiresAtMs: 1_800_000,
    });
  });

  it("rejects heartbeat from an inactive / revoked agent", async () => {
    const repo = createMockRepository({
      findAgentByCredentialHash: vi.fn(() =>
        Promise.resolve({
          id: "agent_123",
          displayName: "Front Desk PC",
          isActive: false, // inactive / revoked
          lastHeartbeatAtMs: 1_000_000,
        }),
      ),
    });

    const service = new AgentService(repo, () => 1_500_000);
    await expect(
      service.heartbeat("secret", {
        agentVersion: "2.0.0",
        operationalState: "ONLINE",
        printers: [],
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "AGENT_UNAUTHORIZED",
      }),
    );
  });

  it("revokes an agent and logs audit event", async () => {
    const repo = createMockRepository();
    const service = new AgentService(repo, () => 1_500_000);

    await service.revokeAgent("agent_123", "admin_1");
    expect(repo.revokeAgent).toHaveBeenCalledWith({
      agentId: "agent_123",
      adminId: "admin_1",
      nowMs: 1_500_000,
    });
  });

  it("returns true (idempotent) when revoking an already-revoked agent", async () => {
    const repo = createMockRepository({
      revokeAgent: vi.fn(() => Promise.resolve(true)),
    });
    const service = new AgentService(repo, () => 1_500_000);

    // Should not throw — idempotent revoke returns true
    const result = await service.revokeAgent("agent_123", "admin_1");
    expect(result).toBe(true);
  });

  it("throws AGENT_NOT_FOUND when revoking a non-existent agent", async () => {
    const repo = createMockRepository({
      revokeAgent: vi.fn(() => Promise.resolve(false)),
    });
    const service = new AgentService(repo, () => 1_500_000);

    await expect(service.revokeAgent("nonexistent", "admin_1")).rejects.toEqual(
      expect.objectContaining({ code: "AGENT_NOT_FOUND" }),
    );
  });

  it("toggles printer status and logs audit event", async () => {
    const repo = createMockRepository();
    const service = new AgentService(repo, () => 1_500_000);

    await service.togglePrinter("printer_1", false, "admin_1");
    expect(repo.togglePrinter).toHaveBeenCalledWith({
      printerId: "printer_1",
      enabled: false,
      adminId: "admin_1",
      nowMs: 1_500_000,
    });
  });

  it("requests test print for an enabled printer on an active and online agent", async () => {
    const repo = createMockRepository({
      findPrinterById: vi.fn(() =>
        Promise.resolve({
          id: "printer_1",
          agentId: "agent_123",
          displayName: "Front Desk Canon",
          windowsPrinterName: "Canon_MF4700",
          enabled: true,
          status: "ONLINE",
          isProductionEligible: true,
          isVirtual: false,
        }),
      ),
      findAgentById: vi.fn(() =>
        Promise.resolve({
          id: "agent_123",
          displayName: "Front Desk PC",
          isActive: true,
          lastHeartbeatAtMs: 1_500_000 - 5_000, // 5s ago, well within 30s
        }),
      ),
      createTestPrintCommand: vi.fn(
        (input: Parameters<AgentRepository["createTestPrintCommand"]>[0]) =>
          Promise.resolve({
            commandId: input.id,
            printerId: input.printerId,
            agentId: input.agentId,
            status: "PENDING" as const,
            spoolerJobId: null,
            failureCode: null,
            failureDetail: null,
            createdAt: new Date(input.nowMs).toISOString(),
            expiresAt: new Date(input.expiresAtMs).toISOString(),
            claimedAt: null,
            finishedAt: null,
          }),
      ),
    });

    const service = new AgentService(repo, () => 1_500_000);
    const result = await service.requestTestPrint("printer_1", "admin_100");

    expect(result.status).toBe("PENDING");
    expect(result.printerId).toBe("printer_1");
    expect(result.agentId).toBe("agent_123");
    expect(repo.createTestPrintCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        printerId: "printer_1",
        agentId: "agent_123",
        adminId: "admin_100",
        nowMs: 1_500_000,
        expiresAtMs: 1_500_000 + 300_000, // 5 minutes
      }),
    );
  });

  it("reuses an active test-print command instead of scheduling a duplicate", async () => {
    const activeCommand = {
      commandId: "existing-command",
      printerId: "printer_1",
      agentId: "agent_123",
      status: "SUBMITTED" as const,
      spoolerJobId: "42",
      failureCode: null,
      failureDetail: null,
      createdAt: new Date(1_400_000).toISOString(),
      expiresAt: new Date(1_800_000).toISOString(),
      claimedAt: new Date(1_450_000).toISOString(),
      finishedAt: null,
    };
    const repo = createMockRepository({
      findPrinterById: vi.fn(() =>
        Promise.resolve({
          id: "printer_1",
          agentId: "agent_123",
          displayName: "Canon",
          windowsPrinterName: "Canon",
          enabled: true,
          status: "ONLINE",
          isProductionEligible: true,
          isVirtual: false,
        }),
      ),
      findAgentById: vi.fn(() =>
        Promise.resolve({
          id: "agent_123",
          displayName: "Front Desk PC",
          isActive: true,
          lastHeartbeatAtMs: 1_495_000,
        }),
      ),
      getLatestTestPrintCommand: vi.fn(() => Promise.resolve(activeCommand)),
    });

    const service = new AgentService(repo, () => 1_500_000);
    await expect(
      service.requestTestPrint("printer_1", "admin_1"),
    ).resolves.toEqual(activeCommand);
    expect(repo.createTestPrintCommand).not.toHaveBeenCalled();
  });

  it("rejects test print request when printer is not found", async () => {
    const repo = createMockRepository({
      findPrinterById: vi.fn(() => Promise.resolve(null)),
    });
    const service = new AgentService(repo, () => 1_500_000);

    await expect(
      service.requestTestPrint("printer_missing", "admin_1"),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "PRINTER_NOT_FOUND",
      }),
    );
  });

  it("rejects test print request when printer is disabled", async () => {
    const repo = createMockRepository({
      findPrinterById: vi.fn(() =>
        Promise.resolve({
          id: "printer_1",
          agentId: "agent_123",
          displayName: "Canon",
          windowsPrinterName: "Canon",
          enabled: false,
          status: "ONLINE",
          isProductionEligible: true,
          isVirtual: false,
        }),
      ),
    });
    const service = new AgentService(repo, () => 1_500_000);

    await expect(
      service.requestTestPrint("printer_1", "admin_1"),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "PRINTER_DISABLED",
      }),
    );
  });

  it("rejects test print request when agent is offline", async () => {
    const repo = createMockRepository({
      findPrinterById: vi.fn(() =>
        Promise.resolve({
          id: "printer_1",
          agentId: "agent_123",
          displayName: "Canon",
          windowsPrinterName: "Canon",
          enabled: true,
          status: "ONLINE",
          isProductionEligible: true,
          isVirtual: false,
        }),
      ),
      findAgentById: vi.fn(() =>
        Promise.resolve({
          id: "agent_123",
          displayName: "Front Desk PC",
          isActive: true,
          lastHeartbeatAtMs: 1_500_000 - 100_000, // 100s ago (> 90s timeout)
        }),
      ),
    });
    const service = new AgentService(repo, () => 1_500_000);

    await expect(
      service.requestTestPrint("printer_1", "admin_1"),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "AGENT_OFFLINE",
      }),
    );
  });

  it("reports command status from authenticated agent", async () => {
    const repo = createMockRepository({
      findAgentByCredentialHash: vi.fn(() =>
        Promise.resolve({
          id: "agent_123",
          displayName: "Front Desk PC",
          isActive: true,
          lastHeartbeatAtMs: 1_000_000,
        }),
      ),
      reportTestPrintCommand: vi.fn(() => Promise.resolve(true)),
    });

    const service = new AgentService(repo, () => 1_500_000);
    const result = await service.reportCommand("valid_secret", "cmd-1", {
      status: "SUBMITTED",
      spoolerJobId: "spool-42",
      failureCode: null,
      failureDetail: null,
    });

    expect(result).toEqual({
      acknowledged: true,
      commandId: "cmd-1",
      status: "SUBMITTED",
    });
    expect(repo.reportTestPrintCommand).toHaveBeenCalledWith({
      commandId: "cmd-1",
      agentId: "agent_123",
      status: "SUBMITTED",
      spoolerJobId: "spool-42",
      failureCode: null,
      failureDetail: null,
      nowMs: 1_500_000,
    });
  });

  it("reports command status with BLOCKED and preserves failure code", async () => {
    const repo = createMockRepository({
      findAgentByCredentialHash: vi.fn(() =>
        Promise.resolve({
          id: "agent_123",
          displayName: "Front Desk PC",
          isActive: true,
          lastHeartbeatAtMs: 1_000_000,
        }),
      ),
      reportTestPrintCommand: vi.fn(() => Promise.resolve(true)),
    });

    const service = new AgentService(repo, () => 1_500_000);
    const result = await service.reportCommand("valid_secret", "cmd-1", {
      status: "BLOCKED",
      spoolerJobId: "spool-42",
      failureCode: "PAPER_OUT",
      failureDetail: "Printer tray 1 is out of paper",
    });

    expect(result).toEqual({
      acknowledged: true,
      commandId: "cmd-1",
      status: "BLOCKED",
    });
    expect(repo.reportTestPrintCommand).toHaveBeenCalledWith({
      commandId: "cmd-1",
      agentId: "agent_123",
      status: "BLOCKED",
      spoolerJobId: "spool-42",
      failureCode: "PAPER_OUT",
      failureDetail: "Printer tray 1 is out of paper",
      nowMs: 1_500_000,
    });
  });

  it("rejects command report for unknown command id", async () => {
    const repo = createMockRepository({
      findAgentByCredentialHash: vi.fn(() =>
        Promise.resolve({
          id: "agent_123",
          displayName: "Front Desk PC",
          isActive: true,
          lastHeartbeatAtMs: 1_000_000,
        }),
      ),
      reportTestPrintCommand: vi.fn(() => Promise.resolve(false)),
    });

    const service = new AgentService(repo, () => 1_500_000);
    await expect(
      service.reportCommand("valid_secret", "cmd-missing", {
        status: "SUCCEEDED",
        spoolerJobId: null,
        failureCode: null,
        failureDetail: null,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "COMMAND_NOT_FOUND",
      }),
    );
  });
});
