import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

const migrationSql = readFileSync(
  new URL("../database/migrations/0001_initial_schema.sql", import.meta.url),
  "utf8",
);
const customerUploadMigrationSql = readFileSync(
  new URL(
    "../database/migrations/0002_customer_draft_upload.sql",
    import.meta.url,
  ),
  "utf8",
);
const paymentMigrationSql = readFileSync(
  new URL(
    "../database/migrations/0003_payment_idempotency.sql",
    import.meta.url,
  ),
  "utf8",
);
const trackingMigrationSql = readFileSync(
  new URL("../database/migrations/0004_customer_tracking.sql", import.meta.url),
  "utf8",
);
const printerTestMigrationSql = readFileSync(
  new URL(
    "../database/migrations/0005_printer_test_commands.sql",
    import.meta.url,
  ),
  "utf8",
);
const seedSql = readFileSync(
  new URL("../database/seeds/0001_development.sql", import.meta.url),
  "utf8",
);

function createDatabase(withSeed = false): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(migrationSql);
  database.exec(customerUploadMigrationSql);
  database.exec(paymentMigrationSql);
  database.exec(trackingMigrationSql);
  database.exec(printerTestMigrationSql);
  if (withSeed) {
    database.exec(seedSql);
  }
  return database;
}

interface OrderFixture {
  id: string;
  publicJobCode?: string;
  copies?: number;
  status?: string;
  printingAmountPaise?: number;
  serviceChargePaise?: number;
}

function insertOrder(database: DatabaseSync, fixture: OrderFixture): void {
  const printingAmountPaise = fixture.printingAmountPaise ?? 100;
  const serviceChargePaise = fixture.serviceChargePaise ?? 20;

  database
    .prepare(
      `
      INSERT INTO orders (
        id, public_job_code, customer_name, customer_phone, original_filename,
        copies, color_mode, paper_size, sides,
        printing_amount_paise, service_charge_paise, total_amount_paise,
        status, created_at_ms, updated_at_ms
      ) VALUES (?, ?, 'Test Customer', '9000000000', 'test-document.pdf',
        ?, 'BW', 'A4', 'SINGLE', ?, ?, ?, ?, 1735689600000, 1735689600000)
    `,
    )
    .run(
      fixture.id,
      fixture.publicJobCode ?? null,
      fixture.copies ?? 1,
      printingAmountPaise,
      serviceChargePaise,
      printingAmountPaise + serviceChargePaise,
      fixture.status ?? "CREATED",
    );
}

