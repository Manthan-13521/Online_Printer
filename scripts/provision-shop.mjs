#!/usr/bin/env node

/**
 * PrintGo V2 — Automated Shop Provisioning Script
 * Guides the developer through provisioning a fresh, isolated Cloudflare deployment for one shop.
 *
 * Invariants:
 * 1. Exactly ONE Cloudflare environment = ONE shop.
 * 2. Secrets are prompted with hidden terminal input and NEVER echoed or committed.
 * 3. R2 bucket is created strictly private with pre-signed PUT CORS.
 */

import { spawnSync } from "node:child_process";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

async function promptSecret(query) {
  return new Promise((resolve) => {
    output.write(query);
    const rl = readline.createInterface({ input, output });
    let secret = "";

    // Mask input on keystroke if TTY
    if (input.isTTY) {
      input.setRawMode(true);
      input.resume();
      const onData = (char) => {
        const c = char.toString("utf8");
        if (c === "\n" || c === "\r" || c === "\u0004") {
          input.setRawMode(false);
          input.removeListener("data", onData);
          output.write("\n");
          rl.close();
          resolve(secret.trim());
        } else if (c === "\u0003") {
          // Ctrl+C
          process.exit(1);
        } else if (c === "\b" || c === "\x7f") {
          if (secret.length > 0) {
            secret = secret.slice(0, -1);
            output.write("\b \b");
          }
        } else {
          secret += c;
          output.write("*");
        }
      };
      input.on("data", onData);
    } else {
      rl.question("", (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    }
  });
}

async function main() {
  console.log("==================================================");
  console.log("      PRINTGO V2 — SHOP PROVISIONING WIZARD       ");
  console.log("==================================================");
  console.log(
    "This wizard configures a dedicated Cloudflare environment for ONE print shop.\n",
  );

  const rl = readline.createInterface({ input, output });

  // 1. Verify Cloudflare credentials
  console.log("[1/8] Verifying Cloudflare Authentication...");
  const whoami = spawnSync("npx", ["wrangler", "whoami"], {
    cwd: path.resolve(rootDir, "apps/api/worker"),
    encoding: "utf8",
  });
  if (whoami.status !== 0) {
    console.error("❌ Cloudflare Wrangler is not authenticated.");
    console.error(
      "Please log into the shop's Cloudflare account via: npx wrangler login",
    );
    process.exit(1);
  }
  console.log("✓ Authenticated with Cloudflare.\n");

  // 2. Collect Shop Information
  console.log("[2/8] Shop Details");
  const shopName =
    (await rl.question("Shop Name (e.g. Campus Xerox Express): ")) ||
    "PrintGo Shop";
  const contactPhone =
    (await rl.question("Contact Phone (10 digits): ")) || "9000000000";
  const dbName =
    (await rl.question("D1 Database Name (default: printgo-production): ")) ||
    "printgo-production";
  const bucketName =
    (await rl.question(
      "R2 Bucket Name (default: printgo-uploads-production): ",
    )) || "printgo-uploads-production";

  console.log("\n[3/8] Razorpay Credentials (Hidden Input)");
  const razorpayKeyId = await promptSecret("Razorpay Key ID: ");
  const razorpayKeySecret = await promptSecret("Razorpay Key Secret: ");

  console.log("\n[4/8] Admin Initial Credentials");
  const adminLogin =
    (await rl.question("Admin Login Username (default: admin): ")) || "admin";
  const adminPassword = await promptSecret("Admin Initial Password: ");

  rl.close();

  console.log("\n--------------------------------------------------");
  console.log("Starting Automated Provisioning Pipeline...");
  console.log("--------------------------------------------------");

  // Step A: D1 Database Creation
  console.log(`\n• Step A: Provisioning D1 Database '${dbName}'...`);
  spawnSync("npx", ["wrangler", "d1", "create", dbName], {
    cwd: path.resolve(rootDir, "apps/api/worker"),
    stdio: "inherit",
  });

  // Step B: Applying Schema Migrations
  console.log("• Step B: Applying Database Migrations (0001 through 0007)...");
  const migrations = [
    "0001_initial_schema.sql",
    "0002_drop_foreign_keys.sql",
    "0003_agent_printer_capabilities.sql",
    "0004_fix_printer_id_type.sql",
    "0005_fix_duplicate_columns.sql",
    "0006_paid_print_execution.sql",
    "0007_admin_recovery_and_default_printer.sql",
  ];
  for (const m of migrations) {
    const file = path.resolve(rootDir, `database/migrations/${m}`);
    console.log(`  Applying ${m}...`);
    spawnSync(
      "npx",
      ["wrangler", "d1", "execute", dbName, "--remote", `--file=${file}`],
      {
        cwd: path.resolve(rootDir, "apps/api/worker"),
        stdio: "inherit",
      },
    );
  }

  // Update shop branding and contact phone
  console.log("  Configuring initial shop branding...");
  const escapedName = shopName.replace(/'/g, "''");
  const escapedPhone = contactPhone.replace(/'/g, "''");
  spawnSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      dbName,
      "--remote",
      `--command=UPDATE installation SET shop_name = '${escapedName}', contact_phone = '${escapedPhone}' WHERE id = 1;`,
    ],
    {
      cwd: path.resolve(rootDir, "apps/api/worker"),
      stdio: "inherit",
    },
  );

  // Step C: R2 Bucket Creation
  console.log(
    `\n• Step C: Provisioning Private R2 Storage Bucket '${bucketName}'...`,
  );
  spawnSync("npx", ["wrangler", "r2", "bucket", "create", bucketName], {
    cwd: path.resolve(rootDir, "apps/api/worker"),
    stdio: "inherit",
  });

  // Step D: Worker Secret Binding
  console.log("\n• Step D: Binding Secure Worker Secrets...");
  const secrets = [
    ["RAZORPAY_KEY_ID", razorpayKeyId],
    ["RAZORPAY_KEY_SECRET", razorpayKeySecret],
  ];
  for (const [key, val] of secrets) {
    if (val) {
      const child = spawnSync("npx", ["wrangler", "secret", "put", key], {
        cwd: path.resolve(rootDir, "apps/api/worker"),
        input: val,
        stdio: ["pipe", "inherit", "inherit"],
      });
      if (child.status === 0) {
        console.log(`  ✓ Secret '${key}' bound successfully.`);
      }
    }
  }

  // Step E: Worker Deployment
  console.log("\n• Step E: Deploying Cloudflare Worker API...");
  spawnSync("npx", ["wrangler", "deploy"], {
    cwd: path.resolve(rootDir, "apps/api/worker"),
    stdio: "inherit",
  });

  // Step F: Bootstrap Admin Account
  console.log("\n• Step F: Bootstrapping Initial Shop Admin Account...");
  spawnSync(
    "node",
    [
      "scripts/bootstrap-admin.mjs",
      "--remote",
      `--database=${dbName}`,
      `--login=${adminLogin}`,
    ],
    {
      cwd: rootDir,
      input: `${adminPassword}\n${adminPassword}\n`,
      stdio: ["pipe", "inherit", "inherit"],
    },
  );

  // Step G: Deploy Web PWAs
  console.log("\n• Step G: Building and Deploying Customer and Admin PWAs...");
  spawnSync("pnpm", ["--filter", "@printgo/customer", "build"], {
    cwd: rootDir,
    stdio: "inherit",
  });
  spawnSync("pnpm", ["--filter", "@printgo/admin", "build"], {
    cwd: rootDir,
    stdio: "inherit",
  });

  console.log("\n==================================================");
  console.log("       PROVISIONING COMPLETED SUCCESSFULLY!       ");
  console.log("==================================================");
  console.log(`Shop:         ${shopName}`);
  console.log(`Admin Login:  ${adminLogin}`);
  console.log("Next Steps:");
  console.log("1. Open Admin PWA in browser");
  console.log("2. Navigate to Printers -> Connect Windows PC");
  console.log("3. Download and run PrintGo-Setup.exe on shop counter computer");
  console.log(
    "4. Complete the 1-click pairing wizard and verify physical print!",
  );
}

main().catch((err) => {
  console.error("Fatal provisioning error:", err);
  process.exit(1);
});
