#!/usr/bin/env node

/**
 * PrintGo V2 — Shop Reconfiguration Script
 * Safely updates shop metadata, Razorpay credentials, and settings without leaking secrets.
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
  console.log("       PRINTGO V2 — SHOP CONFIGURATION TOOL       ");
  console.log("==================================================");

  const rl = readline.createInterface({ input, output });
  const dbName =
    (await rl.question("D1 Database Name (default: printgo-production): ")) ||
    "printgo-production";

  console.log("\nWhat would you like to update?");
  console.log("1. Shop Details (Name, Phone, Notice)");
  console.log("2. Razorpay Credentials (Key ID, Secret)");
  console.log("3. Exit");

  const choice = await rl.question("\nEnter choice (1-3): ");

  if (choice === "1") {
    const shopName = await rl.question(
      "New Shop Name (leave empty to keep current): ",
    );
    const contactPhone = await rl.question(
      "New Contact Phone (leave empty to keep current): ",
    );
    const customerNotice = await rl.question(
      "New Customer Notice banner (leave empty for none): ",
    );

    const updates = [];
    const binds = [];
    if (shopName.trim()) {
      updates.push("shop_name = ?");
      binds.push(shopName.trim());
    }
    if (contactPhone.trim()) {
      updates.push("contact_phone = ?");
      binds.push(contactPhone.trim());
    }
    if (customerNotice.trim()) {
      updates.push("customer_notice = ?");
      binds.push(customerNotice.trim());
    }

    if (updates.length > 0) {
      updates.push("updated_at_ms = ?");
      binds.push(Date.now());
      const sql = `UPDATE installation SET ${updates.join(", ")} WHERE id = 1;`;
      console.log("\nApplying database update...");
      spawnSync(
        "npx",
        ["wrangler", "d1", "execute", dbName, "--remote", `--command=${sql}`],
        { cwd: path.resolve(rootDir, "apps/api/worker"), stdio: "inherit" },
      );
      console.log("✓ Shop details updated successfully.");
    } else {
      console.log("No changes specified.");
    }
  } else if (choice === "2") {
    console.log("\nUpdate Razorpay Credentials (Hidden Input)");
    const razorpayKeyId = await promptSecret("New Razorpay Key ID: ");
    const razorpayKeySecret = await promptSecret("New Razorpay Key Secret: ");

    if (razorpayKeyId) {
      spawnSync("npx", ["wrangler", "secret", "put", "RAZORPAY_KEY_ID"], {
        cwd: path.resolve(rootDir, "apps/api/worker"),
        input: razorpayKeyId,
        stdio: ["pipe", "inherit", "inherit"],
      });
      console.log("✓ Updated RAZORPAY_KEY_ID.");
    }
    if (razorpayKeySecret) {
      spawnSync("npx", ["wrangler", "secret", "put", "RAZORPAY_KEY_SECRET"], {
        cwd: path.resolve(rootDir, "apps/api/worker"),
        input: razorpayKeySecret,
        stdio: ["pipe", "inherit", "inherit"],
      });
      console.log("✓ Updated RAZORPAY_KEY_SECRET.");
    }
  }

  rl.close();
  console.log("\nConfiguration complete.");
}

main().catch((err) => {
  console.error("Configuration error:", err);
  process.exit(1);
});
