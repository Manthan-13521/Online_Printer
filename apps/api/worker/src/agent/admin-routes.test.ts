/* eslint-disable @typescript-eslint/unbound-method -- Vitest inspects method mocks without invoking them. */

import { describe, expect, it, vi } from "vitest";

import type { AdminAuthService } from "../auth/service";
import type { WorkerEnv } from "../env";
import { handleAdminPrinterRequest } from "./admin-routes";
import { AgentError, type AgentService } from "./service";

const admin = {
  id: "admin_100",
  loginIdentifier: "admin",
};

const session = {
  sessionId: "session_100",
  admin,
  tokenHash: "hash_100",
};

function createMockAuth(): AdminAuthService {
  return {
    requireSession: vi.fn(() => Promise.resolve(session)),
  } as unknown as AdminAuthService;
}

function createMockAgentService(): AgentService {
  return {
    createPairCode: vi.fn(() =>
      Promise.resolve({
        pairCode: "ABCD-EFGH",
        expiresAt: "2026-09-26T12:00:00.000Z",
      }),
    ),
    listAgentsWithPrinters: vi.fn(() =>
      Promise.resolve([
        {
          id: "agent_1",
          displayName: "Front Desk PC",
          isActive: true,
          isOnline: true,
          pairedAt: "2026-09-26T11:00:00.000Z",
          lastHeartbeatAt: "2026-09-26T11:59:00.000Z",
          printers: [
            {
              id: "printer_1",
              agentId: "agent_1",
              displayName: "Canon MF4700",
              windowsPrinterName: "Canon_MF4700",
              enabled: true,
              status: "ONLINE" as const,
              statusReason: null,
              capabilities: {
                colour: false,
                duplex: true,
                paperSizes: ["A4"],
              },
              lastStatusAt: "2026-09-26T11:59:00.000Z",
            },
          ],
        },
      ]),
    ),
    revokeAgent: vi.fn(() => Promise.resolve()),
    togglePrinter: vi.fn(() => Promise.resolve()),
    requestTestPrint: vi.fn(() =>
      Promise.resolve({
        commandId: "cmd-test-1",
        printerId: "printer_1",
        agentId: "agent_1",
        status: "PENDING" as const,
        spoolerJobId: null,
        failureCode: null,
        failureDetail: null,
        createdAt: "2026-09-26T12:00:00.000Z",
        expiresAt: "2026-09-26T12:05:00.000Z",
        claimedAt: null,
        finishedAt: null,
      }),
    ),
    getLatestTestPrint: vi.fn(() =>
      Promise.resolve({
        commandId: "cmd-test-1",
        printerId: "printer_1",
        agentId: "agent_1",
        status: "SUCCEEDED" as const,
        spoolerJobId: "spool-12",
        failureCode: null,
        failureDetail: null,
        createdAt: "2026-09-26T12:00:00.000Z",
        expiresAt: "2026-09-26T12:05:00.000Z",
        claimedAt: "2026-09-26T12:00:10.000Z",
        finishedAt: "2026-09-26T12:00:15.000Z",
      }),
    ),
  } as unknown as AgentService;
}

const env = {
  APP_ENV: "production",
  ADMIN_ALLOWED_ORIGIN: "https://admin.example.com",
} as WorkerEnv;

