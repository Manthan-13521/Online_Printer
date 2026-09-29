import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { PrinterAdapter } from "../printing/printer-adapter.js";
import type { CredentialStore } from "../storage/credential-store.js";
import { buildZipArchive, type ZipEntry } from "./zip-builder.js";

export interface SupportPackageOptions {
  agentVersion: string;
  credentialStore: CredentialStore;
  printerAdapter: PrinterAdapter;
  logFilePath?: string;
  outputDirectory?: string;
}

export interface SupportPackageResult {
  zipPath: string;
  byteLength: number;
}

export function sanitizeLogContent(raw: string): string {
  return (
    raw
      // Mask SSH private keys
      .replace(
        /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
        "[REDACTED_SSH_PRIVATE_KEY]",
      )
      // Mask bearer tokens
      .replace(/(bearer\s+)[a-zA-Z0-9_.-]{15,}/gi, "$1[REDACTED_TOKEN]")
      // Mask Razorpay key IDs and secrets
      .replace(
        /\brzp_(?:test|live)_[a-zA-Z0-9]{10,}\b/gi,
        "[REDACTED_RAZORPAY_KEY]",
      )
      .replace(
        /(razorpay[_\w]*secret["']?\s*[:=]\s*["'])[a-zA-Z0-9_.-]{10,}(["'])/gi,
        "$1[REDACTED_RAZORPAY_SECRET]$2",
      )
      // Mask Cloudflare tokens/keys
      .replace(
        /(?:CLOUDFLARE_API_TOKEN|CF_API_KEY|CLOUDFLARE_KEY)["']?\s*[:=]\s*["'][a-zA-Z0-9_.-]{15,}["']/gi,
        "[REDACTED_CLOUDFLARE_TOKEN]",
      )
      // Mask agent secrets
      .replace(
        /(agent_?secret["']?\s*[:=]\s*["'])[a-zA-Z0-9_.-]{10,}(["'])/gi,
        "$1[REDACTED_AGENT_SECRET]$2",
      )
      .replace(
        /(credential_hash["']?\s*[:=]\s*["'])[a-zA-Z0-9_.-]{15,}(["'])/gi,
        "$1[REDACTED_HASH]$2",
      )
      .replace(
        /(secret["']?\s*[:=]\s*["'])[a-zA-Z0-9_.-]{10,}(["'])/gi,
        "$1[REDACTED_SECRET]$2",
      )
      // Mask DPAPI / base64 credential blobs
      .replace(
        /(?:encrypted_?data|dpapi_blob)["']?\s*[:=]\s*["'][a-zA-Z0-9+/=]{30,}["']/gi,
        "[REDACTED_DPAPI_BLOB]",
      )
      // Mask customer names
      .replace(
        /((?:customer_name|customerName|customer)\s*[:=]\s*["'])([^"']{2,})(["'])/gi,
        "$1[REDACTED_CUSTOMER_NAME]$3",
      )
      // The sheet-only full-phone exception never applies to support logs.
      .replace(/(?:\+91[ -]?)?[6-9](?:[ -]?\d){9}\b/g, "[REDACTED_PHONE]")
      // Mask phone numbers (Indian 10-digit formats with optional +91)
      .replace(/(?:\+?91[- \s]?)?[6-9]\d{9}\b/g, "[REDACTED_PHONE]")
      // Mask email addresses
      .replace(
        /[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/g,
        "[REDACTED_EMAIL]",
      )
      // Mask presigned R2/S3 URLs, SAS tokens, and customer order PDF download URLs
      .replace(
        /https:\/\/[^\s"'<>]+\b(?:X-Amz-Signature=[a-zA-Z0-9]+|r2\.cloudflarestorage\.com|orders\/[a-zA-Z0-9_-]+\/file)[^\s"'<>]*/gi,
        "https://[REDACTED_PRESIGNED_URL]",
      )
      // Mask raw PDF headers if ever printed in logs
      .replace(/%PDF-\d\.\d/g, "[REDACTED_PDF_CONTENT]")
  );
}

export async function createSupportPackage(
  options: SupportPackageOptions,
): Promise<SupportPackageResult> {
  const entries: ZipEntry[] = [];
  const now = new Date();
  const timestampStr = now.toISOString().replace(/[:.]/g, "-");

  // 1. System Info
  const systemInfo = {
    agentVersion: /^\d+\.\d+\.\d+$/.test(options.agentVersion)
      ? options.agentVersion
      : "UNKNOWN",
    timestamp: now.toISOString(),
    osPlatform: process.platform,
    osRelease: os.release(),
    osType: os.type(),
    osArch: process.arch,
    nodeVersion: process.version,
    memoryTotalBytes: os.totalmem(),
    memoryFreeBytes: os.freemem(),
  };
  entries.push({
    path: "diagnostics/system-info.json",
    data: JSON.stringify(systemInfo, null, 2),
  });

  // Only approved fields leave the machine; arbitrary text may contain PII.
  let hasCredentials = false;
  let credentialsReadable = true;
  try {
    hasCredentials = Boolean(await options.credentialStore.load());
  } catch {
    credentialsReadable = false;
  }
  entries.push({
    path: "diagnostics/agent-config.json",
    data: JSON.stringify({ hasCredentials, credentialsReadable }),
  });
  const allowedAvailability = new Set([
    "ONLINE",
    "AVAILABLE",
    "OFFLINE",
    "BLOCKED",
    "ERROR",
    "UNKNOWN",
  ]);
  try {
    const printers = await options.printerAdapter.listPrinters();
    const details = await Promise.all(
      printers.map(async (printer, index) => {
        let availability = "UNKNOWN";
        try {
          const status = await options.printerAdapter.getStatus(printer.id);
          if (allowedAvailability.has(status.availability))
            availability = status.availability;
        } catch {
          /* Replace provider error text with a fixed status. */
        }
        return {
          printerIndex: index + 1,
          isWindowsDefault: printer.isDefault === true,
          isEligible: printer.isEligibleForProductionPrint === true,
          availability,
        };
      }),
    );
    entries.push({
      path: "diagnostics/printers.json",
      data: JSON.stringify(details),
    });
  } catch {
    entries.push({
      path: "diagnostics/printers.json",
      data: '{"status":"UNAVAILABLE"}',
    });
  }
  const localAppData =
    process.env.LOCALAPPDATA ||
    process.env.APPDATA ||
    path.join(os.homedir(), "AppData", "Local");
  const logPath =
    options.logFilePath || path.join(localAppData, "PrintGo", "daemon.log");
  let safeLog = "No readable timing records.";
  try {
    const handle = await fs.open(logPath, "r");
    try {
      const stat = await handle.stat();
      const buffer = Buffer.alloc(Math.min(stat.size, 2 * 1024 * 1024));
      await handle.read(
        buffer,
        0,
        buffer.length,
        Math.max(0, stat.size - buffer.length),
      );
      const events = buffer
        .toString("utf8")
        .split("\n")
        .flatMap((line) => {
          const match =
            /PRINT_TIMING step=[a-zA-Z0-9_-]+ event=(preparation_start|submission_start|sumatra_start|spool_captured|adapter_return|spool_identity_persisted|completion_reported) atMs=(\d{13})(?:\s|$)/.exec(
              line,
            );
          return match ? [{ event: match[1], atMs: Number(match[2]) }] : [];
        });
      safeLog = JSON.stringify({
        scope:
          "Last 2 MiB; approved timing fields only. Other content omitted.",
        events,
      });
    } finally {
      await handle.close();
    }
  } catch {
    /* Never export a path or raw error. */
  }
  entries.push({ path: "logs/sanitized-agent.log", data: safeLog });

  // Build the zip buffer
  const zipBuffer = buildZipArchive(entries);

  // Determine output directory (default to Desktop or Downloads or cwd)
  const defaultDir =
    options.outputDirectory ||
    (process.env.USERPROFILE
      ? path.join(process.env.USERPROFILE, "Desktop")
      : process.cwd());
  await fs.mkdir(defaultDir, { recursive: true });

  const zipFileName = `PrintGo-Support-${timestampStr}.zip`;
  const zipPath = path.join(defaultDir, zipFileName);
  await fs.writeFile(zipPath, zipBuffer);

  return {
    zipPath,
    byteLength: zipBuffer.length,
  };
}
