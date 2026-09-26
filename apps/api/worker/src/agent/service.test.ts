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
    updateHeartbeat: vi.fn(() => Promise.resolve()),
    listAgentsWithPrinters: vi.fn(() => Promise.resolve([])),
    revokeAgent: vi.fn(() => Promise.resolve(true)),
    togglePrinter: vi.fn(() => Promise.resolve(true)),
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
        },
      ],
    });

    expect(result.acknowledged).toBe(true);
    expect(result.serverTimeMs).toBe(1_500_000);
    expect(repo.updateHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent_123",
        nowMs: 1_500_000,
      }),
    );
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
});
