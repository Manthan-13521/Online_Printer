#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hashSessionToken } from "../packages/auth/dist/index.js";

const PAIR_CODE_ALPHABET = "0123456789";
const PAIR_CODE_LENGTH = 8;

function generatePairCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(PAIR_CODE_LENGTH));
  let code = "";
  for (let i = 0; i < PAIR_CODE_LENGTH; i += 1) {
    if (i === 4) code += "-";
    code += PAIR_CODE_ALPHABET[(bytes[i] ?? 0) % PAIR_CODE_ALPHABET.length];
  }
  return code;
}

function normalizePairCode(raw) {
  return raw
    .trim()
    .toUpperCase()
    .replaceAll("-", "")
    .replaceAll(/\s+/gu, "")
    .replaceAll("O", "0")
    .replaceAll("I", "1")
    .replaceAll("L", "1");
}

async function main() {
  const pairCode = generatePairCode();
  const normalized = normalizePairCode(pairCode);
  const codeHash = await hashSessionToken(normalized);
  const nowMs = Date.now();
  const expiresAtMs = nowMs + 15 * 60 * 1000; // 15 minutes lifetime
  const id = randomUUID();

  const sql = `INSERT INTO agent_pair_codes (id, code_hash, expires_at_ms, created_at_ms) VALUES ('${id}', '${codeHash}', ${expiresAtMs}, ${nowMs});`;

  console.log(`Generating pair code: ${pairCode} (expires in 15m)...`);

  const result = spawnSync(
    "pnpm",
    [
      "--dir",
      "apps/api/worker",
      "exec",
      "wrangler",
      "d1",
      "execute",
      "printgo-production",
      "--remote",
      "--command",
      sql,
    ],
    { stdio: "pipe", encoding: "utf8" },
  );

  if (result.status !== 0) {
    console.error(
      "Failed to insert pair code into D1:",
      result.stderr || result.stdout,
    );
    process.exit(1);
  }

  console.log("Successfully registered pair code in production D1!");
  console.log(`PAIR_CODE=${pairCode}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
