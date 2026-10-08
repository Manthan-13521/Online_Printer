import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { D1AgentRepository, toAdminTestPrintDetails } from "./repository.js";

const migrations = [
  "0001_initial_schema.sql",
  "0002_customer_draft_upload.sql",
  "0003_payment_idempotency.sql",
  "0004_customer_tracking.sql",
  "0005_printer_test_commands.sql",
  "0006_paid_print_execution.sql",
  "0007_performance_optimization_indexes.sql",
  "0008_production_printer_reliability.sql",
  "0009_retention_and_pii_purge.sql",
  "0010_efficiency_and_branding.sql",
  "0011_retention_retry_schedule.sql",
  "0012_multi_file_cleanup_and_app_branding.sql",
  "0013_d1_usage_optimization.sql",
  "0014_addon_services.sql",
  "0015_phase3_priority_tracking_discounts.sql",
  "0016_phase4_failure_recovery_and_pause.sql",
  "0017_phase5_fallback_and_reprint_protection.sql",
  "0018_phase6_history_cleanup.sql",
].map((name) =>
  readFileSync(
    new URL(`../../../../../database/migrations/${name}`, import.meta.url),
    "utf8",
  ),
);

class SqliteD1Statement {
  private bindings: SQLInputValue[] = [];

  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): SqliteD1Statement {
    this.bindings = values as SQLInputValue[];
    return this;
  }

  run(): Promise<D1Result> {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return Promise.resolve({
      success: true,
      meta: { changes: Number(result.changes) },
      results: [],
    } as unknown as D1Result);
  }

  first<T>(): Promise<T | null> {
    const row = this.database.prepare(this.sql).get(...this.bindings);
    return Promise.resolve((row as T | undefined) ?? null);
  }

  all<T>(): Promise<D1Result<T>> {
    const rows = this.database.prepare(this.sql).all(...this.bindings) as T[];
    return Promise.resolve({
      success: true,
      meta: { changes: 0 },
      results: rows,
    } as unknown as D1Result<T>);
  }
}

function asD1(database: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      return new SqliteD1Statement(database, sql);
    },
    async batch(statements: SqliteD1Statement[]) {
      database.exec("BEGIN");
      try {
        const results: D1Result[] = [];
        for (const statement of statements) results.push(await statement.run());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
}

describe("D1AgentRepository safety invariants", () => {
  let database: DatabaseSync;
  let repository: D1AgentRepository;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    for (const migration of migrations) database.exec(migration);
    repository = new D1AgentRepository(asD1(database));
  });

  afterEach(() => database.close());

  it("wakes print claiming when only a retry-pending order exists", async () => {
    database
      .prepare(
        `INSERT INTO agents
         (id, display_name, credential_hash, is_active, paired_at_ms,
          last_heartbeat_at_ms, created_at_ms, updated_at_ms)
         VALUES (?, 'Agent', 'retry_hash', 1, 1000, 1000, 1000, 1000)`,
      )
      .run("20000000-0000-4000-8000-000000000003");
    database
      .prepare(
        `INSERT INTO orders
         (id, customer_name, customer_phone, original_filename,
          color_mode, paper_size, sides, status, created_at_ms, updated_at_ms)
         VALUES (?, 'Customer', '0000000000', 'document.pdf',
          'BW', 'A4', 'SINGLE', 'RETRY_PENDING', 1000, 1000)`,
      )
      .run("10000000-0000-4000-8000-000000000003");

    const agent = await repository.findAgentByCredentialHash(
      "retry_hash",
      2_000,
    );
    expect(agent?.hasPrintWork).toBe(true);
  });

  it("creates the Agent before attaching the pair-code foreign key and consumes once", async () => {
    database
      .prepare(
        `INSERT INTO agent_pair_codes
         (id, code_hash, expires_at_ms, created_at_ms)
         VALUES (?, ?, ?, ?)`,
      )
      .run("10000000-0000-4000-8000-000000000001", "pair_hash", 2_000, 1_000);

    const input = {
      pairCodeId: "10000000-0000-4000-8000-000000000001",
      agentId: "20000000-0000-4000-8000-000000000001",
      displayName: "Front Desk PC",
      credentialHash: "credential_hash",
      nowMs: 1_500,
    };
    await expect(repository.consumePairCodeAndCreateAgent(input)).resolves.toBe(
      true,
    );
    await expect(repository.consumePairCodeAndCreateAgent(input)).resolves.toBe(
      false,
    );

    expect(
      database
        .prepare("SELECT id, last_heartbeat_at_ms FROM agents WHERE id = ?")
        .get(input.agentId),
    ).toEqual({ id: input.agentId, last_heartbeat_at_ms: null });
    expect(
      database
        .prepare(
          "SELECT used_at_ms, paired_agent_id FROM agent_pair_codes WHERE id = ?",
        )
        .get(input.pairCodeId),
    ).toEqual({ used_at_ms: 1_500, paired_agent_id: input.agentId });
  });

  it("marks a previously discovered printer offline when a fresh heartbeat omits it", async () => {
    database
      .prepare(
        `INSERT INTO agents
         (id, display_name, credential_hash, is_active, paired_at_ms,
          last_heartbeat_at_ms, created_at_ms, updated_at_ms)
         VALUES (?, 'Agent', 'hash', 1, 1000, 1000, 1000, 1000)`,
      )
      .run("20000000-0000-4000-8000-000000000002");
    database
      .prepare(
        `INSERT INTO printers
         (id, agent_id, display_name, windows_printer_name, enabled, status,
          last_status_at_ms, created_at_ms, updated_at_ms)
         VALUES (?, ?, 'Canon', 'Canon Exact Queue', 1, 'ONLINE', 1000, 1000, 1000)`,
      )
      .run(
        "30000000-0000-4000-8000-000000000001",
        "20000000-0000-4000-8000-000000000002",
      );

    await repository.updateHeartbeat({
      agentId: "20000000-0000-4000-8000-000000000002",
      nowMs: 2_000,
      printers: [],
    });

    expect(
      database
        .prepare(
          "SELECT status, status_reason, last_status_at_ms FROM printers WHERE id = ?",
        )
        .get("30000000-0000-4000-8000-000000000001"),
    ).toEqual({
      status: "OFFLINE",
      status_reason: "Not reported by latest Agent heartbeat",
      last_status_at_ms: 2_000,
    });
  });

  it.each(["PENDING", "CLAIMED", "SUBMITTED"])(
    "presents stale %s diagnostics as terminal without losing spool identity",
    (status) => {
      expect(
        toAdminTestPrintDetails(
          {
            id: "40000000-0000-4000-8000-000000000001",
            printer_id: "30000000-0000-4000-8000-000000000001",
            agent_id: "20000000-0000-4000-8000-000000000002",
            status,
            spooler_job_id: status === "SUBMITTED" ? "451" : null,
            failure_code: null,
            failure_detail: null,
            created_at_ms: 1_000,
            expires_at_ms: 2_000,
            claimed_at_ms: status === "PENDING" ? null : 1_500,
            finished_at_ms: null,
          },
          2_001,
        ),
      ).toEqual(
        expect.objectContaining({
          status: "EXPIRED",
          spoolerJobId: status === "SUBMITTED" ? "451" : null,
        }),
      );
    },
  );
});
