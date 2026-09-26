import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { hashPassword } from "../packages/auth/dist/index.js";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const rawArgs = process.argv.slice(2);
let isRemote = false;
let databaseName = null;
let loginIdentifier = "admin";

for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i];
  if (arg === "--remote") {
    isRemote = true;
  } else if (arg === "--database" && i + 1 < rawArgs.length) {
    databaseName = rawArgs[++i];
  } else if (arg.startsWith("--database=")) {
    databaseName = arg.slice("--database=".length);
  } else if (arg === "--login" && i + 1 < rawArgs.length) {
    loginIdentifier = rawArgs[++i];
  } else if (arg.startsWith("--login=")) {
    loginIdentifier = arg.slice("--login=".length);
  } else if (!arg.startsWith("-")) {
    loginIdentifier = arg;
  }
}

loginIdentifier = loginIdentifier.trim().toLocaleLowerCase("en-US");

if (!loginIdentifier || loginIdentifier.length > 100) {
  throw new Error("Login must contain 1 to 100 characters.");
}

if (isRemote) {
  if (!databaseName || !databaseName.trim()) {
    throw new Error(
      "Remote bootstrap requires an explicit database name using --database <name>.",
    );
  }
  if (databaseName.trim() === "printgo-local") {
    throw new Error("Cannot run remote bootstrap against printgo-local.");
  }

  // Pre-flight check: refuse to overwrite existing production admin
  process.stdout.write(`Checking remote database '${databaseName}'...\n`);
  const checkResult = spawnSync(
    "pnpm",
    [
      "--dir",
      "apps/api/worker",
      "exec",
      "wrangler",
      "d1",
      "execute",
      databaseName,
      "--remote",
      "--command=SELECT COUNT(*) AS count FROM admins;",
      "--json",
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );

  if (checkResult.status !== 0) {
    throw new Error(
      `Failed to query remote database '${databaseName}': ${checkResult.stderr || checkResult.stdout}`,
    );
  }

  try {
    const parsed = JSON.parse(checkResult.stdout);
    const count = parsed?.[0]?.results?.[0]?.count ?? 0;
    if (count > 0) {
      throw new Error(
        `A production admin already exists in '${databaseName}'. Refusing to overwrite existing production admin credentials.`,
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("already exists")) {
      throw err;
    }
    throw new Error(
      `Could not parse query result from remote database: ${checkResult.stdout}`,
      { cause: err },
    );
  }
}

async function readSecret(prompt) {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks)
      .toString("utf8")
      .replace(/\r?\n$/u, "");
  }
  process.stdout.write(prompt);
  const disabled = spawnSync("stty", ["-echo"], {
    stdio: ["inherit", "ignore", "inherit"],
  });
  if (disabled.status !== 0)
    throw new Error("Could not disable terminal echo.");
  try {
    return await new Promise((resolve) => {
      process.stdin.setEncoding("utf8");
      process.stdin.once("data", (value) =>
        resolve(value.replace(/\r?\n$/u, "")),
      );
      process.stdin.resume();
    });
  } finally {
    spawnSync("stty", ["echo"], { stdio: ["inherit", "ignore", "inherit"] });
    process.stdout.write("\n");
    process.stdin.pause();
  }
}

const password = await readSecret(
  isRemote
    ? `New PRODUCTION admin password for '${loginIdentifier}': `
    : `New local admin password for '${loginIdentifier}': `,
);

if (password.length < 12 || password.length > 128) {
  throw new Error("Password must contain 12 to 128 characters.");
}

const passwordHash = await hashPassword(password);
const now = Date.now();
const sqlString = (value) => `'${value.replaceAll("'", "''")}'`;

const sql = isRemote
  ? `INSERT INTO admins (
  id, singleton_key, login_identifier, password_hash, is_active,
  password_changed_at_ms, created_at_ms, updated_at_ms
) VALUES (
  ${sqlString(randomUUID())}, 1, ${sqlString(loginIdentifier)}, ${sqlString(passwordHash)}, 1,
  ${now}, ${now}, ${now}
);
`
  : `UPDATE admin_sessions SET revoked_at_ms = ${now} WHERE revoked_at_ms IS NULL;
INSERT INTO admins (
  id, singleton_key, login_identifier, password_hash, is_active,
  password_changed_at_ms, created_at_ms, updated_at_ms
) VALUES (
  ${sqlString(randomUUID())}, 1, ${sqlString(loginIdentifier)}, ${sqlString(passwordHash)}, 1,
  ${now}, ${now}, ${now}
)
ON CONFLICT(singleton_key) DO UPDATE SET
  login_identifier = excluded.login_identifier,
  password_hash = excluded.password_hash,
  is_active = 1,
  password_changed_at_ms = excluded.password_changed_at_ms,
  updated_at_ms = excluded.updated_at_ms;
`;

const temporaryDirectory = await mkdtemp(
  join(tmpdir(), "printgo-admin-bootstrap-"),
);
const sqlPath = join(temporaryDirectory, "bootstrap.sql");

try {
  await writeFile(sqlPath, sql, { mode: 0o600 });
  const spawnArgs = isRemote
    ? [
        "--dir",
        "apps/api/worker",
        "exec",
        "wrangler",
        "d1",
        "execute",
        databaseName,
        "--remote",
        `--file=${sqlPath}`,
        "-y",
      ]
    : [
        "--dir",
        "apps/api/worker",
        "exec",
        "wrangler",
        "d1",
        "execute",
        "printgo-local",
        `--config=${join(repositoryRoot, "database/wrangler.local.jsonc")}`,
        "--local",
        `--persist-to=${join(repositoryRoot, ".wrangler/local")}`,
        `--file=${sqlPath}`,
      ];

  const result = spawnSync("pnpm", spawnArgs, {
    cwd: repositoryRoot,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  } else {
    console.log(
      `Admin '${loginIdentifier}' is ready on ${isRemote ? `remote '${databaseName}'` : "local D1"}. The password was not logged or stored in source.`,
    );
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
