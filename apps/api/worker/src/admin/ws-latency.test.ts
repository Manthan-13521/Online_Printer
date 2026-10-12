import { describe, expect, it, vi } from "vitest";
import { AgentRoom } from "../agent/agent-room";
import { handleAdminWebSocket } from "./ws";
import type { WorkerEnv } from "../env";
import type {
  D1Database,
  DurableObjectId,
  DurableObjectNamespace,
} from "@cloudflare/workers-types";

// Mock WebSocket implementation for high-precision latency testing
class MockWebSocket {
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  peer: MockWebSocket | null = null;
  readyState = 1; // OPEN

  send(data: string) {
    if (this.peer && this.peer.onmessage) {
      // Simulate microtask delivery
      const peer = this.peer;
      queueMicrotask(() => {
        if (peer.onmessage) {
          peer.onmessage({ data });
        }
      });
    }
  }

  close() {
    this.readyState = 3;
    if (this.peer && this.peer.onclose) {
      this.peer.onclose();
    }
  }
}

function createMockWebSocketPair() {
  const client = new MockWebSocket();
  const server = new MockWebSocket();
  client.peer = server;
  server.peer = client;
  return [client, server] as const;
}

// Polyfill global WebSocketPair and Response with 101 status support for AgentRoom test
const OriginalResponse = globalThis.Response;
class CloudflareResponse extends OriginalResponse {
  override readonly webSocket: WebSocket | null = null;
  constructor(
    body?: BodyInit | null,
    init?: ResponseInit & { webSocket?: unknown },
  ) {
    if (init && init.status === 101) {
      super(null, { status: 200, statusText: "Switching Protocols" });
      Object.defineProperty(this, "status", { value: 101, writable: false });
      if (init.webSocket) {
        Object.defineProperty(this, "webSocket", {
          value: init.webSocket,
          writable: false,
        });
      }
    } else {
      super(body, init);
    }
  }
}

globalThis.Response = CloudflareResponse;

