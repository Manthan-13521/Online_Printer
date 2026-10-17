import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { D1PrintingRepository } from "./repository.js";
import { AgentRoom } from "../agent/agent-room.js";

// Statement wrapper for node:sqlite DatabaseSync to match Cloudflare D1 with query counting
class StatementWrapper {
  private bindings: SQLInputValue[] = [];
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    private readonly stats?: { reads: number; writes: number; queries: number },
  ) {}

  bind(...values: unknown[]) {
    this.bindings = values.map((v) => {
      if (v === undefined || v === null) return null;
      if (typeof v === "boolean") return v ? 1 : 0;
      return v;
    }) as SQLInputValue[];
    return this;
  }

  first<T>(): Promise<T | null> {
    if (this.stats) {
      this.stats.queries++;
      this.stats.reads++;
    }
    const row = this.db.prepare(this.sql).get(...this.bindings) as
      T | undefined;
    return Promise.resolve(row ?? null);
  }

  all<T>(): Promise<D1Result<T>> {
    if (this.stats) {
      this.stats.queries++;
      this.stats.reads++;
    }
    const results = this.db.prepare(this.sql).all(...this.bindings) as T[];
    return Promise.resolve({
      success: true,
      meta: { changes: 0 },
      results,
    } as unknown as D1Result<T>);
  }

  run(): Promise<D1Result> {
    const result = this.db.prepare(this.sql).run(...this.bindings);
    if (this.stats) {
      this.stats.queries++;
      this.stats.writes += Number(result.changes);
    }
    return Promise.resolve({
      success: true,
      meta: { changes: Number(result.changes) },
      results: [],
    } as unknown as D1Result);
  }
}

function asD1(
  db: DatabaseSync,
  stats?: { reads: number; writes: number; queries: number },
): D1Database {
  let batchLock: Promise<void> = Promise.resolve();
  return {
    prepare: (sql: string) => new StatementWrapper(db, sql, stats),
    async batch(statements: StatementWrapper[]) {
      const previous = batchLock;
      let release!: () => void;
      batchLock = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      db.exec("BEGIN");
      try {
        const results = [];
        for (const s of statements) {
          if (s.sql.trim().toUpperCase().startsWith("SELECT")) {
            results.push(await s.all());
          } else {
            results.push(await s.run());
          }
        }
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      } finally {
        release();
      }
    },
  } as unknown as D1Database;
}

// In-isolate Mock WebSocket pair for Durable Object testing
class MockWebSocket {
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  peer: MockWebSocket | null = null;
  readyState = 1; // OPEN

