/* eslint-disable @typescript-eslint/unbound-method -- Vitest inspects method mocks without invoking them. */

import { describe, expect, it, vi } from "vitest";

import { verifyPdfObject, type PrivateObjectStore } from "./r2-verification";

function store(
  size: number | null,
  prefix = "%PDF-1.7\n%%EOF",
  suffix?: string,
): PrivateObjectStore {
  const effectiveSuffix = suffix !== undefined ? suffix : prefix;
  return {
    head: vi.fn(() => Promise.resolve(size === null ? null : { size })),
    readPrefix: vi.fn(() =>
      Promise.resolve(new TextEncoder().encode(prefix).buffer as ArrayBuffer),
    ),
    readSuffix: vi.fn(() =>
      Promise.resolve(
        new TextEncoder().encode(effectiveSuffix).buffer as ArrayBuffer,
      ),
    ),
    delete: vi.fn(() => Promise.resolve()),
  };
}

describe("verifyPdfObject", () => {
  it.each([
    [null, 10, "%PDF-1.7\n%%EOF", "OBJECT_MISSING"],
    [0, 0, "%PDF-1.7\n%%EOF", "EMPTY_OBJECT"],
    [9, 10, "%PDF-1.7\n%%EOF", "SIZE_MISMATCH"],
    [11, 11, "%PDF-1.7\n%%EOF", "PDF_TOO_LARGE"],
    [10, 10, "not a pdf", "INVALID_PDF"],
    [10, 10, "%PDF-no-eof", "INVALID_PDF"],
    [8, 8, "\x89PNG\r\n\x1a\n", "INVALID_PDF"],
  ] as const)(
    "rejects invalid objects: size=%s expected=%s code=%s",
    async (size, expected, prefix, code) => {
      await expect(
        verifyPdfObject(store(size, prefix), {
          key: "object",
          expectedSizeBytes: expected,
          maximumSizeBytes: 10,
        }),
      ).resolves.toEqual({ ok: false, code });
    },
  );

  it("accepts a valid PDF with %%EOF", async () => {
    const valid =
      "%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\ntrailer<<>>\n%%EOF";
    await expect(
      verifyPdfObject(store(valid.length, valid), {
        key: "object",
        expectedSizeBytes: valid.length,
        maximumSizeBytes: 1000,
      }),
    ).resolves.toEqual({ ok: true, sizeBytes: valid.length });
  });

  it("accepts a valid PDF with trailing whitespace", async () => {
    const validWithTrailing =
      "%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\ntrailer<<>>\n%%EOF\r\n   \n";
    await expect(
      verifyPdfObject(store(validWithTrailing.length, validWithTrailing), {
        key: "object",
        expectedSizeBytes: validWithTrailing.length,
        maximumSizeBytes: 1000,
      }),
    ).resolves.toEqual({ ok: true, sizeBytes: validWithTrailing.length });
  });

  it("rejects truncated PDF missing %%EOF", async () => {
    const truncated = "%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\ntrailer<<>>\n";
    await expect(
      verifyPdfObject(store(truncated.length, truncated), {
        key: "object",
        expectedSizeBytes: truncated.length,
        maximumSizeBytes: 1000,
      }),
    ).resolves.toEqual({ ok: false, code: "INVALID_PDF" });
  });

  it("rejects header-only fake PDF", async () => {
    const fake = "%PDF-";
    await expect(
      verifyPdfObject(store(fake.length, fake), {
        key: "object",
        expectedSizeBytes: fake.length,
        maximumSizeBytes: 1000,
      }),
    ).resolves.toEqual({ ok: false, code: "INVALID_PDF" });
  });

  it("verifies large PDF with separate prefix and suffix read", async () => {
    const size = 5 * 1024 * 1024; // 5 MiB
    const largeStore = store(
      size,
      "%PDF-1.4\n1 0 obj ...",
      "xref ... trailer ... %%EOF\n",
    );
    await expect(
      verifyPdfObject(largeStore, {
        key: "large.pdf",
        expectedSizeBytes: size,
        maximumSizeBytes: 25 * 1024 * 1024,
      }),
    ).resolves.toEqual({ ok: true, sizeBytes: size });
    expect(largeStore.readPrefix).toHaveBeenCalledWith("large.pdf", 1024);
    expect(largeStore.readSuffix).toHaveBeenCalledWith("large.pdf", 2048);
  });

  it("enforces max-size boundary exactly at 25 MiB", async () => {
    const maxBytes = 25 * 1024 * 1024;
    const atMaxStore = store(maxBytes, "%PDF-1.4", "%%EOF");
    await expect(
      verifyPdfObject(atMaxStore, {
        key: "boundary.pdf",
        expectedSizeBytes: maxBytes,
        maximumSizeBytes: maxBytes,
      }),
    ).resolves.toEqual({ ok: true, sizeBytes: maxBytes });

    const overMaxStore = store(maxBytes + 1, "%PDF-1.4", "%%EOF");
    await expect(
      verifyPdfObject(overMaxStore, {
        key: "over.pdf",
        expectedSizeBytes: maxBytes + 1,
        maximumSizeBytes: maxBytes,
      }),
    ).resolves.toEqual({ ok: false, code: "PDF_TOO_LARGE" });
  });
});
