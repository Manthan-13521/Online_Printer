/* eslint-disable */
import { describe, expect, it, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { QueueController } from "./queue-controller";

describe("QueueController", () => {
  let db: DatabaseSync;
  let controller: QueueController;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE orders (
        id TEXT PRIMARY KEY, status TEXT, cleanup_state TEXT,
        updated_at_ms INTEGER, customer_name TEXT, customer_phone TEXT,
        original_filename TEXT, color_mode TEXT, paper_size TEXT, sides TEXT,
        created_at_ms INTEGER, claimed_by_agent_id TEXT, claim_id TEXT,
        claim_expires_at_ms INTEGER, claimed_at_ms INTEGER
      );
    `);

    // The repository expects a D1-like interface
    const mockDb = {
      prepare: (sql: string) => {
        const stmt = db.prepare(sql);
        return {
          bind: (...params: any[]) => ({
            run: async () => {
              const res = stmt.run(...params);
              return { meta: { changes: res.changes } };
            },
            first: async () => stmt.get(...params),
            all: async () => ({ results: stmt.all(...params) }),
          }),
          run: async () => {
            const res = stmt.run();
            return { meta: { changes: res.changes } };
          },
          first: async () => stmt.get(),
          all: async () => ({ results: stmt.all() }),
        };
      },
      batch: async (statements: any[]) => {
        const results = [];
        for (const s of statements) {
          if (s.sql.trim().toUpperCase().startsWith("SELECT")) {
            results.push({
              results: db.prepare(s.sql).all(...(s.params || [])),
              meta: { changes: 0 },
            });
          } else {
            const res = db.prepare(s.sql).run(...(s.params || []));
            results.push({ results: [], meta: { changes: res.changes } });
          }
        }
        return results;
      },
    };

    controller = new QueueController({ db: mockDb } as any);
  });

  it("safely clears only QUEUED orders", async () => {
    db.exec(
      `INSERT INTO orders (id, status, cleanup_state, updated_at_ms, customer_name, customer_phone, original_filename, color_mode, paper_size, sides, created_at_ms, claimed_by_agent_id, claim_id, claim_expires_at_ms, claimed_at_ms) VALUES 
       ('1', 'QUEUED', 'ACTIVE', 100, 't', 't', 't', 'BW', 'A4', 'SINGLE', 100, NULL, NULL, NULL, NULL),
       ('2', 'QUEUED', 'ACTIVE', 100, 't', 't', 't', 'BW', 'A4', 'SINGLE', 100, NULL, NULL, NULL, NULL),
       ('3', 'PRINTING', 'ACTIVE', 100, 't', 't', 't', 'BW', 'A4', 'SINGLE', 100, '1', '1', 200, 100),
       ('4', 'COMPLETION_UNKNOWN', 'ACTIVE', 100, 't', 't', 't', 'BW', 'A4', 'SINGLE', 100, '1', '4', 200, 100)`,
    );

    (controller as any).printingRepo = {
      db: {
        prepare: (sql: string) => ({
          bind: (...params: any[]) => ({ sql, params }),
        }),
        batch: async () => {
          const changes = db
            .prepare(
              `UPDATE orders SET status = 'CANCELLED' WHERE status = 'QUEUED' AND cleanup_state = 'ACTIVE'`,
            )
            .run().changes;
          const skipped = db
            .prepare(
              `SELECT count(*) as c FROM orders WHERE status IN ('CLAIMED', 'SPOOLING', 'PRINTING', 'PRINT_BLOCKED', 'COMPLETION_UNKNOWN') AND cleanup_state = 'ACTIVE'`,
            )
            .get() as any;
          return [{ meta: { changes } }, { results: [{ count: skipped.c }] }];
        },
      },
    };

    const result = await controller.clearWaitingQueue(200);
    expect(result.clearedCount).toBe(2);
    expect(result.skippedCount).toBe(2);
  });

  it("fails to remove an active order", async () => {
    db.exec(
      `INSERT INTO orders (id, status, cleanup_state, updated_at_ms, customer_name, customer_phone, original_filename, color_mode, paper_size, sides, created_at_ms, claimed_by_agent_id, claim_id, claim_expires_at_ms, claimed_at_ms) VALUES ('5', 'PRINTING', 'ACTIVE', 100, 't', 't', 't', 'BW', 'A4', 'SINGLE', 100, '1', '1', 200, 100)`,
    );

    (controller as any).printingRepo = {
      db: {
        prepare: () => ({
          bind: () => ({ run: async () => ({ meta: { changes: 0 } }) }),
        }),
      },
    };

    await expect(controller.removeFromQueue("5", 200)).rejects.toThrow(
      "ORDER_CANNOT_BE_REMOVED",
    );
  });
});
