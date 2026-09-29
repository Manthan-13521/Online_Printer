import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

export async function createRuntime(directory, { profileWrites = false } = {}) {
  mkdirSync(directory, { recursive: true });
  const { build } =
    await import("../apps/agent/windows/node_modules/esbuild/lib/main.js");
  const bundle = resolve(directory, "runtime.mjs");
  await build({
    stdin: {
      contents: `export { routeRequest } from './apps/api/worker/src/router.ts'; export { hashPassword, hashSessionToken } from './packages/auth/src/index.ts'; export { RetentionService } from './apps/api/worker/src/retention/service.ts'; export { D1RetentionRepository } from './apps/api/worker/src/retention/repository.ts';`,
      resolveDir: process.cwd(),
    },
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    alias: Object.fromEntries(
      ["domain", "auth", "validation", "pricing", "api-contract", "shared"].map(
        (x) => [`@printgo/${x}`, resolve(`packages/${x}/src/index.ts`)],
      ),
    ),
  });
  const api = await import(bundle);
  const db = new DatabaseSync(resolve(directory, "test.sqlite"));
  for (const name of readdirSync("database/migrations")
    .filter((x) => x.endsWith(".sql"))
    .sort())
    db.exec(readFileSync(`database/migrations/${name}`, "utf8"));
  const writeProfile = new Map();
  if (profileWrites) {
    db.exec(
      "CREATE TEMP TABLE write_observations (table_name TEXT, operation TEXT, transition TEXT)",
    );
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all();
    for (const { name } of tables) {
      const columns = db
        .prepare(`PRAGMA table_info("${name}")`)
        .all()
        .map((c) => c.name);
      const state = ["status", "storage_status", "event_type"].find((c) =>
        columns.includes(c),
      );
      for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
        const from =
          operation === "INSERT" || !state
            ? "'none'"
            : `COALESCE(OLD.${state},'null')`;
        const to =
          operation === "DELETE" || !state
            ? "'none'"
            : `COALESCE(NEW.${state},'null')`;
        db.exec(`CREATE TEMP TRIGGER "profile_${name}_${operation}" AFTER ${operation} ON "${name}"
          BEGIN INSERT INTO write_observations VALUES ('${name}','${operation}',${from} || ' -> ' || ${to}); END`);
      }
    }
  }
  const context = new AsyncLocalStorage();
  const queries = new Map();
  const totals = {
    statements: 0,
    returnedRows: 0,
    changedRows: 0,
    queryMs: 0,
    r2: { PUT: 0, HEAD: 0, GET: 0, DELETE: 0 },
    provider: { create: 0, lookup: 0 },
  };
  class Statement {
    constructor(sql, values = []) {
      this.sql = sql;
      this.values = values;
    }
    bind(...values) {
      return new Statement(this.sql, values);
    }
    execute() {
      const start = performance.now();
      const statement = db.prepare(this.sql);
      const reading = statement.columns().length > 0;
      const results = reading ? statement.all(...this.values) : [];
      const changes = reading
        ? 0
        : Number(statement.run(...this.values).changes);
      const ms = performance.now() - start;
      const key = createHash("sha256")
        .update(this.sql)
        .digest("hex")
        .slice(0, 12);
      const entry = queries.get(key) ?? {
        sql: this.sql,
        calls: 0,
        returnedRows: 0,
        changedRows: 0,
        ms: 0,
        maxMs: 0,
      };
      entry.calls++;
      entry.returnedRows += results.length;
      entry.changedRows += changes;
      entry.ms += ms;
      entry.maxMs = Math.max(entry.maxMs, ms);
      queries.set(key, entry);
      totals.statements++;
      totals.returnedRows += results.length;
      totals.changedRows += changes;
      totals.queryMs += ms;
      const route = context.getStore();
      if (profileWrites) {
        const observed = db
          .prepare(
            "SELECT table_name, operation, transition, COUNT(*) n FROM write_observations GROUP BY table_name, operation, transition",
          )
          .all();
        db.exec("DELETE FROM write_observations");
        for (const row of observed) {
          const endpoint = route?.endpoint ?? "background";
          const profileKey = JSON.stringify([
            key,
            endpoint,
            row.table_name,
            row.operation,
            row.transition,
          ]);
          const item = writeProfile.get(profileKey) ?? {
            sqlId: key,
            sql: this.sql,
            endpoint,
            category: endpoint.startsWith("retention")
              ? "retention"
              : endpoint === "background" || endpoint.startsWith("idle")
                ? "background"
                : "per-order",
            table: row.table_name,
            operation: row.operation,
            transition: row.transition,
            tableRowsWritten: 0,
          };
          item.tableRowsWritten += row.n;
          writeProfile.set(profileKey, item);
        }
      }
      if (route) {
        route.statements++;
        route.returnedRows += results.length;
        route.changedRows += changes;
        route.queryMs += ms;
      }
      return { success: true, results, meta: { changes, duration: ms } };
    }
    async run() {
      return this.execute();
    }
    async all() {
      return this.execute();
    }
    async first(column) {
      const row = this.execute().results[0] ?? null;
      return column && row ? row[column] : row;
    }
  }
  const DB = {
    prepare: (sql) => new Statement(sql),
    async batch(statements) {
      db.exec("BEGIN");
      try {
        const result = statements.map((s) => s.execute());
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const now = Date.now();
  db.prepare(
    "INSERT INTO installation (id,shop_name,online_printing_enabled,identification_sheet_enabled,created_at_ms,updated_at_ms) VALUES (1,?,1,0,?,?)",
  ).run("Synthetic audit shop", now, now);
  for (const paper of ["A4", "A3"])
    for (const color of ["BW", "COLOR"])
      for (const sides of ["SINGLE", "DOUBLE"])
        db.prepare(
          "INSERT INTO print_rates (id,paper_size,color_mode,sides,price_per_page_paise,enabled,created_at_ms,updated_at_ms) VALUES (?,?,?,?,100,1,?,?)",
        ).run(randomUUID(), paper, color, sides, now, now);
  for (const [i, bounds] of [
    [0, 2097152],
    [2097152, 5242880],
    [5242880, 10485760],
    [10485760, 26214400],
  ].entries())
    db.prepare(
      "INSERT INTO file_size_service_charges (id,min_bytes_exclusive,max_bytes_inclusive,charge_paise,sort_order,enabled,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,1,?,?)",
    ).run(randomUUID(), bounds[0], bounds[1], 0, i + 1, now, now);
  const password = randomUUID();
  const adminId = randomUUID();
  const adminToken = "S".repeat(43);
  db.prepare(
    "INSERT INTO admins (id,login_identifier,password_hash,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?)",
  ).run(adminId, "synthetic-admin", await api.hashPassword(password), now, now);
  db.prepare(
    "INSERT INTO admin_sessions (id,admin_id,token_hash,created_at_ms,expires_at_ms) VALUES (?,?,?,?,?)",
  ).run(
    randomUUID(),
    adminId,
    await api.hashSessionToken(adminToken),
    now,
    now + 86400000,
  );
  const agentTokens = [];
  for (let i = 0; i < 5; i++) {
    const id = randomUUID();
    const token = String.fromCharCode(65 + i).repeat(43);
    agentTokens.push(token);
    db.prepare(
      "INSERT INTO agents (id,display_name,credential_hash,is_active,paired_at_ms,last_heartbeat_at_ms,created_at_ms,updated_at_ms) VALUES (?,?,?,1,?,?,?,?)",
    ).run(
      id,
      `Synthetic ${i}`,
      await api.hashSessionToken(token),
      now,
      now,
      now,
      now,
    );
    db.prepare(
      "INSERT INTO printers (id,agent_id,display_name,windows_printer_name,enabled,status,capabilities_json,last_status_at_ms,created_at_ms,updated_at_ms) VALUES (?,?,?,?,1,'ONLINE',?,?,?,?)",
    ).run(
      randomUUID(),
      id,
      `Synthetic ${i}`,
      `Synthetic ${i}`,
      JSON.stringify({ colour: false, duplex: false, paperSizes: ["A4"] }),
      now,
      now,
      now,
    );
  }
  const objects = new Map();
  const metadata = new Map();
  const PDF_BUCKET = {
    async head(key) {
      totals.r2.HEAD++;
      const b = objects.get(key);
      return b ? { size: b.length } : null;
    },
    async get(key, options) {
      totals.r2.GET++;
      const b = objects.get(key);
      if (!b) return null;
      const data = options?.range
        ? b.subarray(
            options.range.offset,
            options.range.offset + options.range.length,
          )
        : b;
      return {
        body: new Uint8Array(data),
        httpMetadata: metadata.get(key),
        async arrayBuffer() {
          return Uint8Array.from(data).buffer;
        },
      };
    },
    async put(key, bytes, options) {
      metadata.set(key, options?.httpMetadata);
      totals.r2.PUT++;
      objects.set(key, Buffer.from(bytes));
    },
    async delete(key) {
      totals.r2.DELETE++;
      objects.delete(key);
      metadata.delete(key);
    },
  };
  const providerOrders = new Map();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const parsed = new URL(String(url));
    if (parsed.origin !== "https://api.razorpay.com")
      throw new Error("Harness blocked outbound network");
    if (parsed.pathname === "/v1/orders" && options?.method === "POST") {
      totals.provider.create++;
      const input = JSON.parse(options.body);
      const id = `order_${randomUUID().replaceAll("-", "")}`;
      providerOrders.set(id, input);
      return Response.json({
        id,
        amount: input.amount,
        currency: "INR",
        status: "created",
      });
    }
    if (parsed.pathname.startsWith("/v1/payments/")) {
      totals.provider.lookup++;
      const id = decodeURIComponent(
        parsed.pathname.slice("/v1/payments/".length),
      );
      const orderId = id.replace("pay_", "order_");
      const order = providerOrders.get(orderId);
      if (!order) return Response.json({}, { status: 404 });
      return Response.json({
        id,
        order_id: orderId,
        amount: order.amount,
        currency: "INR",
        status: "captured",
      });
    }
    throw new Error("Unexpected mocked provider operation");
  };
  const env = {
    DB,
    PDF_BUCKET,
    APP_ENV: "production",
    ADMIN_ALLOWED_ORIGIN: "https://admin.audit.invalid",
    CUSTOMER_ALLOWED_ORIGIN: "https://customer.audit.invalid",
    R2_ACCOUNT_ID: "synthetic",
    R2_BUCKET_NAME: "synthetic",
    R2_ACCESS_KEY_ID: "synthetic",
    R2_SECRET_ACCESS_KEY: randomUUID(),
    RAZORPAY_KEY_ID: "rzp_test_synthetic",
    RAZORPAY_KEY_SECRET: randomUUID(),
    RAZORPAY_WEBHOOK_SECRET: randomUUID(),
  };
  return {
    api,
    env,
    db,
    context,
    totals,
    queries,
    writeProfile,
    objects,
    providerOrders,
    agentTokens,
    adminToken,
    password,
    close() {
      globalThis.fetch = originalFetch;
      db.close();
    },
  };
}
