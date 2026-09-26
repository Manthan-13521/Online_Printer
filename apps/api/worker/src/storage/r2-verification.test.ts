import { describe, expect, it, vi } from "vitest";

import { verifyPdfObject, type PrivateObjectStore } from "./r2-verification";

function store(size: number | null, prefix = "%PDF-1.7"): PrivateObjectStore {
  return {
    head: vi.fn(() => Promise.resolve(size === null ? null : { size })),
    readPrefix: vi.fn(() =>
      Promise.resolve(new TextEncoder().encode(prefix).buffer as ArrayBuffer),
    ),
    delete: vi.fn(() => Promise.resolve()),
  };
}

describe("verifyPdfObject", () => {
  it.each([
    [null, 10, "%PDF-1.7", "OBJECT_MISSING"],
    [0, 0, "%PDF-1.7", "EMPTY_OBJECT"],
    [9, 10, "%PDF-1.7", "SIZE_MISMATCH"],
    [11, 11, "%PDF-1.7", "PDF_TOO_LARGE"],
    [10, 10, "not a pdf", "INVALID_PDF"],
  ] as const)(
    "rejects invalid objects",
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

  it("accepts the verified R2 size", async () => {
    await expect(
      verifyPdfObject(store(10), {
        key: "object",
        expectedSizeBytes: 10,
        maximumSizeBytes: 10,
      }),
    ).resolves.toEqual({ ok: true, sizeBytes: 10 });
  });
});