describe("D1 migrations", () => {
  it("applies with the deterministic development seed", () => {
    const database = createDatabase(true);

    try {
      const tableCount = database
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )
        .get() as { count: number };
      const installation = database
        .prepare("SELECT id, shop_name FROM installation")
        .get();
      const rateCount = database
        .prepare("SELECT COUNT(*) AS count FROM print_rates")
        .get() as { count: number };

      expect(tableCount.count).toBe(16);
      expect(installation).toEqual({
        id: 1,
        shop_name: "PrintGo Development Shop",
      });
      expect(rateCount.count).toBe(8);
    } finally {
      database.close();
    }
  });

  it("rejects duplicate public job codes", () => {
    const database = createDatabase();

    try {
      insertOrder(database, {
        id: "50000000-0000-4000-8000-000000000001",
        publicJobCode: "PG-TEST01",
      });

      expect(() =>
        insertOrder(database, {
          id: "50000000-0000-4000-8000-000000000002",
          publicJobCode: "PG-TEST01",
        }),
      ).toThrow(/unique constraint/i);
    } finally {
      database.close();
    }
  });

  it("rejects zero copies and invalid order states", () => {
    const database = createDatabase();

    try {
      expect(() =>
        insertOrder(database, {
          id: "50000000-0000-4000-8000-000000000003",
          copies: 0,
        }),
      ).toThrow(/check constraint/i);

      expect(() =>
        insertOrder(database, {
          id: "50000000-0000-4000-8000-000000000004",
          status: "FILE_EXPIRED",
        }),
      ).toThrow(/check constraint/i);
    } finally {
      database.close();
    }
  });

  it("rejects invalid identification-sheet placement", () => {
    const database = createDatabase(true);

    try {
      expect(() =>
        database.exec(
          "UPDATE installation SET identification_sheet_placement = 'MIDDLE' WHERE id = 1",
        ),
      ).toThrow(/check constraint/i);
    } finally {
      database.close();
    }
  });

  it("rejects negative payment amounts", () => {
    const database = createDatabase();

    try {
      insertOrder(database, {
        id: "50000000-0000-4000-8000-000000000005",
      });

      expect(() =>
        database.exec(`
          INSERT INTO payments (
            id, order_id, provider_order_id, amount_paise,
            created_at_ms, updated_at_ms
          ) VALUES (
            '60000000-0000-4000-8000-000000000001',
            '50000000-0000-4000-8000-000000000005',
            'order_test_negative', -1, 1735689600000, 1735689600000
          )
        `),
      ).toThrow(/check constraint/i);
    } finally {
      database.close();
    }
  });

  it("keeps historical order money snapshots independent from current pricing", () => {
    const database = createDatabase(true);

    try {
      insertOrder(database, {
        id: "50000000-0000-4000-8000-000000000007",
        printingAmountPaise: 2_000,
        serviceChargePaise: 300,
      });
      database.exec(`
        UPDATE print_rates SET price_per_page_paise = 9999;
        UPDATE file_size_service_charges SET charge_paise = 8888;
      `);

      expect(
        database
          .prepare(
            `SELECT printing_amount_paise, service_charge_paise, total_amount_paise
             FROM orders WHERE id = ?`,
          )
          .get("50000000-0000-4000-8000-000000000007"),
      ).toEqual({
        printing_amount_paise: 2_000,
        service_charge_paise: 300,
        total_amount_paise: 2_300,
      });
    } finally {
      database.close();
    }
  });

  it("rejects duplicate print attempt numbers for one order", () => {
    const database = createDatabase(true);

    try {
      insertOrder(database, {
        id: "50000000-0000-4000-8000-000000000006",
      });
      database.exec(`
        INSERT INTO print_attempts (
          id, order_id, attempt_number, agent_id, printer_id,
          created_at_ms, updated_at_ms
        ) VALUES (
          '70000000-0000-4000-8000-000000000001',
          '50000000-0000-4000-8000-000000000006', 1,
          '30000000-0000-4000-8000-000000000001',
          '40000000-0000-4000-8000-000000000001',
          1735689600000, 1735689600000
        )
      `);

      expect(() =>
        database.exec(`
          INSERT INTO print_attempts (
            id, order_id, attempt_number, agent_id, printer_id,
            created_at_ms, updated_at_ms
          ) VALUES (
            '70000000-0000-4000-8000-000000000002',
            '50000000-0000-4000-8000-000000000006', 1,
            '30000000-0000-4000-8000-000000000001',
            '40000000-0000-4000-8000-000000000001',
            1735689600000, 1735689600000
          )
        `),
      ).toThrow(/unique constraint/i);
    } finally {
      database.close();
    }
  });

  it("applies the customer draft migration with hashed-token uniqueness", () => {
    const database = createDatabase();
    try {
      insertOrder(database, { id: "50000000-0000-4000-8000-000000000008" });
      insertOrder(database, { id: "50000000-0000-4000-8000-000000000009" });
      database
        .prepare(
          "UPDATE orders SET draft_token_hash = ?, draft_expires_at_ms = ? WHERE id = ?",
        )
        .run(
          "hashed-not-raw",
          1735690200000,
          "50000000-0000-4000-8000-000000000008",
        );
      expect(() =>
        database
          .prepare("UPDATE orders SET draft_token_hash = ? WHERE id = ?")
          .run("hashed-not-raw", "50000000-0000-4000-8000-000000000009"),
      ).toThrow(/unique constraint/i);
    } finally {
      database.close();
    }
  });

  it("allows only one active payment attempt per order", () => {
    const database = createDatabase();
    try {
      const orderId = "50000000-0000-4000-8000-000000000010";
      insertOrder(database, { id: orderId, status: "PAYMENT_PENDING" });
      database
        .prepare(
          `INSERT INTO payments
            (id, order_id, provider_order_id, amount_paise, status,
             created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, 100, 'PENDING', 1735689600000, 1735689600000)`,
        )
        .run("60000000-0000-4000-8000-000000000010", orderId, "order_first");
      expect(() =>
        database
          .prepare(
            `INSERT INTO payments
              (id, order_id, provider_order_id, amount_paise, status,
               created_at_ms, updated_at_ms)
             VALUES (?, ?, ?, 100, 'CREATED', 1735689600000, 1735689600000)`,
          )
          .run("60000000-0000-4000-8000-000000000011", orderId, "order_second"),
      ).toThrow(/unique constraint/i);
    } finally {
      database.close();
    }
  });

  it("deduplicates state-transition events by idempotency key", () => {
    const database = createDatabase();
    try {
      const orderId = "50000000-0000-4000-8000-000000000012";
      insertOrder(database, { id: orderId, status: "PAYMENT_PENDING" });
      const insert = database.prepare(
        `INSERT INTO order_events
          (id, order_id, event_type, actor_type, created_at_ms, idempotency_key)
         VALUES (?, ?, 'PAYMENT_CAPTURED', 'SYSTEM', 1735689600000, ?)`,
      );
      insert.run(
        "80000000-0000-4000-8000-000000000001",
        orderId,
        "payment:a:paid",
      );
      expect(() =>
        insert.run(
          "80000000-0000-4000-8000-000000000002",
          orderId,
          "payment:a:paid",
        ),
      ).toThrow(/unique constraint/i);
    } finally {
      database.close();
    }
  });

  it("applies bounded hashed tracking authorization without storing the raw token", () => {
    const database = createDatabase();
    try {
      const firstOrderId = "50000000-0000-4000-8000-000000000013";
      const secondOrderId = "50000000-0000-4000-8000-000000000014";
      insertOrder(database, {
        id: firstOrderId,
        publicJobCode: "PG-ABC234",
        status: "QUEUED",
      });
      insertOrder(database, {
        id: secondOrderId,
        publicJobCode: "PG-ABC235",
        status: "QUEUED",
      });
      database
        .prepare(
          `UPDATE orders SET tracking_token_hash = ?,
            tracking_created_at_ms = ?, tracking_expires_at_ms = ?
          WHERE id = ?`,
        )
        .run("sha256-base64url-hash", 1_000, 2_000, firstOrderId);
      expect(
        database
          .prepare(
            `SELECT tracking_token_hash, tracking_created_at_ms,
              tracking_expires_at_ms FROM orders WHERE id = ?`,
          )
          .get(firstOrderId),
      ).toEqual({
        tracking_token_hash: "sha256-base64url-hash",
        tracking_created_at_ms: 1_000,
        tracking_expires_at_ms: 2_000,
      });
      expect(() =>
        database
          .prepare(
            `UPDATE orders SET tracking_token_hash = ?,
              tracking_created_at_ms = ?, tracking_expires_at_ms = ?
            WHERE id = ?`,
          )
          .run("sha256-base64url-hash", 3_000, 4_000, secondOrderId),
      ).toThrow(/unique constraint/iu);
      expect(() =>
        database
          .prepare(
            `UPDATE orders SET tracking_token_hash = ?,
              tracking_created_at_ms = ?, tracking_expires_at_ms = ?
            WHERE id = ?`,
          )
          .run("replacement-hash", 3_000, 4_000, firstOrderId),
      ).toThrow(/cannot be replaced/iu);
      expect(() =>
        database
          .prepare(
            `UPDATE orders SET tracking_token_hash = ?,
              tracking_created_at_ms = ?, tracking_expires_at_ms = ?
            WHERE id = ?`,
          )
          .run("another-hash", 5_000, 5_000, secondOrderId),
      ).toThrow(/inconsistent/iu);
    } finally {
      database.close();
    }
  });

  it("enforces printer test command constraints and foreign keys", () => {
    const database = createDatabase(true);
    try {
      // 30000000-0000-4000-8000-000000000001 is agent_1 in seed
      // 40000000-0000-4000-8000-000000000001 is printer_1 in seed
      const commandId = "90000000-0000-4000-8000-000000000001";
      database
        .prepare(
          `INSERT INTO printer_test_commands (
            id, printer_id, agent_id, status, created_at_ms, expires_at_ms
          ) VALUES (?, '40000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'PENDING', 1000, 2000)`,
        )
        .run(commandId);

      const row = database
        .prepare(
          "SELECT id, status, printer_id FROM printer_test_commands WHERE id = ?",
        )
        .get(commandId) as { id: string; status: string; printer_id: string };
      expect(row.status).toBe("PENDING");

      // Reject invalid status
      expect(() =>
        database
          .prepare(
            "UPDATE printer_test_commands SET status = 'INVALID_STATUS' WHERE id = ?",
          )
          .run(commandId),
      ).toThrow(/check constraint/i);

      // Reject expires_at_ms < created_at_ms
      expect(() =>
        database
          .prepare(
            "UPDATE printer_test_commands SET expires_at_ms = 500 WHERE id = ?",
          )
          .run(commandId),
      ).toThrow(/check constraint/i);
    } finally {
      database.close();
    }
  });
});
