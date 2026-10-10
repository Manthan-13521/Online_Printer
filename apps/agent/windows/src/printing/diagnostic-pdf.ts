import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export type DiagnosticTestType =
  "STANDARD" | "COLOR" | "DUPLEX" | "A3" | "CUSTOM";

export interface DiagnosticPdfOptions {
  printerDisplayName: string;
  shopName?: string;
  testType?: DiagnosticTestType;
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
 * Generates a valid diagnostic PDF document in memory.
 * Supports STANDARD, COLOR (with RGB test bars), DUPLEX (2 pages for front/back verification), and A3.
 * Zero external dependencies.
 */
export function generateDiagnosticPdfBuffer(
  options: DiagnosticPdfOptions,
): Buffer {
  const shopName = options.shopName?.trim() || "PRINTGO";
  const printerName =
    options.printerDisplayName || "Configured Windows Printer";
  const testType = options.testType || "STANDARD";

  if (testType === "DUPLEX") {
    return generateTwoPageDuplexPdf(shopName, printerName);
  }

  // Single page documents (STANDARD, COLOR, A3)
  const isA3 = testType === "A3";
  const width = isA3 ? 841.89 : 595.28;
  const height = isA3 ? 1190.55 : 841.89;

  const contentCommands: string[] = [];

  // Header text
  contentCommands.push(
    "BT",
    "/F1 20 Tf",
    "0 0 0 rg",
    `50 ${height - 80} Td`,
    `(${escapePdfText(shopName)} - DIAGNOSTIC TEST) Tj`,
    "ET",
    "BT",
    "/F1 13 Tf",
    `50 ${height - 115} Td`,
    `(${escapePdfText(`Printer: ${printerName}`)}) Tj`,
    "ET",
    "BT",
    "/F1 14 Tf",
    `50 ${height - 145} Td`,
    `(${escapePdfText(`Test Type: ${testType}`)}) Tj`,
    "ET",
  );

  if (testType === "COLOR") {
    // Add color test blocks
    contentCommands.push(
      "BT",
      "/F1 11 Tf",
      `50 ${height - 180} Td`,
      "(COLOR ALIGNMENT & DENSITY TEST BARS:) Tj",
      "ET",
      // Red
      "1 0 0 rg",
      `50 ${height - 230} 70 35 re f`,
      // Green
      "0 1 0 rg",
      `130 ${height - 230} 70 35 re f`,
      // Blue
      "0 0 1 rg",
      `210 ${height - 230} 70 35 re f`,
      // Yellow
      "1 1 0 rg",
      `290 ${height - 230} 70 35 re f`,
      // Cyan
      "0 1 1 rg",
      `370 ${height - 230} 70 35 re f`,
      // Magenta
      "1 0 1 rg",
      `450 ${height - 230} 70 35 re f`,
      // Black
      "0 0 0 rg",
      `50 ${height - 280} 150 25 re f`,
      "BT",
      "/F1 10 Tf",
      "0 0 0 rg",
      `50 ${height - 320} Td`,
      "(INSPECTION: Confirm all colors above printed distinctly in full color.) Tj",
      "ET",
    );
  } else if (testType === "A3") {
    contentCommands.push(
      "BT",
      "/F1 12 Tf",
      "0 0 0 rg",
      `50 ${height - 200} Td`,
      "(A3 DIMENSION CHECK: 297mm x 420mm) Tj",
      "ET",
      // Border outline around A3 margin
      "0 0 0 RG",
      "1 w",
      `30 30 ${width - 60} ${height - 60} re s`,
    );
  } else {
    // Standard test print confirmation
    contentCommands.push(
      "BT",
      "/F1 13 Tf",
      "0 0 0 rg",
      `50 ${height - 200} Td`,
      "(TEST PRINT CONFIRMED - STANDARD B&W SINGLE-SIDED) Tj",
      "ET",
    );
  }

  const streamContent = contentCommands.join("\n");
  const streamLength = Buffer.byteLength(streamContent, "utf8");

  const obj1 = "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n";
  const obj2 = "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n";
  const obj3 = `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width.toFixed(2)} ${height.toFixed(2)}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n`;
  const obj4 = `4 0 obj\n<< /Length ${streamLength} >>\nstream\n${streamContent}\nendstream\nendobj\n`;
  const obj5 =
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n";

  const header = "%PDF-1.4\n";
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

  return Buffer.from(header + obj1 + obj2 + obj3 + obj4 + obj5 + xref, "utf8");
}

function generateTwoPageDuplexPdf(
  shopName: string,
  printerName: string,
): Buffer {
  const p1Text = [
    "BT",
    "/F1 22 Tf",
    "0 0 0 rg",
    "50 760 Td",
    `(${escapePdfText(shopName)} - DUPLEX TEST) Tj`,
    "ET",
    "BT",
    "/F1 14 Tf",
    "50 710 Td",
    `(${escapePdfText(`Printer: ${printerName}`)}) Tj`,
    "ET",
    "BT",
    "/F1 24 Tf",
    "50 630 Td",
    "(>>> PAGE 1 OF 2 - FRONT SIDE <<<) Tj",
    "ET",
    "BT",
    "/F1 12 Tf",
    "50 580 Td",
    "(TOP OF PAGE - ORIENTATION ANCHOR) Tj",
    "ET",
  ].join("\n");

  const p2Text = [
    "BT",
    "/F1 22 Tf",
    "0 0 0 rg",
    "50 760 Td",
    `(${escapePdfText(shopName)} - DUPLEX TEST) Tj`,
    "ET",
    "BT",
    "/F1 14 Tf",
    "50 710 Td",
    `(${escapePdfText(`Printer: ${printerName}`)}) Tj`,
    "ET",
    "BT",
    "/F1 24 Tf",
    "50 630 Td",
    "(>>> PAGE 2 OF 2 - REVERSE SIDE <<<) Tj",
    "ET",
    "BT",
    "/F1 12 Tf",
    "50 580 Td",
    "(INSPECTION: Check if this printed on the reverse side of Page 1) Tj",
    "ET",
  ].join("\n");

  const p1Len = Buffer.byteLength(p1Text, "utf8");
  const p2Len = Buffer.byteLength(p2Text, "utf8");

  const obj1 = "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n";
  const obj2 =
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>\nendobj\n";
  const obj3 =
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n";
  const obj4 = `4 0 obj\n<< /Length ${p1Len} >>\nstream\n${p1Text}\nendstream\nendobj\n`;
  const obj5 =
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n";
  const obj6 =
    "6 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Contents 7 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n";
  const obj7 = `7 0 obj\n<< /Length ${p2Len} >>\nstream\n${p2Text}\nendstream\nendobj\n`;

  const header = "%PDF-1.4\n";
  const offset1 = Buffer.byteLength(header, "utf8");
  const offset2 = offset1 + Buffer.byteLength(obj1, "utf8");
  const offset3 = offset2 + Buffer.byteLength(obj2, "utf8");
  const offset4 = offset3 + Buffer.byteLength(obj3, "utf8");
  const offset5 = offset4 + Buffer.byteLength(obj4, "utf8");
  const offset6 = offset5 + Buffer.byteLength(obj5, "utf8");
  const offset7 = offset6 + Buffer.byteLength(obj6, "utf8");
  const startXref = offset7 + Buffer.byteLength(obj7, "utf8");

  const pad = (n: number) => String(n).padStart(10, "0");
  const xref = [
    "xref",
    "0 8",
    "0000000000 65535 f ",
    `${pad(offset1)} 00000 n `,
    `${pad(offset2)} 00000 n `,
    `${pad(offset3)} 00000 n `,
    `${pad(offset4)} 00000 n `,
    `${pad(offset5)} 00000 n `,
    `${pad(offset6)} 00000 n `,
    `${pad(offset7)} 00000 n `,
    "trailer",
    "<< /Size 8 /Root 1 0 R >>",
    "startxref",
    String(startXref),
    "%%EOF\n",
  ].join("\n");

  return Buffer.from(
    header + obj1 + obj2 + obj3 + obj4 + obj5 + obj6 + obj7 + xref,
    "utf8",
  );
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
