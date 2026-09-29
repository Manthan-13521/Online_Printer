import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { DevelopmentPrinterAdapter } from "../printing/windows-printer-adapter.js";
import { DevelopmentCredentialStore } from "../storage/credential-store.js";
import { createSupportPackage, sanitizeLogContent } from "./support-package.js";

describe("sanitizeLogContent", () => {
  it("redacts bearer tokens and agent secrets", () => {
    const raw =
      'Sending auth header: Bearer abc1234567890123456789 and agentSecret: "mySuperSecretAgentKey12345678"';
    const sanitized = sanitizeLogContent(raw);

    expect(sanitized).not.toContain("abc1234567890123456789");
    expect(sanitized).not.toContain("mySuperSecretAgentKey12345678");
    expect(sanitized).toContain("[REDACTED_TOKEN]");
    expect(sanitized).toContain("[REDACTED_AGENT_SECRET]");
  });

  it("redacts phone numbers and email addresses", () => {
    const raw =
      "Order created for customer 9876543210 and contact support@example.com";
    const sanitized = sanitizeLogContent(raw);

    expect(sanitized).not.toContain("9876543210");
    expect(sanitized).not.toContain("support@example.com");
    expect(sanitized).toContain("[REDACTED_PHONE]");
    expect(sanitized).toContain("[REDACTED_EMAIL]");
  });

  it("redacts SSH keys, Razorpay keys, Cloudflare tokens, and DPAPI blobs", () => {
    const raw = [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAABlwAAAAdzc2gtcn",
      "-----END OPENSSH PRIVATE KEY-----",
      'rzp_live_1234567890abcdef and razorpay_secret: "rzp_secret_abcdef123456"',
      'CLOUDFLARE_API_TOKEN: "cf_token_abcdef1234567890"',
      'encrypted_data: "AQAAANCMnd8BFdERjHoAwE/Cl+sBAAAAKV5j2K0z4Eiq9y74w2h"',
      'customer_name: "Aarav Sharma"',
      "https://r2.cloudflarestorage.com/printgo-uploads/orders/ord-999/file?X-Amz-Signature=abcdef12345",
      "%PDF-1.4 raw stream contents",
    ].join("\n");

    const sanitized = sanitizeLogContent(raw);

    expect(sanitized).not.toContain("b3BlbnNzaC1rZXktdjE");
    expect(sanitized).not.toContain("rzp_live_1234567890abcdef");
    expect(sanitized).not.toContain("rzp_secret_abcdef123456");
    expect(sanitized).not.toContain("cf_token_abcdef1234567890");
    expect(sanitized).not.toContain("AQAAANCMnd8BFdERjHoAwE");
    expect(sanitized).not.toContain("Aarav Sharma");
    expect(sanitized).not.toContain("X-Amz-Signature=abcdef12345");
    expect(sanitized).not.toContain("%PDF-1.4");

    expect(sanitized).toContain("[REDACTED_SSH_PRIVATE_KEY]");
    expect(sanitized).toContain("[REDACTED_RAZORPAY_KEY]");
    expect(sanitized).toContain("[REDACTED_RAZORPAY_SECRET]");
    expect(sanitized).toContain("[REDACTED_CLOUDFLARE_TOKEN]");
    expect(sanitized).toContain("[REDACTED_DPAPI_BLOB]");
    expect(sanitized).toContain("[REDACTED_CUSTOMER_NAME]");
    expect(sanitized).toContain("[REDACTED_PRESIGNED_URL]");
    expect(sanitized).toContain("[REDACTED_PDF_CONTENT]");
  });
});

describe("createSupportPackage", () => {
  it("creates a support package zip file without leaking secrets", async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "printgo-support-test-"),
    );
    const credPath = path.join(tempDir, "credentials.json");
    const credStore = new DevelopmentCredentialStore(credPath);
    await credStore.save({
      agentId: "agent-test-id",
      agentSecret: "super-secret-agent-key-never-leak-this-32chars",
      serverUrl: "https://printgo-api.test.workers.dev",
      displayName: "Counter PC",
    });

    const logPath = path.join(tempDir, "daemon.log");
    await fs.writeFile(
      logPath,
      "Unlabelled Private Customer\n%PDF-1.4 private contents\nhttps://example.test/?token=secretCanary\nPRINT_TIMING step=safe-id event=sumatra_start atMs=1790611200000\n",
    );
    const printerAdapter = new DevelopmentPrinterAdapter();
    vi.spyOn(printerAdapter, "listPrinters").mockResolvedValue([
      {
        id: "private-device-id",
        displayName: "Private Printer Customer",
        driverName: "private-driver",
        isDefault: true,
      },
    ]);
    vi.spyOn(printerAdapter, "getStatus").mockResolvedValue({
      availability: "ONLINE",
      message: "private-error-customer",
    });
    const result = await createSupportPackage({
      agentVersion: "2.1.0",
      credentialStore: credStore,
      printerAdapter,
      outputDirectory: tempDir,
      logFilePath: logPath,
    });

    expect(result.byteLength).toBeGreaterThan(100);
    expect(result.zipPath.endsWith(".zip")).toBe(true);

    const zipBytes = await fs.readFile(result.zipPath);
    const contents: string[] = [];
    for (let offset = 0; zipBytes.readUInt32LE(offset) === 0x04034b50;) {
      const method = zipBytes.readUInt16LE(offset + 8);
      const size = zipBytes.readUInt32LE(offset + 18);
      const start =
        offset +
        30 +
        zipBytes.readUInt16LE(offset + 26) +
        zipBytes.readUInt16LE(offset + 28);
      const data = zipBytes.subarray(start, start + size);
      contents.push(
        (method === 8 ? inflateRawSync(data) : data).toString("utf8"),
      );
      offset = start + size;
    }
    const zipString = contents.join("\n");
    expect(contents).toHaveLength(4);
    for (const canary of [
      "private-device-id",
      "Private Printer Customer",
      "private-driver",
      "private-error-customer",
    ])
      expect(zipString).not.toContain(canary);
    for (const canary of [
      "Unlabelled Private Customer",
      "%PDF",
      "private contents",
      "secretCanary",
      "safe-id",
    ])
      expect(zipString).not.toContain(canary);
    expect(zipString).toContain("sumatra_start");
    expect(zipString).not.toContain("Counter PC");
    expect(zipString).not.toContain("agent-test-id");
    expect(zipString).not.toContain("printgo-api.test.workers.dev");

    // Must NEVER contain the secret
    expect(zipString).not.toContain(
      "super-secret-agent-key-never-leak-this-32chars",
    );

    // Clean up
    await fs.rm(tempDir, { recursive: true, force: true });
  });
});
