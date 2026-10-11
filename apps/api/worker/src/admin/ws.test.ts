import { describe, expect, it, vi } from "vitest";
import { handleAdminWebSocket } from "./ws";
import type { WorkerEnv } from "../env";
import type {
  D1Database,
  DurableObjectId,
  DurableObjectNamespace,
} from "@cloudflare/workers-types";

describe("handleAdminWebSocket", () => {
  function makeMockEnv(authPass = true): WorkerEnv {
    const mockDb = {
      prepare: () => ({
        bind: () => ({
          first: () =>
            authPass
              ? Promise.resolve({
                  id: "sess-1",
                  token_hash: "hash-1",
                  admin_id: "admin-1",
                  expires_at_ms: Date.now() + 60000,
                  revoked_at_ms: null,
                  created_at_ms: Date.now(),
                  login_identifier: "admin",
                  is_active: 1,
                })
              : Promise.resolve(null),
        }),
      }),
    } as unknown as D1Database;

    const mockAgentRoom = {
      idFromName: vi.fn(() => "mock-room-id" as unknown as DurableObjectId),
      get: vi.fn(() => ({
        fetch: vi.fn(() =>
          Promise.resolve({ status: 101 } as unknown as Response),
        ),
      })),
    } as unknown as DurableObjectNamespace;

    return {
      APP_ENV: "development",
      ADMIN_ALLOWED_ORIGIN: "https://printgo-admin.pages.dev",
      DB: mockDb,
      AGENT_ROOM: mockAgentRoom,
    } as unknown as WorkerEnv;
  }

  it("rejects connection with 401 if no admin credentials provided", async () => {
    const env = makeMockEnv();
    const req = new Request("https://api.printgo.dev/api/admin/ws");
    const res = await handleAdminWebSocket(req, env);
    expect(res.status).toBe(401);
    const body: { error: { code: string } } = await res.json();
    expect(body.error.code).toBe("ADMIN_UNAUTHORIZED");
  });

  it("rejects connection with 401 if token is invalid or expired", async () => {
    const env = makeMockEnv(false);
    const req = new Request(
      "https://api.printgo.dev/api/admin/ws?token=invalid-token",
    );
    const res = await handleAdminWebSocket(req, env);
    expect(res.status).toBe(401);
  });

  it("accepts WebSocket connection when valid session token provided", async () => {
    const env = makeMockEnv(true);
    const req = new Request(
      "https://api.printgo.dev/api/admin/ws?token=valid-admin-token",
      {
        headers: {
          Upgrade: "websocket",
        },
      },
    );
    const res = await handleAdminWebSocket(req, env);
    expect(res.status).toBe(101);
  });
});
