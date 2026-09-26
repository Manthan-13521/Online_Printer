import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IdentificationSheetData } from "@printgo/api-contract";
import type { PrinterAdapter, PrintSubmission } from "./printer-adapter.js";
import {
  IDENTIFICATION_SHEET_PRINT_SETTINGS,
  generateIdentificationSheetBuffer,
  printIdentificationSheet,
  withIdentificationSheetFile,
} from "./identification-sheet.js";

const data: IdentificationSheetData = {
  jobCode: "PG-A1B2C3",
  customerName: "Asha Rao",
  maskedPhone: "+91 98765 43210",
  paperSize: "A3",
  colorMode: "COLOR",
  sides: "DOUBLE",
  pageRange: "2-7,10",
  copies: 10,
  amountPaidPaise: 12_345,
  currency: "INR",
  instructions: "Bind on left (carefully).\nनाम सुरक्षित रहे",
  paidAtMs: Date.UTC(2026, 8, 26, 10, 30),
  shopName: "ABC Xerox",
};

describe("identification sheet", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "printgo-id-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("generates a one-page A4 PDF with required operational content", () => {
    const pdf = generateIdentificationSheetBuffer(
      {
        ...data,
        trackingToken: "PRIVATE-TRACKING-TOKEN",
        r2ObjectKey: "private/customer/source.pdf",
        razorpayPaymentId: "pay_private",
      } as IdentificationSheetData,
      { timeZone: "UTC" },
    );
    const text = pdf.toString("ascii");

    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain("/Count 1 /MediaBox [0 0 595 842]");
    expect(text).toContain("PRINTGO");
    expect(text).toContain("PG-A1B2C3");
    expect(text).toContain("Asha Rao");
    expect(text).toContain("******3210");
    expect(text).not.toContain("9876543210");
    expect(text).toContain("Paper Size:     A3");
    expect(text).toContain("Colour Mode:    Colour");
    expect(text).toContain("Sides:          Double-sided");
    expect(text).toContain("Page Range:     2-7,10");
    expect(text).toContain("Copies Ordered: 10");
    expect(text).toContain("Rs. 123.45");
    expect(text).toContain("Bind on left \\(carefully\\)");
    expect(text).toContain("????");
    expect(text).not.toContain("PRIVATE-TRACKING-TOKEN");
    expect(text).not.toContain("private/customer/source.pdf");
    expect(text).not.toContain("pay_private");
  });

  it("uses fixed sheet settings independent of customer print settings", () => {
    expect(IDENTIFICATION_SHEET_PRINT_SETTINGS).toEqual({
      paperSize: "A4",
      colorMode: "BLACK_AND_WHITE",
      sides: "ONE_SIDED",
      copies: 1,
      pageRange: "1",
    });
  });

  it("deletes the temporary PDF after success and action failure", async () => {
    let successPath = "";
    await withIdentificationSheetFile(
      data,
      async (filePath) => {
        successPath = filePath;
        await expect(fs.stat(filePath)).resolves.toBeDefined();
      },
      tempDir,
    );
    await expect(fs.stat(successPath)).rejects.toMatchObject({
      code: "ENOENT",
    });

    let failurePath = "";
    await expect(
      withIdentificationSheetFile(
        data,
        (filePath) => {
          failurePath = filePath;
          return Promise.reject(new Error("submission failed"));
        },
        tempDir,
      ),
    ).rejects.toThrow("submission failed");
    await expect(fs.stat(failurePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("submits only the local identification PDF with fixed settings", async () => {
    const submissions: PrintSubmission[] = [];
    const submitPdfJob = vi.fn((submission: PrintSubmission) => {
      submissions.push(submission);
      return Promise.resolve({ spoolJobId: "42", engineUsed: "sumatrapdf" });
    });
    const adapter = { submitPdfJob } as unknown as PrinterAdapter;

    await expect(
      printIdentificationSheet(adapter, "Canon Exact Queue", data, tempDir),
    ).resolves.toEqual({ spoolJobId: "42", engineUsed: "sumatrapdf" });

    expect(submitPdfJob).toHaveBeenCalledWith(
      expect.objectContaining({
        printerId: "Canon Exact Queue",
        copies: 1,
        settings: {
          ...IDENTIFICATION_SHEET_PRINT_SETTINGS,
          printerName: "Canon Exact Queue",
        },
      }),
    );
    const submission = submissions[0]!;
    expect(submission.localPdfPath).toContain(tempDir);
    await expect(fs.stat(submission.localPdfPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
