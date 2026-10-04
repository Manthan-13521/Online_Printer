import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type {
  IdentificationSheetAddonService,
  IdentificationSheetData,
} from "@printgo/api-contract";
import { maskPhoneNumber } from "@printgo/domain";
import type {
  PrinterAdapter,
  PrintSettings,
  SubmittedPrintJob,
} from "./printer-adapter.js";

export const IDENTIFICATION_SHEET_PRINT_SETTINGS: Readonly<PrintSettings> =
  Object.freeze({
    paperSize: "A4",
    colorMode: "BLACK_AND_WHITE",
    sides: "ONE_SIDED",
    copies: 1,
    pageRange: "1",
  });

export type IdentificationSheetErrorCode =
  "INVALID_DATA" | "CREATE_FAILED" | "CLEANUP_FAILED";

export class IdentificationSheetError extends Error {
  constructor(
    readonly code: IdentificationSheetErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "IdentificationSheetError";
  }
}

export interface IdentificationSheetRenderOptions {
  /** Primarily for deterministic tests. Production defaults to Agent local time. */
  timeZone?: string;
}

function pdfSafeText(value: string, maxLength: number): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[^\x20-\x7e]/g, "?")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function escapePdfText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function formatPaidTime(
  paidAtMs: number,
  options?: IdentificationSheetRenderOptions,
): string {
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    ...(options?.timeZone ? { timeZone: options.timeZone } : {}),
  }).format(new Date(paidAtMs));
}

function formatAmountPaise(amountPaise: number): string {
  const rupees = Math.floor(amountPaise / 100);
  const paise = String(amountPaise % 100).padStart(2, "0");
  return `Rs. ${rupees}.${paise}`;
}

function wrapText(value: string, width: number, maxLines: number): string[] {
  const words = value.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const sourceWord of words) {
    const word =
      sourceWord.length > width
        ? `${sourceWord.slice(0, Math.max(1, width - 3))}...`
        : sourceWord;
    if (!current) {
      current = word;
    } else if (current.length + word.length + 1 <= width) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
    if (lines.length >= maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current);
  return lines.slice(0, maxLines);
}

function instructionLines(instructions: string | null): string[] {
  if (!instructions?.trim()) return ["None provided by customer."];
  const lines = wrapText(pdfSafeText(instructions, 500), 68, 5);
  return lines.length > 0 ? lines : ["None provided by customer."];
}

function addonServiceLines(
  services?: IdentificationSheetAddonService[] | null,
): string[] {
  if (!services || services.length === 0) {
    return ["None selected by customer."];
  }
  const lines: string[] = [];
  for (const service of services) {
    const name = pdfSafeText(service.name, 35);
    const price =
      service.pricingType === "STAFF_PRICED"
        ? "Staff Priced"
        : service.priceChargedOnlinePaise === 0
          ? "Free"
          : formatAmountPaise(service.priceChargedOnlinePaise);
    const handling =
      service.handlingMode === "POST_PRINT"
        ? "Staff Finishing"
        : service.handlingMode === "MANUAL_PRINT"
          ? "Manual Print"
          : "Automatic";
    lines.push(`- ${name} (${price}) -- ${handling}`);
  }
  return lines.slice(0, 6);
}

function validateData(data: IdentificationSheetData): void {
  if (!pdfSafeText(data.jobCode, 40)) {
    throw new IdentificationSheetError("INVALID_DATA", "Job code is required.");
  }
  if (!pdfSafeText(data.customerName, 100)) {
    throw new IdentificationSheetError(
      "INVALID_DATA",
      "Customer name is required.",
    );
  }
  if (!Number.isSafeInteger(data.amountPaidPaise) || data.amountPaidPaise < 0) {
    throw new IdentificationSheetError(
      "INVALID_DATA",
      "Paid amount must be a non-negative integer number of paise.",
    );
  }
  if (!Number.isSafeInteger(data.copies) || data.copies < 1) {
    throw new IdentificationSheetError(
      "INVALID_DATA",
      "Customer copy count must be a positive integer.",
    );
  }
  if (!Number.isFinite(data.paidAtMs)) {
    throw new IdentificationSheetError(
      "INVALID_DATA",
      "Paid timestamp is invalid.",
    );
  }
}

