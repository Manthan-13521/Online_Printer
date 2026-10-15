import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it, beforeEach } from "vitest";

import { hashSessionToken } from "@printgo/auth";
import type { CapabilityVerificationRecord } from "@printgo/domain";
import type { D1Database, D1Result } from "@cloudflare/workers-types";
import { D1PrintingRepository } from "./repository";
import { PrintingService } from "./service";
import type { DownloadSigner } from "../storage/r2-upload-signer";

// Database statement wrapper for in-memory SQLite emulation of Cloudflare D1
class D1StatementWrapper {
  private bindings: SQLInputValue[] = [];
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
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
    const row = this.db.prepare(this.sql).get(...this.bindings) as
      T | undefined;
    return Promise.resolve(row ?? null);
  }

  all<T>(): Promise<D1Result<T>> {
    const results = this.db.prepare(this.sql).all(...this.bindings) as T[];
    return Promise.resolve({
      success: true,
      meta: { changes: 0 },
      results,
    } as unknown as D1Result<T>);
  }

  run(): Promise<D1Result> {
    const result = this.db.prepare(this.sql).run(...this.bindings);
    return Promise.resolve({
      success: true,
      meta: { changes: Number(result.changes) },
      results: [],
    } as unknown as D1Result);
  }
}

function createD1(db: DatabaseSync): D1Database {
  let batchLock: Promise<void> = Promise.resolve();
  return {
    prepare: (sql: string) => new D1StatementWrapper(db, sql),
    async batch(statements: D1StatementWrapper[]) {
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
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      } finally {
        release();
      }
    },
  } as unknown as D1Database;
}

function loadAllMigrations(db: DatabaseSync) {
  const dir = new URL("../../../../../database/migrations", import.meta.url);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of files) {
    const sql = readFileSync(
      new URL(`../../../../../database/migrations/${f}`, import.meta.url),
      "utf8",
    );
    db.exec(sql);
  }
}

const padUuid = (hex: string) =>
  (hex + "-0000-4000-8000-000000000000").slice(0, 36);

