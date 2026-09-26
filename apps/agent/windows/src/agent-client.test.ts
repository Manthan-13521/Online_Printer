import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentApiError, AgentAuthError, AgentClient } from "./agent-client";

function mockResponse(status: number, ok: boolean, body: unknown): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe("AgentClient", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("pairs successfully with server", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      mockResponse(201, true, {
        ok: true,
        data: {
          agentId: "agent_99",
          agentSecret: "secret_abc",
          displayName: "Shop PC 1",
        },
      }),
    );

    const client = new AgentClient();
    const result = await client.pair(
      "https://api.printgo.shop",
      "ABCD-EFGH",
      "Shop PC 1",
    );

    expect(result).toEqual({
      agentId: "agent_99",
      agentSecret: "secret_abc",
      displayName: "Shop PC 1",
    });
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.printgo.shop/api/agent/pair",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          pairCode: "ABCD-EFGH",
          displayName: "Shop PC 1",
        }),
      }),
    );
  });

  it("throws AgentApiError on pairing failure", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      mockResponse(400, false, {
        ok: false,
        error: {
          code: "PAIR_CODE_EXPIRED",
          message: "The pairing code has expired.",
        },
      }),
    );

    const client = new AgentClient();
    await expect(
      client.pair("https://api.printgo.shop", "EXPD-CODE", "Shop PC"),
    ).rejects.toThrow(AgentApiError);
  });

  it("sends heartbeat with auth headers", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      mockResponse(200, true, {
        ok: true,
        data: { acknowledged: true, serverTimeMs: 1_234_567_890 },
      }),
    );

    const client = new AgentClient();
    const result = await client.sendHeartbeat(
      "https://api.printgo.shop",
      "agent_99",
      "secret_abc",
      {
        agentVersion: "2.0.0",
        operationalState: "ONLINE",
        printers: [],
      },
    );

    expect(result).toEqual({
      acknowledged: true,
      serverTimeMs: 1_234_567_890,
    });
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.printgo.shop/api/agent/heartbeat",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer secret_abc",
          "X-PrintGo-Agent-Id": "agent_99",
        },
      }),
    );
  });

  it("throws AgentAuthError on 401 unauthorized", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      mockResponse(401, false, {
        ok: false,
        error: { code: "AGENT_UNAUTHORIZED", message: "Revoked" },
      }),
    );

    const client = new AgentClient();
    await expect(
      client.sendHeartbeat(
        "https://api.printgo.shop",
        "agent_99",
        "secret_abc",
        {
          agentVersion: "2.0.0",
          operationalState: "ONLINE",
          printers: [],
        },
      ),
    ).rejects.toThrow(AgentAuthError);
  });
});
