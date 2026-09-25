import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { hashPassword } from "../packages/auth/dist/index.js";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const loginIdentifier = (process.argv[2] ?? "admin")
  .trim()
  .toLocaleLowerCase("en-US");

if (!loginIdentifier || loginIdentifier.length > 100) {
  throw new Error("Login must contain 1 to 100 characters.");
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

const password = await readSecret("New admin password: ");
if (password.length < 12 || password.length > 128) {
  throw new Error("Password must contain 12 to 128 characters.");
}

const passwordHash = await hashPassword(password);
const now = Date.now();
const sqlString = (value) => `'${value.replaceAll("'", "''")}'`;
const sql = `UPDATE admin_sessions SET revoked_at_ms = ${now} WHERE revoked_at_ms IS NULL;
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
  const result = spawnSync(
    "pnpm",
    [
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
    ],
    { cwd: repositoryRoot, stdio: "inherit" },
  );
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  else
    console.log(
      `Admin ${loginIdentifier} is ready. The password was not logged or stored in source.`,
    );
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