describe("PrintGo Phase 8 Final End-to-End System & 5 Virtual Printers Verification", () => {
  let db: DatabaseSync;
  let d1: D1Database;
  let nowMs: number;
  let printingRepo: D1PrintingRepository;
  let printingService: PrintingService;

  const agentId = padUuid("agent001");
  const agentSecret = "secret_virt_001";
  let agentHash: string;

  const p1Id = padUuid("p0000001"); // P1: B&W Simplex
  const p2Id = padUuid("p0000002"); // P2: B&W Duplex
  const p3Id = padUuid("p0000003"); // P3: Color Simplex
  const p4Id = padUuid("p0000004"); // P4: Color Duplex
  const p5Id = padUuid("p0000005"); // P5: Offline Multi

  const mockDownloadSigner: DownloadSigner = {
    createDownloadAuthorization: (key: string) =>
      Promise.resolve({
        url: `https://r2.synthetic.local/${key}?sig=valid`,
        expiresAtMs: nowMs + 3600_000,
      }),
  };

  beforeEach(async () => {
    nowMs = 1_700_000_000_000;
    db = new DatabaseSync(":memory:");
    loadAllMigrations(db);
    d1 = createD1(db);

    agentHash = await hashSessionToken(agentSecret);

    // Setup installation & active agent
    db.exec(`
      INSERT OR REPLACE INTO installation (id, shop_name, default_production_printer_id, created_at_ms, updated_at_ms)
      VALUES (1, 'Test Print Shop', '${p1Id}', ${nowMs}, ${nowMs});

      INSERT INTO agents (id, credential_hash, display_name, is_active, paired_at_ms, last_heartbeat_at_ms, created_at_ms, updated_at_ms)
      VALUES ('${agentId}', '${agentHash}', 'Front Desk Windows Agent', 1, ${nowMs}, ${nowMs}, ${nowMs}, ${nowMs});
    `);

    // P1: B&W Simplex - Priority 50 (Device DEV_1)
    // P2: B&W Duplex - Priority 40 (Device DEV_2)
    // P3: Color Simplex - Priority 30 (Device DEV_3)
    // P4: Color Duplex - Priority 20 (Device DEV_4)
    // P5: All-in-one - Priority 10 (Device DEV_5, OFFLINE)
    const p1Caps: CapabilityVerificationRecord = {
      verified: { bw: true, color: false, duplex: false, a4: true, a3: false },
      enabled: { bw: true, color: false, duplex: false, a4: true, a3: false },
      requiresReview: false,
    };
    const p2Caps: CapabilityVerificationRecord = {
      verified: { bw: true, color: false, duplex: true, a4: true, a3: false },
      enabled: { bw: true, color: false, duplex: true, a4: true, a3: false },
      requiresReview: false,
    };
    const p3Caps: CapabilityVerificationRecord = {
      verified: { bw: false, color: true, duplex: false, a4: true, a3: false },
      enabled: { bw: false, color: true, duplex: false, a4: true, a3: false },
      requiresReview: false,
    };
    const p4Caps: CapabilityVerificationRecord = {
      verified: { bw: false, color: true, duplex: true, a4: true, a3: false },
      enabled: { bw: false, color: true, duplex: true, a4: true, a3: false },
      requiresReview: false,
    };
    const p5Caps: CapabilityVerificationRecord = {
      verified: { bw: true, color: true, duplex: true, a4: true, a3: false },
      enabled: { bw: true, color: true, duplex: true, a4: true, a3: false },
      requiresReview: false,
    };

    const enabledBwOnly = JSON.stringify({
      bw: 1,
      color: 0,
      duplex: 0,
      a4: 1,
      a3: 0,
    });
    const enabledBwDuplex = JSON.stringify({
      bw: 1,
      color: 0,
      duplex: 1,
      a4: 1,
      a3: 0,
    });
    const enabledColorSimplex = JSON.stringify({
      bw: 0,
      color: 1,
      duplex: 0,
      a4: 1,
      a3: 0,
    });
    const enabledColorDuplex = JSON.stringify({
      bw: 0,
      color: 1,
      duplex: 1,
      a4: 1,
      a3: 0,
    });

    db.exec(`
      INSERT INTO printers (id, agent_id, windows_printer_name, display_name, status, enabled, is_production_eligible, is_virtual, physical_device_id, capabilities_json, verified_capabilities_json, enabled_services_json, priority, created_at_ms, updated_at_ms)
      VALUES
      ('${p1Id}', '${agentId}', 'HP_LaserJet_BW_Simplex', 'P1: B&W Simplex', 'ONLINE', 1, 1, 0, 'DEV_1',
       '{"colour":false,"duplex":false,"paperSizes":["A4"]}', '${JSON.stringify(p1Caps)}', '${enabledBwOnly}', 50, ${nowMs}, ${nowMs}),

      ('${p2Id}', '${agentId}', 'Canon_BW_Duplex', 'P2: B&W Duplex', 'ONLINE', 1, 1, 0, 'DEV_2',
       '{"colour":false,"duplex":true,"paperSizes":["A4"]}', '${JSON.stringify(p2Caps)}', '${enabledBwDuplex}', 40, ${nowMs}, ${nowMs}),

      ('${p3Id}', '${agentId}', 'Epson_Color_Simplex', 'P3: Color Simplex', 'ONLINE', 1, 1, 0, 'DEV_3',
       '{"colour":true,"duplex":false,"paperSizes":["A4"]}', '${JSON.stringify(p3Caps)}', '${enabledColorSimplex}', 30, ${nowMs}, ${nowMs}),

      ('${p4Id}', '${agentId}', 'Xerox_Color_Duplex', 'P4: Color Duplex', 'ONLINE', 1, 1, 0, 'DEV_4',
       '{"colour":true,"duplex":true,"paperSizes":["A4"]}', '${JSON.stringify(p4Caps)}', '${enabledColorDuplex}', 20, ${nowMs}, ${nowMs}),

      ('${p5Id}', '${agentId}', 'Brother_Offline_Printer', 'P5: Offline Multi', 'OFFLINE', 1, 1, 0, 'DEV_5',
       '{"colour":true,"duplex":true,"paperSizes":["A4"]}', '${JSON.stringify(p5Caps)}', '${enabledColorDuplex}', 10, ${nowMs}, ${nowMs});
    `);

    printingRepo = new D1PrintingRepository(d1);
    printingService = new PrintingService(
      printingRepo,
      mockDownloadSigner,
      () => nowMs,
    );
  });

  // Helper to create an order with files
  function createTestOrder(opts: {
    orderId: string;
    jobCode: string;
    pickupCode: string;
    colorMode: "BW" | "COLOR";
    sides: "SINGLE" | "DOUBLE";
    paperSize?: "A4" | "A3";
    copies?: number;
    pages?: number;
  }) {
    const {
      orderId,
      jobCode,
      pickupCode,
      colorMode,
      sides,
      paperSize = "A4",
      copies = 1,
      pages = 5,
    } = opts;
    const fileId = padUuid("fil" + orderId.slice(3));
    const uplId = padUuid("upl" + orderId.slice(3));

    db.exec(`
      INSERT INTO orders (
        id, public_job_code, pickup_code, status, customer_name, customer_phone,
        original_filename, source_page_count, copies, color_mode, paper_size, sides,
        printing_amount_paise, service_charge_paise, total_amount_paise, cleanup_state,
        created_at_ms, updated_at_ms
      ) VALUES (
        '${orderId}', '${jobCode}', '${pickupCode}', 'QUEUED', 'Test Customer', '+919876543210',
        'test.pdf', ${pages}, ${copies}, '${colorMode}', '${paperSize}', '${sides}',
        500, 0, 500, 'ACTIVE',
        ${nowMs}, ${nowMs}
      );

      INSERT INTO order_files (
        id, order_id, position, original_filename, r2_object_key, expected_size_bytes,
        size_bytes, source_page_count, copies, paper_size, color_mode, sides,
        upload_status, print_status, uploaded_at_ms, created_at_ms, updated_at_ms
      ) VALUES (
        '${fileId}', '${orderId}', 1, 'test.pdf', 'orders/${orderId}/test.pdf', 10240,
        10240, ${pages}, ${copies}, '${paperSize}', '${colorMode}', '${sides}',
        'UPLOADED', 'PENDING', ${nowMs}, ${nowMs}, ${nowMs}
      );

      INSERT INTO uploads (
        id, order_id, r2_object_key, original_filename, size_bytes, storage_status,
        uploaded_at_ms, created_at_ms, updated_at_ms
      ) VALUES (
        '${uplId}', '${orderId}', 'orders/${orderId}/test.pdf', 'test.pdf', 10240, 'UPLOADED',
        ${nowMs}, ${nowMs}, ${nowMs}
      );
    `);
  }

  describe("1. Strict Payment Authority: Unpaid Orders Must NEVER Print", () => {
    it("never claims an order when cash is selected but unpaid", async () => {
      const orderId = padUuid("ord00001");
      createTestOrder({
        orderId,
        jobCode: "JOB-CASH-1",
        pickupCode: "PC-01",
        colorMode: "BW",
        sides: "SINGLE",
      });

      // Insert CASH payment in PENDING state (customer selected cash, but admin hasn't confirmed)
      const payId = padUuid("pay00001");
      db.exec(`
        INSERT INTO payments (id, order_id, provider, provider_order_id, status, amount_paise, created_at_ms, updated_at_ms)
        VALUES ('${payId}', '${orderId}', 'CASH', 'csho_${orderId}', 'PENDING', 500, ${nowMs}, ${nowMs});
      `);

      // Agent attempts to claim print work
      const claimed = await printingService.claimOrRenewAll(agentId);
      expect(claimed.length).toBe(0); // MUST NOT claim unpaid cash order!

      // Verify DB status remains QUEUED and unassigned
      const order = db
        .prepare(
          `SELECT status, claimed_by_agent_id FROM orders WHERE id = '${orderId}'`,
        )
        .get() as { status: string; claimed_by_agent_id: string | null };
      expect(order.claimed_by_agent_id).toBeNull();
    });

    it("claims and prints immediately once Admin confirms cash at counter", async () => {
      const orderId = padUuid("ord00002");
      createTestOrder({
        orderId,
        jobCode: "JOB-CASH-2",
        pickupCode: "PC-02",
        colorMode: "BW",
        sides: "SINGLE",
      });

      // Insert confirmed cash payment
      const payId = padUuid("pay00002");
      db.exec(`
        INSERT INTO payments (id, order_id, provider, provider_order_id, status, amount_paise, provider_payment_id, verified_at_ms, created_at_ms, updated_at_ms)
        VALUES ('${payId}', '${orderId}', 'CASH', 'csho_${orderId}', 'PAID', 500, 'CASH_CONFIRMED_admin1', ${nowMs}, ${nowMs}, ${nowMs});
      `);

      // Agent attempts to claim print work
      const claimed = await printingService.claimOrRenewAll(agentId);
      expect(claimed.length).toBe(1);
      expect(claimed[0]?.orderId).toBe(orderId);
      expect(claimed[0]?.printerId).toBe(p1Id);
    });

    it("verifies Razorpay online payment: unpaid order blocked, confirmed order claimed", async () => {
      const orderId = padUuid("ord00003");
      createTestOrder({
        orderId,
        jobCode: "JOB-RZP-1",
        pickupCode: "PC-03",
        colorMode: "BW",
        sides: "SINGLE",
      });

      // Unpaid Razorpay attempt
      const payId = padUuid("pay00003");
      db.exec(`
        INSERT INTO payments (id, order_id, provider, provider_order_id, status, amount_paise, created_at_ms, updated_at_ms)
        VALUES ('${payId}', '${orderId}', 'RAZORPAY', 'rzpo_${orderId}', 'PENDING', 500, ${nowMs}, ${nowMs});
      `);

      expect((await printingService.claimOrRenewAll(agentId)).length).toBe(0);

      // Captured & verified webhook callback arrives
      db.exec(`
        UPDATE payments
        SET status = 'PAID', provider_payment_id = 'pay_2938472938', verified_at_ms = ${nowMs}
        WHERE id = '${payId}';
      `);

      const claimed = await printingService.claimOrRenewAll(agentId);
      expect(claimed.length).toBe(1);
      expect(claimed[0]?.orderId).toBe(orderId);
    });
  });

  describe("2. Five Virtual Printers Capability Routing Matrix", () => {
    it("routes B&W Simplex to P1 (HP LaserJet BW Simplex)", async () => {
      const orderId = padUuid("ord00010");
      createTestOrder({
        orderId,
        jobCode: "JOB-M1",
        pickupCode: "PC-M1",
        colorMode: "BW",
        sides: "SINGLE",
      });
      const payId = padUuid("pay00010");
      db.exec(`
        INSERT INTO payments (id, order_id, provider, provider_order_id, status, amount_paise, provider_payment_id, verified_at_ms, created_at_ms, updated_at_ms)
        VALUES ('${payId}', '${orderId}', 'CASH', 'csho_${orderId}', 'PAID', 500, 'CASH_CONF_1', ${nowMs}, ${nowMs}, ${nowMs});
      `);

      const claimed = await printingService.claimOrRenewAll(agentId);
      expect(claimed.length).toBe(1);
      expect(claimed[0]?.printerId).toBe(p1Id);
      expect(claimed[0]?.windowsPrinterName).toBe("HP_LaserJet_BW_Simplex");
    });

    it("routes B&W Duplex to P2 (Canon BW Duplex) — CANNOT downgrade to P1 Simplex", async () => {
      const orderId = padUuid("ord00011");
      createTestOrder({
        orderId,
        jobCode: "JOB-M2",
        pickupCode: "PC-M2",
        colorMode: "BW",
        sides: "DOUBLE", // Requires Duplex
      });
      const payId = padUuid("pay00011");
      db.exec(`
        INSERT INTO payments (id, order_id, provider, provider_order_id, status, amount_paise, provider_payment_id, verified_at_ms, created_at_ms, updated_at_ms)
        VALUES ('${payId}', '${orderId}', 'CASH', 'csho_${orderId}', 'PAID', 500, 'CASH_CONF_2', ${nowMs}, ${nowMs}, ${nowMs});
      `);

      const claimed = await printingService.claimOrRenewAll(agentId);
      expect(claimed.length).toBe(1);
      expect(claimed[0]?.printerId).toBe(p2Id);
      expect(claimed[0]?.windowsPrinterName).toBe("Canon_BW_Duplex");
    });

    it("routes Color Simplex to P3 (Epson Color Simplex) — CANNOT downgrade to B&W", async () => {
      const orderId = padUuid("ord00012");
      createTestOrder({
        orderId,
        jobCode: "JOB-M3",
        pickupCode: "PC-M3",
        colorMode: "COLOR",
        sides: "SINGLE",
      });
      const payId = padUuid("pay00012");
      db.exec(`
        INSERT INTO payments (id, order_id, provider, provider_order_id, status, amount_paise, provider_payment_id, verified_at_ms, created_at_ms, updated_at_ms)
        VALUES ('${payId}', '${orderId}', 'CASH', 'csho_${orderId}', 'PAID', 500, 'CASH_CONF_3', ${nowMs}, ${nowMs}, ${nowMs});
      `);

      const claimed = await printingService.claimOrRenewAll(agentId);
      expect(claimed.length).toBe(1);
      expect(claimed[0]?.printerId).toBe(p3Id);
      expect(claimed[0]?.windowsPrinterName).toBe("Epson_Color_Simplex");
    });

    it("routes Color Duplex to P4 (Xerox Color Duplex) — Requires both Color AND Duplex", async () => {
      const orderId = padUuid("ord00013");
      createTestOrder({
        orderId,
        jobCode: "JOB-M4",
        pickupCode: "PC-M4",
        colorMode: "COLOR",
        sides: "DOUBLE",
      });
      const payId = padUuid("pay00013");
      db.exec(`
        INSERT INTO payments (id, order_id, provider, provider_order_id, status, amount_paise, provider_payment_id, verified_at_ms, created_at_ms, updated_at_ms)
        VALUES ('${payId}', '${orderId}', 'CASH', 'csho_${orderId}', 'PAID', 500, 'CASH_CONF_4', ${nowMs}, ${nowMs}, ${nowMs});
      `);

      const claimed = await printingService.claimOrRenewAll(agentId);
      expect(claimed.length).toBe(1);
      expect(claimed[0]?.printerId).toBe(p4Id);
      expect(claimed[0]?.windowsPrinterName).toBe("Xerox_Color_Duplex");
    });

    it("safely stalls Color Duplex order in queue when P4 goes OFFLINE (Never prints on P1, P2, P3, or P5)", async () => {
      // Set P4 OFFLINE
      db.exec(`UPDATE printers SET status = 'OFFLINE' WHERE id = '${p4Id}'`);

      const orderId = padUuid("ord00014");
      createTestOrder({
        orderId,
        jobCode: "JOB-M-OFF",
        pickupCode: "PC-MO",
        colorMode: "COLOR",
        sides: "DOUBLE",
      });
      const payId = padUuid("pay00014");
      db.exec(`
        INSERT INTO payments (id, order_id, provider, provider_order_id, status, amount_paise, provider_payment_id, verified_at_ms, created_at_ms, updated_at_ms)
        VALUES ('${payId}', '${orderId}', 'CASH', 'csho_${orderId}', 'PAID', 500, 'CASH_CONF_MO', ${nowMs}, ${nowMs}, ${nowMs});
      `);

      const claimed = await printingService.claimOrRenewAll(agentId);
      // P1 (BW, Simplex) cannot print it
      // P2 (BW, Duplex) cannot print it
      // P3 (Color, Simplex) cannot print it
      // P4 (Color, Duplex) is OFFLINE
      // P5 is OFFLINE
      // Result: Claim MUST be 0! Order safely waits in queue without unauthorized downgrade!
      expect(claimed.length).toBe(0);

      // Restore P4 to ONLINE
      db.exec(`UPDATE printers SET status = 'ONLINE' WHERE id = '${p4Id}'`);
      const claimedAfterOnline = await printingService.claimOrRenewAll(agentId);
      expect(claimedAfterOnline.length).toBe(1);
      expect(claimedAfterOnline[0]?.printerId).toBe(p4Id);
    });

    it("parallel physical printer dispatch: dispatches 2 jobs to P1 (DEV_1) and P2 (DEV_2) concurrently", async () => {
      const ord1 = padUuid("ord00021");
      const ord2 = padUuid("ord00022");
      createTestOrder({
        orderId: ord1,
        jobCode: "JOB-C1",
        pickupCode: "PC-C1",
        colorMode: "BW",
        sides: "SINGLE",
      });
      createTestOrder({
        orderId: ord2,
        jobCode: "JOB-C2",
        pickupCode: "PC-C2",
        colorMode: "BW",
        sides: "DOUBLE",
      });
      const pay1 = padUuid("pay00021");
      const pay2 = padUuid("pay00022");
      db.exec(`
        INSERT INTO payments (id, order_id, provider, provider_order_id, status, amount_paise, provider_payment_id, verified_at_ms, created_at_ms, updated_at_ms)
        VALUES
        ('${pay1}', '${ord1}', 'CASH', 'csho_${ord1}', 'PAID', 500, 'CASH_CONF_C1', ${nowMs}, ${nowMs}, ${nowMs}),
        ('${pay2}', '${ord2}', 'CASH', 'csho_${ord2}', 'PAID', 500, 'CASH_CONF_C2', ${nowMs}, ${nowMs}, ${nowMs});
      `);

      const claimed = await printingService.claimOrRenewAll(agentId);
      expect(claimed.length).toBe(2);
      const printerIds = claimed.map((c) => c.printerId).sort();
      expect(printerIds).toEqual([p1Id, p2Id].sort());
    });
  });

  describe("3. Recovery, Leases, and Duplicate-Print Prevention", () => {
    it("safely recovers expired claims when agent lease expires without duplicate spool", async () => {
      const orderId = padUuid("ord00030");
      createTestOrder({
        orderId,
        jobCode: "JOB-EXP-1",
        pickupCode: "PC-EXP",
        colorMode: "BW",
        sides: "SINGLE",
      });
      const payId = padUuid("pay00030");
      db.exec(`
        INSERT INTO payments (id, order_id, provider, provider_order_id, status, amount_paise, provider_payment_id, verified_at_ms, created_at_ms, updated_at_ms)
        VALUES ('${payId}', '${orderId}', 'CASH', 'csho_${orderId}', 'PAID', 500, 'CASH_CONF_EXP', ${nowMs}, ${nowMs}, ${nowMs});
      `);

      // Claim job
      const claimed = await printingService.claimOrRenewAll(agentId);
      expect(claimed.length).toBe(1);

      // Advance time by 15 minutes: lease naturally expires
      const futureMs = nowMs + 15 * 60 * 1_000;

      // Agent heartbeats at futureMs
      db.exec(
        `UPDATE agents SET last_heartbeat_at_ms = ${futureMs} WHERE id = '${agentId}'`,
      );

      // Run claimOrRenewAll at future time: should safely recover the job and re-issue valid lease
      const reClaimed = await printingRepo.claimOrRenewAll(agentId, futureMs);
      expect(reClaimed.length).toBe(1);
      expect(reClaimed[0]?.orderId).toBe(orderId);
      expect(reClaimed[0]?.leaseExpiresAtMs).toBeGreaterThan(futureMs);
    });
  });
});
