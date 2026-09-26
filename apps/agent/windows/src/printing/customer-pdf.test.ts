import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { generateIdentificationSheetBuffer } from "./identification-sheet.js";
import {
  CustomerPdfError,
  downloadAndValidateCustomerPdf,
} from "./customer-pdf.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

function pdf() {
  return generateIdentificationSheetBuffer(
    {
      jobCode: "PG-ABC234",
      customerName: "Test",
      maskedPhone: "******3210",
      paperSize: "A4",
      colorMode: "BW",
      sides: "SINGLE",
      pageRange: "1",
      copies: 1,
      amountPaidPaise: 100,
      currency: "INR",
      instructions: null,
      paidAtMs: 1_000,
    },
    { timeZone: "UTC" },
  );
}

describe("private customer PDF download", () => {
  it("streams to an unpredictable restricted path, validates size/PDF/range, and cleans up", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "printgo-pdf-test-"));
    roots.push(root);
    const bytes = pdf();
    const local = await downloadAndValidateCustomerPdf(
      {
        url: "https://signed.invalid/private",
        expectedSizeBytes: bytes.length,
        sourcePageCount: 1,
        pageRange: "1",
      },
      () =>
        Promise.resolve(
          new Response(bytes, {
            status: 200,
            headers: { "content-length": String(bytes.length) },
          }),
        ),
      root,
    );
    expect(local.filePath).toMatch(/[0-9a-f]{32}\.pdf$/u);
    expect((await fs.stat(local.filePath)).size).toBe(bytes.length);
    await local.cleanup();
    await expect(fs.stat(local.filePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects size mismatch, malformed files, and out-of-range pages without residue", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "printgo-pdf-test-"));
    roots.push(root);
    await expect(
      downloadAndValidateCustomerPdf(
        {
          url: "https://signed.invalid",
          expectedSizeBytes: 20,
          sourcePageCount: 1,
          pageRange: "1",
        },
        () => Promise.resolve(new Response("not a pdf", { status: 200 })),
        root,
      ),
    ).rejects.toBeInstanceOf(CustomerPdfError);
    await expect(
      downloadAndValidateCustomerPdf(
        {
          url: "https://signed.invalid",
          expectedSizeBytes: pdf().length,
          sourcePageCount: 1,
          pageRange: "2",
        },
        () => Promise.resolve(new Response(pdf(), { status: 200 })),
        root,
      ),
    ).rejects.toThrow("PAGE_OUT_OF_BOUNDS");
    expect((await fs.readdir(root)).length).toBe(0);
  });
});