describe("Admin Printer & Agent HTTP Routes", () => {
  it("generates a new pair code", async () => {
    const authService = createMockAuth();
    const agentService = createMockAgentService();

    const request = new Request(
      "https://api.example.com/api/admin/agents/pair-code",
      {
        method: "POST",
        headers: {
          Origin: env.ADMIN_ALLOWED_ORIGIN,
          Cookie: "__Host-printgo_admin=valid_token",
        },
      },
    );

    const response = await handleAdminPrinterRequest(
      request,
      env,
      agentService,
      authService,
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      ok: true,
      data: {
        pairCode: "ABCD-EFGH",
        expiresAt: "2026-09-26T12:00:00.000Z",
      },
    });
  });

  it("lists agents and printers", async () => {
    const authService = createMockAuth();
    const agentService = createMockAgentService();

    const request = new Request("https://api.example.com/api/admin/printers", {
      method: "GET",
      headers: {
        Origin: env.ADMIN_ALLOWED_ORIGIN,
        Cookie: "__Host-printgo_admin=valid_token",
      },
    });

    const response = await handleAdminPrinterRequest(
      request,
      env,
      agentService,
      authService,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      data: {
        agents: [
          {
            displayName: "Front Desk PC",
            printers: [
              {
                id: "printer_1",
                displayName: "Canon MF4700",
              },
            ],
          },
        ],
      },
    });
  });

  it("revokes an agent", async () => {
    const authService = createMockAuth();
    const agentService = createMockAgentService();

    const request = new Request(
      "https://api.example.com/api/admin/agents/agent_1/revoke",
      {
        method: "POST",
        headers: {
          Origin: env.ADMIN_ALLOWED_ORIGIN,
          Cookie: "__Host-printgo_admin=valid_token",
        },
      },
    );

    const response = await handleAdminPrinterRequest(
      request,
      env,
      agentService,
      authService,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      data: {
        revoked: true,
      },
    });
    expect(agentService.revokeAgent).toHaveBeenCalledWith(
      "agent_1",
      "admin_100",
    );
  });

  it("toggles printer enabled status", async () => {
    const authService = createMockAuth();
    const agentService = createMockAgentService();

    const request = new Request(
      "https://api.example.com/api/admin/printers/printer_1",
      {
        method: "PUT",
        headers: {
          Origin: env.ADMIN_ALLOWED_ORIGIN,
          Cookie: "__Host-printgo_admin=valid_token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ enabled: false }),
      },
    );

    const response = await handleAdminPrinterRequest(
      request,
      env,
      agentService,
      authService,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      data: {
        id: "printer_1",
        enabled: false,
      },
    });
    expect(agentService.togglePrinter).toHaveBeenCalledWith(
      "printer_1",
      false,
      "admin_100",
    );
  });

  it("handles test print request", async () => {
    const authService = createMockAuth();
    const agentService = createMockAgentService();

    const request = new Request(
      "https://api.example.com/api/admin/printers/printer_1/test-print",
      {
        method: "POST",
        headers: {
          Origin: env.ADMIN_ALLOWED_ORIGIN,
          Cookie: "__Host-printgo_admin=valid_token",
        },
      },
    );

    const response = await handleAdminPrinterRequest(
      request,
      env,
      agentService,
      authService,
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      ok: true,
      data: {
        testPrint: {
          commandId: "cmd-test-1",
          printerId: "printer_1",
          status: "PENDING",
        },
      },
    });
    expect(agentService.requestTestPrint).toHaveBeenCalledWith(
      "printer_1",
      "admin_100",
    );
  });

  it("handles get latest test print status", async () => {
    const authService = createMockAuth();
    const agentService = createMockAgentService();

    const request = new Request(
      "https://api.example.com/api/admin/printers/printer_1/test-print",
      {
        method: "GET",
        headers: {
          Origin: env.ADMIN_ALLOWED_ORIGIN,
          Cookie: "__Host-printgo_admin=valid_token",
        },
      },
    );

    const response = await handleAdminPrinterRequest(
      request,
      env,
      agentService,
      authService,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      data: {
        testPrint: {
          commandId: "cmd-test-1",
          printerId: "printer_1",
          status: "SUCCEEDED",
          spoolerJobId: "spool-12",
        },
      },
    });
    expect(agentService.getLatestTestPrint).toHaveBeenCalledWith("printer_1");
  });

  it("returns 400 when test print is requested on disabled printer", async () => {
    const authService = createMockAuth();
    const agentService = createMockAgentService();
    vi.mocked(agentService.requestTestPrint).mockRejectedValueOnce(
      new AgentError("PRINTER_DISABLED"),
    );

    const request = new Request(
      "https://api.example.com/api/admin/printers/printer_1/test-print",
      {
        method: "POST",
        headers: {
          Origin: env.ADMIN_ALLOWED_ORIGIN,
          Cookie: "__Host-printgo_admin=valid_token",
        },
      },
    );

    const response = await handleAdminPrinterRequest(
      request,
      env,
      agentService,
      authService,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "PRINTER_DISABLED" },
    });
  });

  it("returns 400 when test print is requested for offline agent", async () => {
    const authService = createMockAuth();
    const agentService = createMockAgentService();
    vi.mocked(agentService.requestTestPrint).mockRejectedValueOnce(
      new AgentError("AGENT_OFFLINE"),
    );

    const request = new Request(
      "https://api.example.com/api/admin/printers/printer_1/test-print",
      {
        method: "POST",
        headers: {
          Origin: env.ADMIN_ALLOWED_ORIGIN,
          Cookie: "__Host-printgo_admin=valid_token",
        },
      },
    );

    const response = await handleAdminPrinterRequest(
      request,
      env,
      agentService,
      authService,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "AGENT_OFFLINE" },
    });
  });
});