export function generateIdentificationSheetBuffer(
  data: IdentificationSheetData,
  options?: IdentificationSheetRenderOptions,
): Buffer {
  validateData(data);
  const shopName = pdfSafeText(data.shopName ?? "PrintGo Shop Operations", 60);
  const jobCode = pdfSafeText(data.jobCode, 28);
  const customerName = pdfSafeText(data.customerName, 60);
  const sheetPhone = data.customerPhone
    ? pdfSafeText(data.customerPhone, 30)
    : maskPhoneNumber(data.maskedPhone);
  const pageRange = pdfSafeText(data.pageRange, 45) || "All pages";
  const paidAt = formatPaidTime(data.paidAtMs, options);
  const amount = formatAmountPaise(data.amountPaidPaise);
  const color = data.colorMode === "COLOR" ? "Colour" : "Black & White";
  const sides = data.sides === "DOUBLE" ? "Double-sided" : "Single-sided";

  const displayCode = pdfSafeText(data.pickupCode ?? jobCode, 20);

  const lines: string[] = [
    "0.5 w",
    "50 795 m 545 795 l S",
    `BT /F2 ${Math.min(16, 495 / Math.max(1, shopName.length * 0.95)).toFixed(2)} Tf 50 772 Td (${escapePdfText(shopName)}) Tj ET`,
    `BT /F1 10 Tf 50 756 Td (${escapePdfText("JOB IDENTIFICATION SHEET")}) Tj ET`,
    "50 744 m 545 744 l S",
    "0.75 w 50 645 495 85 re S",
    "BT /F1 10 Tf 65 712 Td (PICKUP CODE - VERIFY WITH CUSTOMER) Tj ET",
    `BT /F2 ${Math.min(36, 465 / Math.max(1, displayCode.length * 0.95)).toFixed(2)} Tf 65 665 Td (${escapePdfText(displayCode)}) Tj ET`,
    "0.5 w 50 525 495 105 re S",
    "BT /F2 11 Tf 65 612 Td (CUSTOMER AND ORDER DETAILS) Tj ET",
    "BT /F1 10 Tf 15 TL 65 592 Td",
    `(${escapePdfText(`Customer Name:  ${customerName}`)}) Tj T*`,
    `(${escapePdfText(`Phone Number:   ${sheetPhone}`)}) Tj T*`,
    `(${escapePdfText(`Amount Paid:    ${amount} (INR)${data.dueAtPickupPaise && data.dueAtPickupPaise > 0 ? `  |  Due at pickup: ${formatAmountPaise(data.dueAtPickupPaise)}` : ""}`)}) Tj T*`,
    `(${escapePdfText(`Paid / Ordered: ${paidAt}`)}) Tj T* ET`,
    "0.5 w 50 395 495 115 re S",
    "BT /F2 11 Tf 65 492 Td (CUSTOMER PRINT SUMMARY) Tj ET",
    "BT /F1 10 Tf 15 TL 65 472 Td",
    `(${escapePdfText(`Paper Size:     ${data.paperSize}`)}) Tj T*`,
    `(${escapePdfText(`Colour Mode:    ${color}`)}) Tj T*`,
    `(${escapePdfText(`Sides:          ${sides}`)}) Tj T*`,
    `(${escapePdfText(`Page Range:     ${pageRange}`)}) Tj T*`,
    `(${escapePdfText(`Copies Ordered: ${data.copies}`)}) Tj T* ET`,
    "0.5 w 50 240 495 140 re S",
    "BT /F2 11 Tf 65 362 Td (ADD-ON SERVICES & FINISHING) Tj ET",
    "BT /F1 10 Tf 15 TL 65 342 Td",
  ];
  for (const line of addonServiceLines(data.addonServices)) {
    lines.push(`(${escapePdfText(line)}) Tj T*`);
  }
  lines.push(
    "ET",
    "0.5 w 50 95 495 130 re S",
    "BT /F2 11 Tf 65 207 Td (CUSTOMER SPECIAL INSTRUCTIONS) Tj ET",
    "BT /F1 10 Tf 14 TL 65 187 Td",
  );
  for (const line of instructionLines(data.instructions)) {
    lines.push(`(${escapePdfText(line)}) Tj T*`);
  }
  lines.push(
    "ET",
    "0.5 w 50 75 m 545 75 l S",
    "BT /F1 9 Tf 50 58 Td (One identification sheet per order. Not a customer document.) Tj ET",
  );

  const stream = lines.join("\n");
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 595 842] >>\nendobj\n",
    [
      "3 0 obj",
      "<< /Type /Page /Parent 2 0 R /Resources << /Font <<",
      "/F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      "/F2 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
      ">> >> /Contents 4 0 R >>",
      "endobj\n",
    ].join("\n"),
    `4 0 obj\n<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}\nendstream\nendobj\n`,
  ];
  const header = "%PDF-1.4\n";
  const offsets: number[] = [];
  let byteOffset = Buffer.byteLength(header, "ascii");
  for (const object of objects) {
    offsets.push(byteOffset);
    byteOffset += Buffer.byteLength(object, "ascii");
  }
  const pad = (value: number) => String(value).padStart(10, "0");
  const xref = [
    "xref",
    "0 5",
    "0000000000 65535 f ",
    ...offsets.map((offset) => `${pad(offset)} 00000 n `),
    "trailer",
    "<< /Size 5 /Root 1 0 R >>",
    "startxref",
    String(byteOffset),
    "%%EOF\n",
  ].join("\n");
  return Buffer.from(header + objects.join("") + xref, "ascii");
}

