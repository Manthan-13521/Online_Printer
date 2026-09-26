/* eslint-disable @typescript-eslint/unbound-method -- Vitest inspects method mocks without invoking them. */

import { describe, expect, it, vi } from "vitest";

import type { WorkerEnv } from "../env";
import { handleAgentRequest } from "./routes";
import { AgentError, type AgentPairInput, type AgentService } from "./service";

function createMockService(): AgentService {
  return {
    createPairCode: vi.fn(),
    pair: vi.fn((input: AgentPairInput) =>
      Promise.resolve({
        agentId: "agent_abc",
        agentSecret: "secret_123456789012345678901234567890",
        displayName: input.displayName,
      }),
    ),
    heartbeat: vi.fn(() =>
      Promise.resolve({
        acknowledged: true as const,
        serverTimeMs: 1_234_567_890,
      }),
    ),
    listAgentsWithPrinters: vi.fn(),
    revokeAgent: vi.fn(),
    togglePrinter: vi.fn(),
    reportCommand: vi.fn(() =>
      Promise.resolve({
        acknowledged: true as const,
        commandId: "cmd-1",
        status: "SUBMITTED" as const,
      }),
    ),
  } as unknown as AgentService;
}

const env = {
  APP_ENV: "production",
} as WorkerEnv;

describe("Agent HTTP Routes", () => {
  it("handles valid agent pairing request", async () => {
    const service = createMockService();
    const request = new Request("https://api.example.com/api/agent/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairCode: "ABCD-EFGH",
        displayName: "Front Desk PC",
      }),
    });

    const response = await handleAgentRequest(request, env, service);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      ok: true,
      data: {
        agentId: "agent_abc",
        agentSecret: "secret_123456789012345678901234567890",
        displayName: "Front Desk PC",
      },
    });
  });

  it("returns 400 on validation error for agent pairing", async () => {
    const service = createMockService();
    const request = new Request("https://api.example.com/api/agent/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairCode: "", // invalid empty code
        displayName: "Front Desk PC",
      }),
    });

    const response = await handleAgentRequest(request, env, service);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    });
  });

  it("returns 400 when pair code is expired", async () => {
    const service = createMockService();
    vi.mocked(service.pair).mockRejectedValueOnce(
      new AgentError("PAIR_CODE_EXPIRED"),
    );

    const request = new Request("https://api.example.com/api/agent/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairCode: "ABCD-EFGH",
        displayName: "Front Desk PC",
      }),
    });

    const response = await handleAgentRequest(request, env, service);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "PAIR_CODE_EXPIRED" },
    });
  });

  it("handles valid agent heartbeat", async () => {
    const service = createMockService();
    const request = new Request("https://api.example.com/api/agent/heartbeat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer secret_123456789012345678901234567890",
      },
      body: JSON.stringify({
        agentVersion: "2.0.0",
        operationalState: "ONLINE",
        printers: [
          {
            windowsPrinterName: "Canon_MF4700",
            displayName: "Front Desk Canon",
            status: "ONLINE",
          },
        ],
      }),
    });

    const response = await handleAgentRequest(request, env, service);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      data: {
        acknowledged: true,
        serverTimeMs: 1_234_567_890,
      },
    });
  });

  it("returns 401 when Authorization header is missing on heartbeat", async () => {
    const service = createMockService();
    const request = new Request("https://api.example.com/api/agent/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentVersion: "2.0.0",
        operationalState: "ONLINE",
        printers: [],
      }),
    });

    const response = await handleAgentRequest(request, env, service);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "AGENT_UNAUTHORIZED" },
    });
  });

  it("returns 401 when agent token is revoked or unrecognized", async () => {
    const service = createMockService();
    vi.mocked(service.heartbeat).mockRejectedValueOnce(
      new AgentError("AGENT_UNAUTHORIZED"),
    );

    const request = new Request("https://api.example.com/api/agent/heartbeat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer secret_123456789012345678901234567890",
      },
      body: JSON.stringify({
        agentVersion: "2.0.0",
        operationalState: "ONLINE",
        printers: [],
      }),
    });

    const response = await handleAgentRequest(request, env, service);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "AGENT_UNAUTHORIZED" },
    });
  });

  it("handles valid command report from agent", async () => {
    const service = createMockService();
    const request = new Request(
      "https://api.example.com/api/agent/commands/cmd-123/report",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer secret_123456789012345678901234567890",
        },
        body: JSON.stringify({
          status: "SUBMITTED",
          spoolerJobId: "spool-42",
        }),
      },
    );

    const response = await handleAgentRequest(request, env, service);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      data: {
        acknowledged: true,
        commandId: "cmd-1",
        status: "SUBMITTED",
      },
    });
    expect(service.reportCommand).toHaveBeenCalledWith(
      "secret_123456789012345678901234567890",
      "cmd-123",
      expect.objectContaining({
        status: "SUBMITTED",
        spoolerJobId: "spool-42",
      }),
    );
  });

  it("returns 401 when Authorization header is missing on command report", async () => {
    const service = createMockService();
    const request = new Request(
      "https://api.example.com/api/agent/commands/cmd-123/report",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          status: "SUBMITTED",
        }),
      },
    );

    const response = await handleAgentRequest(request, env, service);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "AGENT_UNAUTHORIZED" },
    });
  });

  it("returns 400 on validation error for command report", async () => {
    const service = createMockService();
    const request = new Request(
      "https://api.example.com/api/agent/commands/cmd-123/report",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer secret_123456789012345678901234567890",
        },
        body: JSON.stringify({
          status: "INVALID_STATUS",
        }),
      },
    );

    const response = await handleAgentRequest(request, env, service);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    });
  });

  it("returns 404 when command is not found", async () => {
    const service = createMockService();
    vi.mocked(service.reportCommand).mockRejectedValueOnce(
      new AgentError("COMMAND_NOT_FOUND"),
    );

    const request = new Request(
      "https://api.example.com/api/agent/commands/cmd-missing/report",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer secret_123456789012345678901234567890",
        },
        body: JSON.stringify({
          status: "FAILED",
          failureCode: "PRINTER_ERROR",
        }),
      },
    );

    const response = await handleAgentRequest(request, env, service);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "COMMAND_NOT_FOUND" },
    });
  });
});
