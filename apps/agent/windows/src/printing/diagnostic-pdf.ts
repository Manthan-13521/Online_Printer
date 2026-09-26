import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface DiagnosticPdfOptions {
  printerDisplayName: string;
  agentDisplayName: string;
  commandId?: string;
  timestamp?: Date;
  shopName?: string;
}

/**
 * Escapes characters for PDF literal text strings: `(`, `)`, and `\`.
 */
function escapePdfText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

/**
 * Generates a valid, minimal single-page A4 PDF document in memory.
 * No external PDF rendering libraries or runtime network calls are used.
 */
export function generateDiagnosticPdfBuffer(
  options: DiagnosticPdfOptions,
): Buffer {
  const now = options.timestamp ?? new Date();
  const dateStr = now
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, " UTC");
  const shopName = options.shopName ?? "PrintGo Diagnostics";
  const agentName = options.agentDisplayName || "PrintGo Agent";
  const printerName =
    options.printerDisplayName || "Configured Windows Printer";
  const commandId = options.commandId ?? "manual-test";

  // Build the text commands for the PDF content stream
  // A4 dimensions: 595 x 842 points. Origin (0,0) is bottom-left.
  const lines: string[] = [
    // Header separator line
    "0.5 w",
    "50 790 m 545 790 l S",

    // Title
    "BT",
    "/F1 20 Tf",
    "50 760 Td",
    `(${escapePdfText("PRINTGO TEST PAGE")}) Tj`,
    "ET",

    // Subtitle
    "BT",
    "/F1 14 Tf",
    "50 735 Td",
    `(${escapePdfText("NOT A CUSTOMER ORDER")}) Tj`,
    "ET",

    // Divider line
    "50 715 m 545 715 l S",

    // Diagnostics details
    "BT",
    "/F1 11 Tf",
    "18 TL", // Leading
    "50 685 Td",
    `(${escapePdfText(`Shop: ${shopName}`)}) Tj T*`,
    `(${escapePdfText(`Agent: ${agentName}`)}) Tj T*`,
    `(${escapePdfText(`Printer: ${printerName}`)}) Tj T*`,
    `(${escapePdfText(`Date / Time: ${dateStr}`)}) Tj T*`,
    `(${escapePdfText(`Command ID: ${commandId}`)}) Tj T*`,
    `(${escapePdfText("Test Type: Local Diagnostic Connectivity Verification")}) Tj T*`,
    `(${escapePdfText("Paper Size: A4 (Standard)")}) Tj T*`,
    `(${escapePdfText("Copies: 1")}) Tj T*`,
    "ET",

    // Box outline for status note
    "0.75 w",
    "50 460 495 65 re S",

    "BT",
    "/F1 10 Tf",
    "15 TL",
    "60 505 Td",
    `(${escapePdfText("SUCCESSFUL SPOOL SUBMISSION PROVES THAT:")}) Tj T*`,
    `(${escapePdfText("- The Windows Agent received and validated this test command.")}) Tj T*`,
    `(${escapePdfText("- The Windows print spooler accepted the local diagnostic document.")}) Tj T*`,
    `(${escapePdfText("- Communication between PrintGo cloud and the shop computer is operational.")}) Tj T*`,
    "ET",

    // Footer divider and footer text
    "0.5 w",
    "50 80 m 545 80 l S",
    "BT",
    "/F1 9 Tf",
    "50 65 Td",
    `(${escapePdfText("PrintGo V2 - Diagnostic Document - No Customer Files or R2 Objects Used")}) Tj`,
    "ET",
  ];

  const streamContent = lines.join("\n");
  const streamLength = Buffer.byteLength(streamContent, "utf8");

  // Construct PDF objects
  const obj1 = "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n";
  const obj2 = "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n";
  const obj3 =
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n";
  const obj4 = `4 0 obj\n<< /Length ${streamLength} >>\nstream\n${streamContent}\nendstream\nendobj\n`;
  const obj5 =
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n";

  const header = "%PDF-1.4\n";

  // Compute xref offsets
  const offset1 = Buffer.byteLength(header, "utf8");
  const offset2 = offset1 + Buffer.byteLength(obj1, "utf8");
  const offset3 = offset2 + Buffer.byteLength(obj2, "utf8");
  const offset4 = offset3 + Buffer.byteLength(obj3, "utf8");
  const offset5 = offset4 + Buffer.byteLength(obj4, "utf8");
  const startXref = offset5 + Buffer.byteLength(obj5, "utf8");

  const pad = (n: number) => String(n).padStart(10, "0");

  const xref = [
    "xref",
    "0 6",
    "0000000000 65535 f ",
    `${pad(offset1)} 00000 n `,
    `${pad(offset2)} 00000 n `,
    `${pad(offset3)} 00000 n `,
    `${pad(offset4)} 00000 n `,
    `${pad(offset5)} 00000 n `,
    "trailer",
    "<< /Size 6 /Root 1 0 R >>",
    "startxref",
    String(startXref),
    "%%EOF\n",
  ].join("\n");

  const fullPdf = header + obj1 + obj2 + obj3 + obj4 + obj5 + xref;
  return Buffer.from(fullPdf, "utf8");
}

/**
 * Creates a temporary diagnostic PDF file on disk.
 * Uses an unpredictable random filename inside the OS temp directory under `printgo-diagnostics`.
 * The caller is responsible for removing the file once printed.
 */
export async function createDiagnosticPdfFile(
  options: DiagnosticPdfOptions,
  customDir?: string,
): Promise<string> {
  const dir = customDir ?? path.join(os.tmpdir(), "printgo-diagnostics");
  await fs.mkdir(dir, { recursive: true });

  const randomSuffix = crypto.randomBytes(8).toString("hex");
  const filePath = path.join(
    dir,
    `test-print-${Date.now()}-${randomSuffix}.pdf`,
  );

  const buffer = generateDiagnosticPdfBuffer(options);
  await fs.writeFile(filePath, buffer, { mode: 0o600 });
  return filePath;
}