export async function createIdentificationSheetFile(
  data: IdentificationSheetData,
  customDir?: string,
): Promise<string> {
  const dir = customDir ?? path.join(os.tmpdir(), "printgo-id-sheets");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  const filePath = path.join(
    dir,
    `id-sheet-${Date.now()}-${crypto.randomBytes(12).toString("hex")}.pdf`,
  );
  try {
    await fs.writeFile(filePath, generateIdentificationSheetBuffer(data), {
      mode: 0o600,
      flag: "wx",
    });
    return filePath;
  } catch (error) {
    await fs.rm(filePath, { force: true }).catch(() => undefined);
    if (error instanceof IdentificationSheetError) throw error;
    throw new IdentificationSheetError(
      "CREATE_FAILED",
      "Could not create the local identification sheet.",
      { cause: error },
    );
  }
}

export async function withIdentificationSheetFile<T>(
  data: IdentificationSheetData,
  action: (filePath: string) => Promise<T>,
  customDir?: string,
): Promise<T> {
  const filePath = await createIdentificationSheetFile(data, customDir);
  let actionResult: T | undefined;
  let actionError: unknown;
  try {
    actionResult = await action(filePath);
  } catch (error) {
    actionError = error;
  }

  let cleanupError: unknown;
  try {
    await fs.unlink(filePath);
  } catch (error) {
    cleanupError = error;
  }

  if (actionError && cleanupError) {
    throw new AggregateError(
      [actionError, cleanupError],
      "Identification-sheet action and temporary-file cleanup both failed.",
    );
  }
  if (actionError) {
    throw actionError instanceof Error
      ? actionError
      : new Error("Identification-sheet action failed.", {
          cause: actionError,
        });
  }
  if (cleanupError) {
    throw new IdentificationSheetError(
      "CLEANUP_FAILED",
      "Temporary identification sheet could not be deleted.",
      { cause: cleanupError },
    );
  }
  return actionResult as T;
}

export function printIdentificationSheet(
  adapter: PrinterAdapter,
  printerName: string,
  data: IdentificationSheetData,
  customDir?: string,
): Promise<SubmittedPrintJob> {
  return withIdentificationSheetFile(
    data,
    (localPdfPath) =>
      adapter.submitPdfJob({
        printerId: printerName,
        localPdfPath,
        documentTitle: `printgo-id-${pdfSafeText(data.pickupCode ?? data.jobCode, 28)}`,
        copies: 1,
        settings: {
          ...IDENTIFICATION_SHEET_PRINT_SETTINGS,
          printerName,
        },
      }),
    customDir,
  );
}