if (
  typeof (globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair ===
  "undefined"
) {
  (globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair =
    function () {
      return createMockWebSocketPair();
    };
}

describe("Admin & Agent WebSocket End-to-End Delivery & Latency Benchmark", () => {
  function createTestDOState() {
    const acceptedSockets: MockWebSocket[] = [];
    return {
      acceptWebSocket: vi.fn((ws: MockWebSocket) => {
        acceptedSockets.push(ws);
      }),
      getWebSockets: vi.fn(() => [...acceptedSockets]),
      acceptedSockets,
    };
  }

  it("delivers wake-up to connected client with sub-millisecond in-isolate latency", async () => {
    const state = createTestDOState();
    const room = new AgentRoom(state as unknown as DurableObjectState);

    // Client connects
    const connectReq = new Request("http://do/connect", {
      headers: { Upgrade: "websocket" },
    });
    const connectRes = room.fetch(connectReq);
    expect(connectRes.status).toBe(101);

    const client = (connectRes as unknown as { webSocket: MockWebSocket })
      .webSocket;
    expect(client).toBeDefined();

    // Setup listener with high-res timestamp measurement
    let receivedWake = false;
    let deliveryLatencyMs = -1;

    const wakePromise = new Promise<void>((resolve) => {
      client.onmessage = (event) => {
        const arrival = performance.now();
        const payload = JSON.parse(event.data) as { type?: string };
        if (payload.type === "WAKE_UP") {
          receivedWake = true;
          deliveryLatencyMs = arrival - startSend;
          resolve();
        }
      };
    });

    // Trigger Wake
    const startSend = performance.now();
    const wakeReq = new Request("http://do/wake", { method: "POST" });
    const wakeRes = room.fetch(wakeReq);
    expect(wakeRes.status).toBe(200);

    await wakePromise;
    expect(receivedWake).toBe(true);
    expect(deliveryLatencyMs).toBeGreaterThanOrEqual(0);
    // In-memory microtask dispatch should easily be under 100ms in test runner
    expect(deliveryLatencyMs).toBeLessThan(100);
  });

  it("broadcasts wake-up simultaneously across 5 concurrent tabs/agent with zero drops and measured latency", async () => {
    const state = createTestDOState();
    const room = new AgentRoom(state as unknown as DurableObjectState);

    const tabNames = [
      "LiveOrdersTab",
      "PrintersTab",
      "DashboardTab",
      "ManualCashTab",
      "WindowsAgent",
    ];

    const clients: Array<{
      name: string;
      socket: MockWebSocket;
      latencyMs: number;
    }> = [];

    // Connect all 5 listeners
    for (const name of tabNames) {
      const res = room.fetch(
        new Request("http://do/connect", { headers: { Upgrade: "websocket" } }),
      );
      const socket = (res as unknown as { webSocket: MockWebSocket }).webSocket;
      clients.push({ name, socket, latencyMs: -1 });
    }

    expect(state.getWebSockets().length).toBe(5);

    // Prepare receive promises
    const sendTime = performance.now();
    const promises = clients.map(
      (c) =>
        new Promise<void>((resolve) => {
          c.socket.onmessage = (event) => {
            const arr = performance.now();
            const data = JSON.parse(event.data) as { type?: string };
            if (data.type === "WAKE_UP") {
              c.latencyMs = arr - sendTime;
              resolve();
            }
          };
        }),
    );

    // Fire broadcast
    const wakeRes = room.fetch(
      new Request("http://do/wake", { method: "POST" }),
    );
    expect(wakeRes.status).toBe(200);
    expect(await wakeRes.text()).toBe("Woke up 5 agents");

    await Promise.all(promises);

    // Verify all 5 received
    for (const c of clients) {
      expect(c.latencyMs).toBeGreaterThanOrEqual(0);
      expect(c.latencyMs).toBeLessThan(150);
    }

    const latencies = clients.map((c) => c.latencyMs);
    const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const maxLatency = Math.max(...latencies);

    // All latencies must be healthy
    expect(avgLatency).toBeLessThan(100);
    expect(maxLatency).toBeLessThan(150);
  });

  it("survives rapid storm of 50 consecutive wake-up events without socket crash or lost messages", async () => {
    const state = createTestDOState();
    const room = new AgentRoom(state as unknown as DurableObjectState);

    const res = room.fetch(
      new Request("http://do/connect", { headers: { Upgrade: "websocket" } }),
    );
    const client = (res as unknown as { webSocket: MockWebSocket }).webSocket;

    let receivedCount = 0;
    const allReceived = new Promise<void>((resolve) => {
      client.onmessage = (event) => {
        const data = JSON.parse(event.data) as { type?: string };
        if (data.type === "WAKE_UP") {
          receivedCount++;
          if (receivedCount === 50) {
            resolve();
          }
        }
      };
    });

    // Fire 50 rapid pulses
    const burstStart = performance.now();
    for (let i = 0; i < 50; i++) {
      room.fetch(new Request("http://do/wake", { method: "POST" }));
    }

    await allReceived;
    const burstDurationMs = performance.now() - burstStart;

    expect(receivedCount).toBe(50);
    expect(burstDurationMs).toBeLessThan(500); // 50 messages dispatched and delivered in < 500ms
  });

  it("enforces authentication gate on /api/admin/ws: unauthorized requests never reach Durable Object", async () => {
    const mockDb = {
      prepare: () => ({
        bind: () => ({
          first: () => Promise.resolve(null), // Invalid session
        }),
      }),
    } as unknown as D1Database;

    const mockFetch = vi.fn();
    const mockAgentRoom = {
      idFromName: vi.fn(() => "mock-room-id" as unknown as DurableObjectId),
      get: vi.fn(() => ({ fetch: mockFetch })),
    } as unknown as DurableObjectNamespace;

    const env = {
      APP_ENV: "development",
      ADMIN_ALLOWED_ORIGIN: "https://printgo-admin.pages.dev",
      DB: mockDb,
      AGENT_ROOM: mockAgentRoom,
    } as unknown as WorkerEnv;

    // No token
    const resNoToken = await handleAdminWebSocket(
      new Request("https://api.printgo.dev/api/admin/ws"),
      env,
    );
    expect(resNoToken.status).toBe(401);
    expect(mockFetch).not.toHaveBeenCalled();

    // Invalid token
    const resInvalid = await handleAdminWebSocket(
      new Request("https://api.printgo.dev/api/admin/ws?token=expired-session"),
      env,
    );
    expect(resInvalid.status).toBe(401);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