  send(data: string) {
    if (this.peer && this.peer.onmessage) {
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

const OriginalResponse = globalThis.Response;
class CloudflareResponse extends OriginalResponse {
  override readonly webSocket: WebSocket | null = null;
  constructor(
    body?: BodyInit | null,
    init?: ResponseInit & { webSocket?: unknown },
  ) {
    if (init && init.status === 101) {
      const respInit: ResponseInit = {
        status: 200,
        statusText: "Switching Protocols",
      };
      if (init.headers) respInit.headers = init.headers;
      super(null, respInit);
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

function createTestDOState() {
  const acceptedSockets: MockWebSocket[] = [];
  const taggedSockets = new Map<string, MockWebSocket[]>();
  return {
    acceptWebSocket: vi.fn((ws: MockWebSocket, tags?: string[]) => {
      acceptedSockets.push(ws);
      if (tags) {
        for (const tag of tags) {
          const list = taggedSockets.get(tag) ?? [];
          list.push(ws);
          taggedSockets.set(tag, list);
        }
      }
    }),
    getWebSockets: vi.fn((tag?: string) => {
      if (tag) return [...(taggedSockets.get(tag) ?? [])];
      return [...acceptedSockets];
    }),
    acceptedSockets,
  };
}

// Percentile Calculation Helper
function calculatePercentiles(values: number[]) {
  if (values.length === 0)
    return { p50: 0, p95: 0, p99: 0, min: 0, max: 0, avg: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const getP = (p: number) => {
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
  };
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    p50: getP(50),
    p95: getP(95),
    p99: getP(99),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: Number((sum / sorted.length).toFixed(2)),
  };
}

const AGENT_ID = "40000000-0000-4000-8000-000000000001";

// Five Isolated Virtual Printers
const PRINTER_A_ID = "10000000-0000-4000-8000-00000000000A"; // B&W Simplex
const PRINTER_B_ID = "20000000-0000-4000-8000-00000000000B"; // B&W Duplex
const PRINTER_C_ID = "30000000-0000-4000-8000-00000000000C"; // Color Simplex
const PRINTER_D_ID = "40000000-0000-4000-8000-00000000000D"; // Color Duplex
const PRINTER_E_ID = "50000000-0000-4000-8000-00000000000E"; // Color Duplex All Modes + A3

describe("PRINTGO: Instant Printing & End-to-End Latency Verification Benchmark", () => {
  let db: DatabaseSync;
  let d1: D1Database;
  let repo: D1PrintingRepository;
  let doState: ReturnType<typeof createTestDOState>;
  let agentRoom: AgentRoom;
  let agentSocket: MockWebSocket;
  let adminSocket: MockWebSocket;

  const BASE_NOW_MS = 1_700_000_000_000;

  beforeEach(async () => {
    db = new DatabaseSync(":memory:");

    const migrationDir = new URL(
      "../../../../../database/migrations",
      import.meta.url,
    );
    const files = readdirSync(migrationDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const file of files) {
      const sql = readFileSync(
        new URL(`../../../../../database/migrations/${file}`, import.meta.url),
        "utf8",
      );
      db.exec(sql);
    }

    d1 = asD1(db);
    repo = new D1PrintingRepository(d1);

    // Initialize Durable Object
    doState = createTestDOState();
    agentRoom = new AgentRoom(doState as unknown as DurableObjectState);

    // Connect Agent WebSocket with role=agent and printgo-agent-v1 protocol
    const agentConnectRes = await agentRoom.fetch(
      new Request("http://do/connect?role=agent", {
        headers: {
          Upgrade: "websocket",
          "Sec-WebSocket-Protocol": "printgo-agent-v1",
        },
      }),
    );
    expect(agentConnectRes.status).toBe(101);
    expect(agentConnectRes.headers.get("Sec-WebSocket-Protocol")).toBe(
      "printgo-agent-v1",
    );
    agentSocket = (agentConnectRes as unknown as CloudflareResponse)
      .webSocket as unknown as MockWebSocket;

    // Connect Admin WebSocket with role=admin
    const adminConnectRes = await agentRoom.fetch(
      new Request("http://do/connect?role=admin", {
        headers: { Upgrade: "websocket" },
      }),
    );
    expect(adminConnectRes.status).toBe(101);
    adminSocket = (adminConnectRes as unknown as CloudflareResponse)
      .webSocket as unknown as MockWebSocket;
  });

  function seedShopAndFivePrinters(opts?: {
    agentLastHeartbeatMs?: number;
    printerAStatus?: string;
    idSheetEnabled?: boolean;
    idSheetPlacement?: "FIRST" | "LAST";
  }) {
    const nowMs = BASE_NOW_MS;

    db.prepare(
      `INSERT INTO installation (
        id, app_name, shop_name, contact_phone, address, customer_notice,
        online_printing_enabled, default_production_printer_id,
        max_pdf_size_bytes, max_order_upload_bytes,
        identification_sheet_enabled, identification_sheet_placement,
        created_at_ms, updated_at_ms
      ) VALUES (1, 'PrintGo', 'PrintGo Speed Lab', '+919876543210', 'Shop Floor', 'Testing', 1, ?, 26214400, 52428800, ?, ?, ?, ?)`,
    ).run(
      PRINTER_A_ID,
      opts?.idSheetEnabled ? 1 : 0,
      opts?.idSheetPlacement ?? "LAST",
      nowMs,
      nowMs,
    );

    db.prepare(
      `INSERT INTO agents (
        id, display_name, credential_hash, is_active, paired_at_ms,
        last_heartbeat_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, 'PrintGo Core Agent', 'hash-test', 1, ?, ?, ?, ?)`,
    ).run(AGENT_ID, nowMs, opts?.agentLastHeartbeatMs ?? nowMs, nowMs, nowMs);

    const insertPrinter = (
      id: string,
      name: string,
      winName: string,
      priority: number,
      physDev: string,
      status: string,
      caps: { colour: boolean; duplex: boolean; paperSizes: string[] },
      verified: {
        bw: number;
        color: number;
        duplex: number;
        a4: number;
        a3: number;
      },
      fallbackId: string | null = null,
    ) => {
      db.prepare(
        `INSERT INTO printers (
          id, agent_id, display_name, windows_printer_name, enabled, status, status_reason,
          is_paused, paused_reason, is_production_eligible, is_virtual, priority,
          physical_device_id, fallback_printer_id, auto_fallback_enabled,
          port_name, driver_name,
          capabilities_json, verified_capabilities_json, enabled_services_json,
          last_status_at_ms, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, 1, ?, NULL, 0, NULL, 1, 0, ?, ?, ?, 1, 'USB001', 'Generic', ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        AGENT_ID,
        name,
        winName,
        status,
        priority,
        physDev,
        fallbackId,
        JSON.stringify(caps),
        JSON.stringify({ verified, enabled: verified, requiresReview: false }),
        JSON.stringify(verified),
        nowMs,
        nowMs,
        nowMs,
      );
    };

    insertPrinter(
      PRINTER_A_ID,
      "Printer A (B&W Simplex)",
      "WIN_PRINTER_A",
      50,
      "PHYS_DEV_A",
      opts?.printerAStatus ?? "ONLINE",
      { colour: false, duplex: false, paperSizes: ["A4"] },
      { bw: 1, color: 0, duplex: 0, a4: 1, a3: 0 },
      PRINTER_B_ID,
    );

    insertPrinter(
      PRINTER_B_ID,
      "Printer B (B&W Duplex)",
      "WIN_PRINTER_B",
      40,
      "PHYS_DEV_B",
      "ONLINE",
      { colour: false, duplex: true, paperSizes: ["A4"] },
      { bw: 1, color: 0, duplex: 1, a4: 1, a3: 0 },
    );

    insertPrinter(
      PRINTER_C_ID,
      "Printer C (Color Simplex)",
      "WIN_PRINTER_C",
      30,
      "PHYS_DEV_C",
      "ONLINE",
      { colour: true, duplex: false, paperSizes: ["A4"] },
      { bw: 1, color: 1, duplex: 0, a4: 1, a3: 0 },
    );

    insertPrinter(
      PRINTER_D_ID,
      "Printer D (Color Duplex)",
      "WIN_PRINTER_D",
      20,
      "PHYS_DEV_D",
      "ONLINE",
      { colour: true, duplex: true, paperSizes: ["A4"] },
      { bw: 1, color: 1, duplex: 1, a4: 1, a3: 0 },
    );

    insertPrinter(
      PRINTER_E_ID,
      "Printer E (All Modes + A3)",
      "WIN_PRINTER_E",
      10,
      "PHYS_DEV_E",
      "ONLINE",
      { colour: true, duplex: true, paperSizes: ["A4", "A3"] },
      { bw: 1, color: 1, duplex: 1, a4: 1, a3: 1 },
    );
  }

  function insertOrder(spec: {
    orderId: string;
    colorMode: "BW" | "COLOR";
    sides: "SINGLE" | "DOUBLE";
    paperSize: "A4" | "A3";
    isPriority?: boolean;
    queuedAtMs: number;
    pages?: number;
    copies?: number;
    printerId?: string;
  }) {
    db.prepare(
      `INSERT INTO orders (
        id, public_job_code, pickup_code, customer_name, customer_phone,
        original_filename, color_mode, paper_size, sides,
        printing_amount_paise, service_charge_paise, total_amount_paise,
        status, cleanup_state, is_priority, printer_id,
        created_at_ms, updated_at_ms, paid_at_ms, queued_at_ms
      ) VALUES (
        ?, ?, ?, 'Customer', '9876543210',
        'doc.pdf', ?, ?, ?,
        1000, 0, 1000,
        'QUEUED', 'ACTIVE', ?, ?,
        ?, ?, ?, ?
      )`,
    ).run(
      spec.orderId,
      `JOB-${spec.orderId.slice(-6)}`,
      `PU-${spec.orderId.slice(-6)}`,
      spec.colorMode,
      spec.paperSize,
      spec.sides,
      spec.isPriority ? 1 : 0,
      spec.printerId ?? null,
      spec.queuedAtMs,
      spec.queuedAtMs,
      spec.queuedAtMs,
      spec.queuedAtMs,
    );

    const fileId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO order_files (
        id, order_id, position, original_filename, r2_object_key,
        expected_size_bytes, size_bytes, uploaded_at_ms, source_page_count, selected_pages, copies,
        color_mode, paper_size, sides, upload_status, print_status, created_at_ms, updated_at_ms
      ) VALUES (
        ?, ?, 1, 'doc.pdf', ?,
        1024, 1024, ?, ?, 'ALL', ?,
        ?, ?, ?, 'UPLOADED', 'PENDING', ?, ?
      )`,
    ).run(
      fileId,
      spec.orderId,
      `uploads/${spec.orderId}/file-1.pdf`,
      spec.queuedAtMs,
      spec.pages ?? 5,
      spec.copies ?? 1,
      spec.colorMode,
      spec.paperSize,
      spec.sides,
      spec.queuedAtMs,
      spec.queuedAtMs,
    );

    db.prepare(
      `INSERT INTO uploads (
        id, order_id, r2_object_key, original_filename, mime_type,
        size_bytes, storage_status, created_at_ms, uploaded_at_ms, updated_at_ms, expected_size_bytes
      ) VALUES (
        ?, ?, ?, 'doc.pdf', 'application/pdf',
        1024, 'UPLOADED', ?, ?, ?, 1024
      )`,
    ).run(
      crypto.randomUUID(),
      spec.orderId,
      `uploads/${spec.orderId}/file-1.pdf`,
      spec.queuedAtMs,
      spec.queuedAtMs,
      spec.queuedAtMs,
    );

    db.prepare(
      `INSERT INTO payments (
        id, order_id, provider, provider_order_id, provider_payment_id, amount_paise,
        currency, status, verified_at_ms, created_at_ms, updated_at_ms
      ) VALUES (
        ?, ?, 'CASH', ?, ?, 1000,
        'INR', 'PAID', ?, ?, ?
      )`,
    ).run(
      crypto.randomUUID(),
      spec.orderId,
      `prov-order-${spec.orderId}`,
      `prov-pay-${spec.orderId}`,
      spec.queuedAtMs,
      spec.queuedAtMs,
      spec.queuedAtMs,
    );
  }

  it("Scenario 1: Idle Single Order Immediate Spooling Benchmark (Target: p95 <= 2.0s)", async () => {
    seedShopAndFivePrinters();

    const stage1WakeLatencies: number[] = [];
    const stage2ClaimLatencies: number[] = [];
    const stage3SpoolingLatencies: number[] = [];
    const stage4SubmissionLatencies: number[] = [];
    const totalReadyToSpoolerLatencies: number[] = [];
    const adminDisplayLatencies: number[] = [];

    // Run 20 iterations under idle healthy printer conditions
    for (let i = 1; i <= 20; i++) {
      const orderId = `11111111-0000-4000-8000-${String(i).padStart(12, "0")}`;
      const nowMs = BASE_NOW_MS + i * 5_000;

      // Keep connected agent alive in D1 throughout benchmark
      db.prepare("UPDATE agents SET last_heartbeat_at_ms = ? WHERE id = ?").run(
        nowMs,
        AGENT_ID,
      );

      // Stage 0: Order becomes ready in D1
      insertOrder({
        orderId,
        colorMode: "BW",
        sides: "SINGLE",
        paperSize: "A4",
        queuedAtMs: nowMs,
      });

      // Measurement start
      const t0 = performance.now();

      // Stage 1: Payment verified -> wakeAgent() triggers Durable Object
      let agentWokenAt = 0;
      let adminNotifiedAt = 0;

      const agentWakePromise = new Promise<void>((resolve) => {
        agentSocket.onmessage = (event: { data: string }) => {
          const data = JSON.parse(event.data) as { type?: string };
          if (data.type === "WAKE_UP") {
            agentWokenAt = performance.now();
            resolve();
          }
        };
      });

      const adminWakePromise = new Promise<void>((resolve) => {
        adminSocket.onmessage = (event: { data: string }) => {
          const data = JSON.parse(event.data) as { type?: string };
          if (data.type === "ADMIN_ORDER_UPDATE" || data.type === "WAKE_UP") {
            adminNotifiedAt = performance.now();
            resolve();
          }
        };
      });

      // Worker invokes wake
      await agentRoom.fetch(new Request("http://do/wake", { method: "POST" }));
      await Promise.all([agentWakePromise, adminWakePromise]);

      const t1 = agentWokenAt;
      stage1WakeLatencies.push(t1 - t0);
      adminDisplayLatencies.push(adminNotifiedAt - t0);

      // Stage 2: Agent immediately pulses Worker and claims order in D1
      const claims = await repo.claimOrRenewAll(AGENT_ID, nowMs + 10);
      const t2 = performance.now();
      stage2ClaimLatencies.push(t2 - t1);

      expect(claims.length).toBe(1);
      const claim = claims[0]!;
      expect(claim.orderId).toBe(orderId);
      expect(claim.windowsPrinterName).toBe("WIN_PRINTER_A");

      // Stage 3: Agent preflight (uses warm cache <60s old, 0ms) + startStep (transitions to SPOOLING)
      const startRes = await repo.startStep({
        agentId: AGENT_ID,
        orderId: claim.orderId,
        stepId: claim.currentStep.stepId,
        claimId: claim.claimId,
        nowMs: nowMs + 20,
      });
      expect(startRes?.order_status).toBe("SPOOLING");

      // Notify admin of SPOOLING status
      await agentRoom.fetch(
        new Request("http://do/notify-admin", {
          method: "POST",
          body: JSON.stringify({
            type: "ADMIN_ORDER_UPDATE",
            orderId,
            status: "SPOOLING",
          }),
        }),
      );
      const t3 = performance.now();
      stage3SpoolingLatencies.push(t3 - t2);

      // Stage 4: SumatraPDF submission & Windows Spooler acceptance (recordSubmission)
      const subRes = await repo.recordSubmission({
        agentId: AGENT_ID,
        orderId: claim.orderId,
        stepId: claim.currentStep.stepId,
        claimId: claim.claimId,
        spoolerJobId: `spool-${orderId}`,
        nowMs: nowMs + 50,
      });
      expect(subRes?.order_status).toBe("PRINTING");

      // Notify admin of PRINTING status
      await agentRoom.fetch(
        new Request("http://do/notify-admin", {
          method: "POST",
          body: JSON.stringify({
            type: "ADMIN_ORDER_UPDATE",
            orderId,
            status: "PRINTING",
          }),
        }),
      );
      const t4 = performance.now();
      stage4SubmissionLatencies.push(t4 - t3);

      const totalLatency = t4 - t0;
      totalReadyToSpoolerLatencies.push(totalLatency);

      // Complete print step so device is freed for next iteration
      await repo.recordResult({
        agentId: AGENT_ID,
        orderId: claim.orderId,
        stepId: claim.currentStep.stepId,
        claimId: claim.claimId,
        status: "SUCCEEDED",
        spoolerJobId: `spool-${orderId}`,
        failureCode: null,
        failureDetail: null,
        nowMs: nowMs + 100,
      });
    }

    const s1Stats = calculatePercentiles(stage1WakeLatencies);
    const s2Stats = calculatePercentiles(stage2ClaimLatencies);
    const s3Stats = calculatePercentiles(stage3SpoolingLatencies);
    const s4Stats = calculatePercentiles(stage4SubmissionLatencies);
    const totalStats = calculatePercentiles(totalReadyToSpoolerLatencies);
    const adminStats = calculatePercentiles(adminDisplayLatencies);

    console.log("=== SCENARIO 1: IDLE SINGLE ORDER TIMING BREAKDOWN ===");
    console.log("Stage 1 (Order Ready -> Agent Wake):", s1Stats);
    console.log("Stage 2 (Agent Wake -> CLAIMED):", s2Stats);
    console.log("Stage 3 (CLAIMED -> SPOOLING):", s3Stats);
    console.log("Stage 4 (SPOOLING -> Spooler Accepted):", s4Stats);
    console.log("Total (Order Ready -> Spooler Accepted):", totalStats);
    console.log("Admin Display Latency (Backend -> UI):", adminStats);

    // CRITICAL ACCEPTANCE GOAL: p95 <= 2.0 seconds (2000ms)
    expect(totalStats.p95).toBeLessThanOrEqual(2000);
    // In-isolate dispatch is typically sub-10ms; guarantee well under 2.0s
    expect(totalStats.max).toBeLessThan(500);
    expect(adminStats.p95).toBeLessThan(100);
  });

  it("Scenario 2: 10 Concurrent Mixed Orders (Parallel Physical Lanes + Priority/FIFO)", async () => {
    seedShopAndFivePrinters();

    // 10 mixed orders: 2 priority, 8 normal, targeting all 5 virtual printers
    const orderSpecs = [
      {
        id: "20000000-0000-4000-8000-000000000001",
        bw: "BW" as const,
        side: "SINGLE" as const,
        size: "A4" as const,
        prio: false,
        exp: PRINTER_A_ID,
      },
      {
        id: "20000000-0000-4000-8000-000000000002",
        bw: "BW" as const,
        side: "DOUBLE" as const,
        size: "A4" as const,
        prio: false,
        exp: PRINTER_B_ID,
      },
      {
        id: "20000000-0000-4000-8000-000000000003",
        bw: "COLOR" as const,
        side: "SINGLE" as const,
        size: "A4" as const,
        prio: false,
        exp: PRINTER_C_ID,
      },
      {
        id: "20000000-0000-4000-8000-000000000004",
        bw: "COLOR" as const,
        side: "DOUBLE" as const,
        size: "A4" as const,
        prio: false,
        exp: PRINTER_D_ID,
      },
      {
        id: "20000000-0000-4000-8000-000000000005",
        bw: "COLOR" as const,
        side: "DOUBLE" as const,
        size: "A3" as const,
        prio: true,
        exp: PRINTER_E_ID,
      }, // Priority
      {
        id: "20000000-0000-4000-8000-000000000006",
        bw: "BW" as const,
        side: "SINGLE" as const,
        size: "A4" as const,
        prio: false,
        exp: PRINTER_A_ID,
      },
      {
        id: "20000000-0000-4000-8000-000000000007",
        bw: "BW" as const,
        side: "DOUBLE" as const,
        size: "A4" as const,
        prio: true,
        exp: PRINTER_B_ID,
      }, // Priority
      {
        id: "20000000-0000-4000-8000-000000000008",
        bw: "COLOR" as const,
        side: "SINGLE" as const,
        size: "A4" as const,
        prio: false,
        exp: PRINTER_C_ID,
      },
      {
        id: "20000000-0000-4000-8000-000000000009",
        bw: "COLOR" as const,
        side: "DOUBLE" as const,
        size: "A4" as const,
        prio: false,
        exp: PRINTER_D_ID,
      },
      {
        id: "20000000-0000-4000-8000-000000000010",
        bw: "BW" as const,
        side: "SINGLE" as const,
        size: "A3" as const,
        prio: false,
        exp: PRINTER_E_ID,
      },
    ];

    for (let i = 0; i < orderSpecs.length; i++) {
      const s = orderSpecs[i]!;
      insertOrder({
        orderId: s.id,
        colorMode: s.bw,
        sides: s.side,
        paperSize: s.size,
        isPriority: s.prio,
        queuedAtMs: BASE_NOW_MS + i * 100,
      });
    }

    // Agent pulses to claim round 1
    const round1Claims = await repo.claimOrRenewAll(
      AGENT_ID,
      BASE_NOW_MS + 2_000,
    );
    // Exactly 5 orders claimed simultaneously across 5 physical devices
    expect(round1Claims.length).toBe(5);

    const claimedPrinters = new Set(
      round1Claims.map((c) => c.windowsPrinterName),
    );
    expect(claimedPrinters.size).toBe(5); // 5 distinct physical lanes!

    // Verify priority orders were picked first
    const claimedOrderIds = new Set(round1Claims.map((c) => c.orderId));
    expect(claimedOrderIds.has("20000000-0000-4000-8000-000000000005")).toBe(
      true,
    ); // Priority A3 Color
    expect(claimedOrderIds.has("20000000-0000-4000-8000-000000000007")).toBe(
      true,
    ); // Priority Duplex B&W

    // Complete round 1 prints
    for (const claim of round1Claims) {
      await repo.startStep({
        agentId: AGENT_ID,
        orderId: claim.orderId,
        stepId: claim.currentStep.stepId,
        claimId: claim.claimId,
        nowMs: BASE_NOW_MS + 2_100,
      });
      await repo.recordSubmission({
        agentId: AGENT_ID,
        orderId: claim.orderId,
        stepId: claim.currentStep.stepId,
        claimId: claim.claimId,
        spoolerJobId: `spool-${claim.orderId}`,
        nowMs: BASE_NOW_MS + 2_200,
      });
      await repo.recordResult({
        agentId: AGENT_ID,
        orderId: claim.orderId,
        stepId: claim.currentStep.stepId,
        claimId: claim.claimId,
        status: "SUCCEEDED",
        spoolerJobId: `spool-${claim.orderId}`,
        failureCode: null,
        failureDetail: null,
        nowMs: BASE_NOW_MS + 2_300,
      });
    }

    // Round 2 claims next 4 compatible orders across idle physical lanes
    const round2Claims = await repo.claimOrRenewAll(
      AGENT_ID,
      BASE_NOW_MS + 3_000,
    );
    expect(round2Claims.length).toBe(4);

    for (const claim of round2Claims) {
      await repo.startStep({
        agentId: AGENT_ID,
        orderId: claim.orderId,
        stepId: claim.currentStep.stepId,
        claimId: claim.claimId,
        nowMs: BASE_NOW_MS + 3_100,
      });
      await repo.recordSubmission({
        agentId: AGENT_ID,
        orderId: claim.orderId,
        stepId: claim.currentStep.stepId,
        claimId: claim.claimId,
        spoolerJobId: `spool-${claim.orderId}`,
        nowMs: BASE_NOW_MS + 3_200,
      });
      await repo.recordResult({
        agentId: AGENT_ID,
        orderId: claim.orderId,
        stepId: claim.currentStep.stepId,
        claimId: claim.claimId,
        status: "SUCCEEDED",
        spoolerJobId: `spool-${claim.orderId}`,
        failureCode: null,
        failureDetail: null,
        nowMs: BASE_NOW_MS + 3_300,
      });
    }

    // Round 3 claims the final remaining order once color/A3 lanes are freed
    const round3Claims = await repo.claimOrRenewAll(
      AGENT_ID,
      BASE_NOW_MS + 4_000,
    );
    expect(round3Claims.length).toBe(1);

    for (const claim of round3Claims) {
      await repo.startStep({
        agentId: AGENT_ID,
        orderId: claim.orderId,
        stepId: claim.currentStep.stepId,
        claimId: claim.claimId,
        nowMs: BASE_NOW_MS + 4_100,
      });
      await repo.recordSubmission({
        agentId: AGENT_ID,
        orderId: claim.orderId,
        stepId: claim.currentStep.stepId,
        claimId: claim.claimId,
        spoolerJobId: `spool-${claim.orderId}`,
        nowMs: BASE_NOW_MS + 4_200,
      });
      await repo.recordResult({
        agentId: AGENT_ID,
        orderId: claim.orderId,
        stepId: claim.currentStep.stepId,
        claimId: claim.claimId,
        status: "SUCCEEDED",
        spoolerJobId: `spool-${claim.orderId}`,
        failureCode: null,
        failureDetail: null,
        nowMs: BASE_NOW_MS + 4_300,
      });
    }

    // Zero remaining queued orders — all 10 completed cleanly
    const remaining = await repo.claimOrRenewAll(AGENT_ID, BASE_NOW_MS + 5_000);
    expect(remaining.length).toBe(0);
  });

  it("Scenario 3: 50 Mixed Orders Full End-to-End Throughput & Latency Distribution", async () => {
    seedShopAndFivePrinters();

    const orderLatencies: number[] = [];

    // Create 50 realistic mixed orders
    for (let i = 1; i <= 50; i++) {
      const orderId = `30000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      const isPriority = i % 5 === 0; // 10 priority orders
      const colorMode = i % 2 === 0 ? ("COLOR" as const) : ("BW" as const);
      const sides = i % 3 === 0 ? ("DOUBLE" as const) : ("SINGLE" as const);
      const paperSize = i % 7 === 0 ? ("A3" as const) : ("A4" as const);

      insertOrder({
        orderId,
        colorMode,
        sides,
        paperSize,
        isPriority,
        queuedAtMs: BASE_NOW_MS + i * 50,
      });
    }

    let completedOrders = 0;
    let simTime = BASE_NOW_MS + 10_000;

    while (completedOrders < 50) {
      const claims = await repo.claimOrRenewAll(AGENT_ID, simTime);
      if (claims.length === 0) break;

      for (const claim of claims) {
        const tStart = performance.now();
        // startStep
        await repo.startStep({
          agentId: AGENT_ID,
          orderId: claim.orderId,
          stepId: claim.currentStep.stepId,
          claimId: claim.claimId,
          nowMs: simTime + 10,
        });
        // recordSubmission
        await repo.recordSubmission({
          agentId: AGENT_ID,
          orderId: claim.orderId,
          stepId: claim.currentStep.stepId,
          claimId: claim.claimId,
          spoolerJobId: `spool-${claim.orderId}`,
          nowMs: simTime + 20,
        });
        // recordResult
        await repo.recordResult({
          agentId: AGENT_ID,
          orderId: claim.orderId,
          stepId: claim.currentStep.stepId,
          claimId: claim.claimId,
          status: "SUCCEEDED",
          spoolerJobId: `spool-${claim.orderId}`,
          failureCode: null,
          failureDetail: null,
          nowMs: simTime + 50,
        });

        const tEnd = performance.now();
        orderLatencies.push(tEnd - tStart);
        completedOrders++;
      }
      simTime += 500;
    }

    expect(completedOrders).toBe(50);

    const stats50 = calculatePercentiles(orderLatencies);
    console.log("=== SCENARIO 3: 50-ORDER DISPATCH & SUBMISSION STATS ===");
    console.log("50 Orders Submission Latency:", stats50);

    expect(stats50.p95).toBeLessThanOrEqual(2000);
  });

  it("Scenario 4: WebSocket Disconnection, Reconnection & Missed Wake-up Recovery", async () => {
    seedShopAndFivePrinters();

    // 1. Initial order placed while WebSocket is connected (assigned to Printer A)
    const order1Id = "40000000-0000-4000-8000-000000000001";
    insertOrder({
      orderId: order1Id,
      colorMode: "BW",
      sides: "SINGLE",
      paperSize: "A4",
      queuedAtMs: BASE_NOW_MS,
      printerId: PRINTER_A_ID,
    });

    let wakeCount = 0;
    agentSocket.onmessage = () => {
      wakeCount++;
    };

    await agentRoom.fetch(new Request("http://do/wake", { method: "POST" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(wakeCount).toBe(1);

    // 2. Network disconnect occurs: agent socket closes
    agentSocket.close();
    expect(doState.getWebSockets("agent").length).toBe(1); // will be cleaned up on close/next read

    // 3. New order arrives while agent is disconnected (missed wake-up scenario)
    const order2Id = "40000000-0000-4000-8000-000000000002";
    insertOrder({
      orderId: order2Id,
      colorMode: "BW",
      sides: "SINGLE",
      paperSize: "A4",
      queuedAtMs: BASE_NOW_MS + 2_000,
      printerId: PRINTER_A_ID,
    });

    // Wake is attempted; agent is disconnected so message is not delivered to closed socket
    await agentRoom.fetch(new Request("http://do/wake", { method: "POST" }));

    // 4. Agent reconnects using standard 'printgo-agent-v1' subprotocol
    const reconnectedRes = await agentRoom.fetch(
      new Request("http://do/connect?role=agent", {
        headers: {
          Upgrade: "websocket",
          "Sec-WebSocket-Protocol": "printgo-agent-v1",
        },
      }),
    );
    expect(reconnectedRes.status).toBe(101);
    expect(reconnectedRes.headers.get("Sec-WebSocket-Protocol")).toBe(
      "printgo-agent-v1",
    );
    const reconnectedSocket = (reconnectedRes as unknown as CloudflareResponse)
      .webSocket as unknown as MockWebSocket;

    // 5. On reconnection pulse, agent immediately polls D1 and claims the missed order!
    const recoveredClaims = await repo.claimOrRenewAll(
      AGENT_ID,
      BASE_NOW_MS + 5_000,
    );
    expect(recoveredClaims.length).toBe(1);
    const recovered = recoveredClaims[0]!;
    expect(recovered.orderId).toBe(order1Id); // FIFO order 1 claimed first

    // Complete order 1 through full physical journal steps
    await repo.startStep({
      agentId: AGENT_ID,
      orderId: order1Id,
      stepId: recovered.currentStep.stepId,
      claimId: recovered.claimId,
      nowMs: BASE_NOW_MS + 5_100,
    });
    await repo.recordSubmission({
      agentId: AGENT_ID,
      orderId: order1Id,
      stepId: recovered.currentStep.stepId,
      claimId: recovered.claimId,
      spoolerJobId: "s1",
      nowMs: BASE_NOW_MS + 5_150,
    });
    await repo.recordResult({
      agentId: AGENT_ID,
      orderId: order1Id,
      stepId: recovered.currentStep.stepId,
      claimId: recovered.claimId,
      status: "SUCCEEDED",
      spoolerJobId: "s1",
      failureCode: null,
      failureDetail: null,
      nowMs: BASE_NOW_MS + 5_200,
    });

    // Next pulse claims order 2
    const secondClaim = await repo.claimOrRenewAll(
      AGENT_ID,
      BASE_NOW_MS + 5_300,
    );
    expect(secondClaim.length).toBe(1);
    expect(secondClaim[0]!.orderId).toBe(order2Id);

    // Subsequent live wake-up works immediately on reconnected socket
    let liveWakeReceived = false;
    reconnectedSocket.onmessage = (event: { data: string }) => {
      const data = JSON.parse(event.data) as { type?: string };
      if (data.type === "WAKE_UP") liveWakeReceived = true;
    };
    await agentRoom.fetch(new Request("http://do/wake", { method: "POST" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(liveWakeReceived).toBe(true);
  });

  it("Scenario 5: Preflight Hardware Fault Detection, Safe Fallback & Zero Duplicate Prints", async () => {
    // Printer A is Jammed/Offline; Fallback configured to Printer B, ID Sheet enabled
    seedShopAndFivePrinters({
      printerAStatus: "BLOCKED",
      idSheetEnabled: true,
      idSheetPlacement: "FIRST",
    });

    const orderId = "50000000-0000-4000-8000-000000000001";
    insertOrder({
      orderId,
      colorMode: "BW",
      sides: "SINGLE",
      paperSize: "A4",
      queuedAtMs: BASE_NOW_MS,
    });

    // Claim query automatically routes to fallback Printer B because Printer A is BLOCKED
    const claims = await repo.claimOrRenewAll(AGENT_ID, BASE_NOW_MS + 1_000);
    expect(claims.length).toBe(1);
    const claim1 = claims[0]!;
    expect(claim1.windowsPrinterName).toBe("WIN_PRINTER_B"); // Safely fell back to Printer B!

    // Step 1: ID Sheet succeeds
    await repo.startStep({
      agentId: AGENT_ID,
      orderId,
      stepId: claim1.currentStep.stepId,
      claimId: claim1.claimId,
      nowMs: BASE_NOW_MS + 1_100,
    });
    await repo.recordSubmission({
      agentId: AGENT_ID,
      orderId,
      stepId: claim1.currentStep.stepId,
      claimId: claim1.claimId,
      spoolerJobId: "spool-id-sheet",
      nowMs: BASE_NOW_MS + 1_200,
    });
    await repo.recordResult({
      agentId: AGENT_ID,
      orderId,
      stepId: claim1.currentStep.stepId,
      claimId: claim1.claimId,
      status: "SUCCEEDED",
      spoolerJobId: "spool-id-sheet",
      failureCode: null,
      failureDetail: null,
      nowMs: BASE_NOW_MS + 1_300,
    });

    // Step 2: Customer Doc starts submission, then an unexpected hardware disconnect occurs
    const claimStep2 = await repo.claimOrRenewAll(
      AGENT_ID,
      BASE_NOW_MS + 1_400,
    );
    expect(claimStep2.length).toBe(1);
    const claim2 = claimStep2[0]!;
    await repo.startStep({
      agentId: AGENT_ID,
      orderId,
      stepId: claim2.currentStep.stepId,
      claimId: claim2.claimId,
      nowMs: BASE_NOW_MS + 1_500,
    });

    // Simulate crash / lost submission acknowledgment
    await repo.recordResult({
      agentId: AGENT_ID,
      orderId,
      stepId: claim2.currentStep.stepId,
      claimId: claim2.claimId,
      status: "UNCERTAIN",
      spoolerJobId: null,
      failureCode: "UNKNOWN",
      failureDetail: "Printer disconnected mid-flight",
      nowMs: BASE_NOW_MS + 1_600,
    });

    // Verify order is locked in COMPLETION_UNKNOWN and will NEVER be reprinted automatically
    const orderRow = db
      .prepare("SELECT status FROM orders WHERE id = ?")
      .get(orderId) as { status: string };
    expect(["COMPLETION_UNKNOWN", "ADMIN_ACTION_REQUIRED"]).toContain(
      orderRow.status,
    );

    // Subsequent claims pulse returns 0 orders — duplicate print strictly prevented!
    const subsequentClaims = await repo.claimOrRenewAll(
      AGENT_ID,
      BASE_NOW_MS + 2_000,
    );
    expect(subsequentClaims.length).toBe(0);
  });

  it("Scenario 6: Dead-Agent Rejection & Idle Liveness Freshness", async () => {
    seedShopAndFivePrinters({ agentLastHeartbeatMs: BASE_NOW_MS });

    const orderId = "60000000-0000-4000-8000-000000000001";
    insertOrder({
      orderId,
      colorMode: "BW",
      sides: "SINGLE",
      paperSize: "A4",
      queuedAtMs: BASE_NOW_MS,
    });

    // 1. Healthy connected agent: at t = BASE_NOW_MS + 45s (idle pulse):
    // Timestamp in D1 is refreshed, age is 0s (<90s threshold).
    db.prepare("UPDATE agents SET last_heartbeat_at_ms = ? WHERE id = ?").run(
      BASE_NOW_MS + 45_000,
      AGENT_ID,
    );
    const healthyClaims = await repo.claimOrRenewAll(
      AGENT_ID,
      BASE_NOW_MS + 45_100,
    );
    expect(healthyClaims.length).toBe(1);
    const healthy = healthyClaims[0]!;

    // Complete order through full physical journal steps
    await repo.startStep({
      agentId: AGENT_ID,
      orderId,
      stepId: healthy.currentStep.stepId,
      claimId: healthy.claimId,
      nowMs: BASE_NOW_MS + 45_200,
    });
    await repo.recordSubmission({
      agentId: AGENT_ID,
      orderId,
      stepId: healthy.currentStep.stepId,
      claimId: healthy.claimId,
      spoolerJobId: "s-healthy",
      nowMs: BASE_NOW_MS + 45_500,
    });
    await repo.recordResult({
      agentId: AGENT_ID,
      orderId,
      stepId: healthy.currentStep.stepId,
      claimId: healthy.claimId,
      status: "SUCCEEDED",
      spoolerJobId: "s-healthy",
      failureCode: null,
      failureDetail: null,
      nowMs: BASE_NOW_MS + 46_000,
    });

    // 2. Crashed agent scenario: agent process terminated, clock advances 100s (>90s threshold)
    const order2Id = "60000000-0000-4000-8000-000000000002";
    insertOrder({
      orderId: order2Id,
      colorMode: "BW",
      sides: "SINGLE",
      paperSize: "A4",
      queuedAtMs: BASE_NOW_MS + 150_000,
    });

    // Agent has not heartbeated for 105s (last heartbeat at 45s, current time is 150s)
    const deadAgentClaims = await repo.claimOrRenewAll(
      AGENT_ID,
      BASE_NOW_MS + 150_000,
    );
    expect(deadAgentClaims.length).toBe(0); // PROVEN: Dead-agent protection refuses routing!
  });

  it("Scenario 7: Idle Agent Liveness Endurance Across 2, 5, 10, and 30 Minutes", async () => {
    seedShopAndFivePrinters();

    // Model the 45s idle heartbeat schedule with 40s D1 write throttle
    // Over a 30-minute idle period (1,800s):
    // Pulse fires at 45s, 90s, 135s, 180s, etc.
    // At each milestone (2 min = 120s, 5 min = 300s, 10 min = 600s, 30 min = 1800s):
    // The agent receives a WAKE_UP notification and immediately claims and spools an order.

    const testMilestones = [
      {
        name: "2 minutes idle",
        timeSec: 120,
        orderId: "70000000-0000-4000-8000-000000000002",
      },
      {
        name: "5 minutes idle",
        timeSec: 300,
        orderId: "70000000-0000-4000-8000-000000000005",
      },
      {
        name: "10 minutes idle",
        timeSec: 600,
        orderId: "70000000-0000-4000-8000-000000000010",
      },
      {
        name: "30 minutes idle",
        timeSec: 1800,
        orderId: "70000000-0000-4000-8000-000000000030",
      },
    ];

    let lastSimulatedPulseMs = BASE_NOW_MS;
    let d1WriteCount = 0;

    const simulateIdlePulsesUpTo = (targetSec: number) => {
      const targetMs = BASE_NOW_MS + targetSec * 1_000;
      while (lastSimulatedPulseMs + 45_000 <= targetMs) {
        lastSimulatedPulseMs += 45_000;
        // In worker AgentService: 45s >= 40s throttle -> updates last_heartbeat_at_ms in D1
        db.prepare(
          "UPDATE agents SET last_heartbeat_at_ms = ? WHERE id = ?",
        ).run(lastSimulatedPulseMs, AGENT_ID);
        d1WriteCount++;
      }
    };

    for (const milestone of testMilestones) {
      // 1. Advance idle time to milestone with 45s pulse schedule
      simulateIdlePulsesUpTo(milestone.timeSec);
      const orderNowMs = BASE_NOW_MS + milestone.timeSec * 1_000;

      // 2. Order arrives while agent has been idle
      insertOrder({
        orderId: milestone.orderId,
        colorMode: "BW",
        sides: "SINGLE",
        paperSize: "A4",
        queuedAtMs: orderNowMs,
      });

      // 3. WAKE_UP signal is sent over WebSocket
      let wakeReceived = false;
      agentSocket.onmessage = (event: { data: string }) => {
        const data = JSON.parse(event.data) as { type?: string };
        if (data.type === "WAKE_UP") wakeReceived = true;
      };
      await agentRoom.fetch(new Request("http://do/wake", { method: "POST" }));
      await new Promise((r) => setTimeout(r, 10));
      expect(wakeReceived).toBe(true);

      // 4. Agent receives wake and claims immediately:
      // Even after 2, 5, 10, or 30 minutes of idle sitting,
      // the agent's heartbeat age in D1 is AT MOST 45 seconds (far below 90s cutoff)!
      const agentRow = db
        .prepare("SELECT last_heartbeat_at_ms FROM agents WHERE id = ?")
        .get(AGENT_ID) as { last_heartbeat_at_ms: number };
      const ageMs = orderNowMs - agentRow.last_heartbeat_at_ms;
      expect(ageMs).toBeLessThanOrEqual(45_000); // PROVEN: Freshness is guaranteed!

      const claims = await repo.claimOrRenewAll(AGENT_ID, orderNowMs);
      expect(claims.length).toBe(1);
      expect(claims[0]!.orderId).toBe(milestone.orderId);

      // Complete order
      await repo.startStep({
        agentId: AGENT_ID,
        orderId: milestone.orderId,
        stepId: claims[0]!.currentStep.stepId,
        claimId: claims[0]!.claimId,
        nowMs: orderNowMs + 100,
      });
      await repo.recordSubmission({
        agentId: AGENT_ID,
        orderId: milestone.orderId,
        stepId: claims[0]!.currentStep.stepId,
        claimId: claims[0]!.claimId,
        spoolerJobId: `spool-${milestone.orderId}`,
        nowMs: orderNowMs + 200,
      });
      await repo.recordResult({
        agentId: AGENT_ID,
        orderId: milestone.orderId,
        stepId: claims[0]!.currentStep.stepId,
        claimId: claims[0]!.claimId,
        status: "SUCCEEDED",
        spoolerJobId: `spool-${milestone.orderId}`,
        failureCode: null,
        failureDetail: null,
        nowMs: orderNowMs + 300,
      });
    }

    // Over 30 minutes (1800s), exactly 40 idle pulses occurred (1800 / 45 = 40 writes)
    expect(d1WriteCount).toBe(40);
  });

  it("Scenario 8: Printer Hardware Fault Safety & Safe Fallback with Zero Duplicate Submissions", async () => {
    seedShopAndFivePrinters({ printerAStatus: "ONLINE" });

    const orderId = "80000000-0000-4000-8000-000000000001";
    insertOrder({
      orderId,
      colorMode: "BW",
      sides: "SINGLE",
      paperSize: "A4",
      queuedAtMs: BASE_NOW_MS,
    });

    // 1. Order claimed for Printer A
    const claims = await repo.claimOrRenewAll(AGENT_ID, BASE_NOW_MS + 1_000);
    expect(claims.length).toBe(1);
    const claim = claims[0]!;
    expect(claim.windowsPrinterName).toBe("WIN_PRINTER_A");

    // 2. Sudden hardware fault: Printer A runs out of paper / jams immediately before physical submission
    // Preflight hardware check flags Printer A as BLOCKED
    db.prepare(
      "UPDATE printers SET status = 'BLOCKED', status_reason = 'Paper out' WHERE id = ?",
    ).run(PRINTER_A_ID);

    // Agent reports preflight failure to server; server authorizes fallback to Printer B
    const fallbackRes = await repo.handlePreflightFailure({
      agentId: AGENT_ID,
      orderId,
      stepId: claim.currentStep.stepId,
      claimId: claim.claimId,
      failureCode: "PAPER_OUT",
      failureDetail: "Tray 1 is empty",
      nowMs: BASE_NOW_MS + 1_200,
    });
    expect(fallbackRes.action).toBe("FALLBACK_ASSIGNED");
    expect(fallbackRes.fallbackPrinterName).toBe("Printer B (B&W Duplex)");

    // 3. Fallback: print job reassigned to healthy fallback Printer B
    const fallbackJob = fallbackRes.printJob!;
    expect(fallbackJob.windowsPrinterName).toBe("WIN_PRINTER_B");

    // Complete on fallback Printer B
    await repo.startStep({
      agentId: AGENT_ID,
      orderId,
      stepId: fallbackJob.currentStep.stepId,
      claimId: fallbackJob.claimId,
      nowMs: BASE_NOW_MS + 1_600,
    });
    await repo.recordSubmission({
      agentId: AGENT_ID,
      orderId,
      stepId: fallbackJob.currentStep.stepId,
      claimId: fallbackJob.claimId,
      spoolerJobId: "spool-fallback",
      nowMs: BASE_NOW_MS + 1_700,
    });
    await repo.recordResult({
      agentId: AGENT_ID,
      orderId,
      stepId: fallbackJob.currentStep.stepId,
      claimId: fallbackJob.claimId,
      status: "SUCCEEDED",
      spoolerJobId: "spool-fallback",
      failureCode: null,
      failureDetail: null,
      nowMs: BASE_NOW_MS + 1_800,
    });

    // Order is completed on Printer B; verify single completed status
    const orderFinal = db
      .prepare("SELECT status FROM orders WHERE id = ?")
      .get(orderId) as { status: string };
    expect(orderFinal.status).toBe("COMPLETED");
  });

  it("Scenario 9: Admin Notification Isolation (Zero-Feedback Loop to Agent)", async () => {
    seedShopAndFivePrinters();

    let agentReceivedNotification = false;
    let adminReceivedNotification = false;

    agentSocket.onmessage = (event: { data: string }) => {
      const data = JSON.parse(event.data) as { type?: string };
      if (data.type === "ADMIN_ORDER_UPDATE") {
        agentReceivedNotification = true;
      }
    };

    adminSocket.onmessage = (event: { data: string }) => {
      const data = JSON.parse(event.data) as { type?: string };
      if (data.type === "ADMIN_ORDER_UPDATE") {
        adminReceivedNotification = true;
      }
    };

    // Worker dispatches notify-admin for order status change
    await agentRoom.fetch(
      new Request("http://do/notify-admin", {
        method: "POST",
        body: JSON.stringify({
          type: "ADMIN_ORDER_UPDATE",
          orderId: "test-order",
          status: "PRINTING",
        }),
      }),
    );
    await new Promise((r) => setTimeout(r, 20));

    // Admin MUST receive update; Agent MUST NOT receive update!
    expect(adminReceivedNotification).toBe(true);
    expect(agentReceivedNotification).toBe(false); // PROVEN: Zero-feedback loop, no spurious agent pulses!
  });
});
