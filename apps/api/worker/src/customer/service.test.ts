import { describe, expect, it, vi } from "vitest";

/* eslint-disable @typescript-eslint/unbound-method -- Vitest inspects method mocks without invoking them. */

import { FILE_SIZE_SERVICE_CHARGE_BANDS } from "@printgo/domain";

import type {
  CustomerDraftRecord,
  CustomerFileRecord,
  CustomerRepository,
} from "./repository";
import { CustomerService } from "./service";

const now = Date.UTC(2026, 8, 26);
const draft: CustomerDraftRecord = {
  orderId: "order-a",
  uploadId: "upload-a",
  objectKey: "private-a",
  expectedSizeBytes: 100,
  actualSizeBytes: 100,
  sourcePageCount: 10,
  status: "UPLOADED",
  storageStatus: "UPLOADED",
  expiresAtMs: now + 60_000,
};

function repository(
  found: CustomerDraftRecord | null = draft,
): CustomerRepository {
  return {
    getPublicConfig: vi.fn(() =>
      Promise.resolve({
        shopName: "Shop",
        contactPhone: null,
        customerNotice: null,
        onlinePrintingEnabled: true,
        maxPdfSizeBytes: 25 * 1024 * 1024,
        availablePrintOptions: [
          {
            paperSize: "A4" as const,
            colorMode: "BW" as const,
            sides: "SINGLE" as const,
          },
        ],
      }),
    ),
    getDefaultPrintOption: vi.fn(() =>
      Promise.resolve({
        paperSize: "A4" as const,
        colorMode: "BW" as const,
        sides: "SINGLE" as const,
      }),
    ),
    getPricingConfiguration: vi.fn(() =>
      Promise.resolve({
        maxPdfSizeBytes: 25 * 1024 * 1024,
        printRates: (["A4", "A3"] as const).flatMap((paperSize) =>
          (["BW", "COLOR"] as const).flatMap((colorMode) =>
            (["SINGLE", "DOUBLE"] as const).map((sides) => ({
              paperSize,
              colorMode,
              sides,
              pricePerPagePaise: 200,
              enabled: true,
            })),
          ),
        ),
        fileSizeServiceCharges: FILE_SIZE_SERVICE_CHARGE_BANDS.map((band) => ({
          ...band,
          chargePaise: 100,
          enabled: true,
        })),
      }),
    ),
    createDraft: vi.fn(() => Promise.resolve()),
    findDraft: vi.fn(() => Promise.resolve(found)),
    findDraftSummary: vi.fn(() => Promise.resolve(null)),
    listFiles: vi.fn(() => Promise.resolve([])),
    findFile: vi.fn(() => Promise.resolve(null)),
    addFile: vi.fn(() => Promise.resolve(null)),
    claimFileRemoval: vi.fn(() => Promise.resolve(false)),
    markFileRemovalFailed: vi.fn(() => Promise.resolve()),
    deleteFile: vi.fn(() => Promise.resolve(false)),
    markUploadValidated: vi.fn(() => Promise.resolve()),
    markValidationFailure: vi.fn(() => Promise.resolve()),
    saveQuote: vi.fn(() => Promise.resolve()),
    saveOrderQuote: vi.fn(() => Promise.resolve(false)),
    getPricingRulesAndPolicy: vi.fn(() =>
      Promise.resolve({
        priorityPrinting: { enabled: false, feePaise: 0 },
        identificationPolicy: { mode: "OFF" as const, thresholdPaise: 0 },
        discountRules: [],
      }),
    ),
    findPublicTrackingByPickupCode: vi.fn(() => Promise.resolve(null)),
    snapshotAddonServices: vi.fn(() => Promise.resolve()),
    getOrderAddonAmountPaise: vi.fn(() => Promise.resolve(0)),
    getOrderAddonSnapshots: vi.fn(() => Promise.resolve([])),
  };
}

function service(repo: CustomerRepository) {
  return new CustomerService(
    repo,
    {
      createUploadAuthorization: vi.fn(() =>
        Promise.resolve({
          uploadUrl: "signed",
          expiresAt: "soon",
          requiredHeaders: {},
        }),
      ),
    },
    { head: vi.fn(), readPrefix: vi.fn(), delete: vi.fn() },
    () => now,
  );
}

describe("CustomerService", () => {
  it("returns a strong raw token once while persisting only its hash", async () => {
    const repo = repository();
    const result = await service(repo).createDraft({
      customerName: "Rahul",
      customerPhone: "+91 9876543210",
      instructions: null,
      originalFilename: "notes.pdf",
      expectedSizeBytes: 100,
      sourcePageCount: 2,
    });
    expect(result.draftToken).toHaveLength(43);
    expect(repo.createDraft).toHaveBeenCalledOnce();
    const persisted = vi.mocked(repo.createDraft).mock.calls[0]?.[0];
    expect(persisted?.tokenHash).not.toBe(result.draftToken);
    expect(JSON.stringify(persisted)).not.toContain(result.draftToken);
    expect(persisted?.objectKey).not.toContain("notes.pdf");
  });

  it("blocks draft creation while online printing is off", async () => {
    const repo = repository();
    vi.mocked(repo.getPublicConfig).mockResolvedValueOnce({
      shopName: "Shop",
      contactPhone: null,
      customerNotice: null,
      onlinePrintingEnabled: false,
      maxPdfSizeBytes: 100,
      availablePrintOptions: [],
    });
    await expect(
      service(repo).createDraft({
        customerName: "Rahul",
        customerPhone: "9876543210",
        instructions: null,
        originalFilename: "a.pdf",
        expectedSizeBytes: 10,
        sourcePageCount: 1,
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "ONLINE_PRINTING_DISABLED" }),
    );
    expect(repo.createDraft).not.toHaveBeenCalled();
  });

  it("does not delete R2 when file removal cannot be claimed before payment", async () => {
    const repo = repository();
    vi.mocked(repo.findDraftSummary).mockResolvedValue({
      orderId: "order-a",
      customerName: "Rahul",
      customerPhone: "9876543210",
      instructions: null,
      status: "PAYMENT_PENDING",
      expiresAtMs: now + 60_000,
    });
    vi.mocked(repo.listFiles).mockResolvedValue([
      { id: "file-a", objectKey: "uploads/order-a/file-a.pdf" },
      { id: "file-b", objectKey: "uploads/order-a/file-b.pdf" },
    ] as CustomerFileRecord[]);
    vi.mocked(repo.claimFileRemoval).mockResolvedValue(false);
    const objects = {
      head: vi.fn(),
      readPrefix: vi.fn(),
      delete: vi.fn(() => Promise.resolve()),
    };
    const customer = new CustomerService(
      repo,
      { createUploadAuthorization: vi.fn() },
      objects,
      () => now,
    );

    await expect(customer.removeFile("token", "file-a")).rejects.toMatchObject({
      code: "UPLOAD_STATE_INVALID",
    });
    expect(objects.delete).not.toHaveBeenCalled();
  });

  it("rejects metadata larger than the shop maximum before signing", async () => {
    const repo = repository();
    vi.mocked(repo.getPublicConfig).mockResolvedValueOnce({
      shopName: "Shop",
      contactPhone: null,
      customerNotice: null,
      onlinePrintingEnabled: true,
      maxPdfSizeBytes: 99,
      availablePrintOptions: [],
    });
    await expect(
      service(repo).createDraft({
        customerName: "Rahul",
        customerPhone: "9876543210",
        instructions: null,
        originalFilename: "a.pdf",
        expectedSizeBytes: 100,
        sourcePageCount: 1,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "UPLOAD_INVALID" }));
    expect(repo.createDraft).not.toHaveBeenCalled();
  });

  it("rejects expired drafts before issuing another upload URL", async () => {
    await expect(
      service(repository({ ...draft, expiresAtMs: now })).authorizeUpload(
        "token",
      ),
    ).rejects.toEqual(expect.objectContaining({ code: "DRAFT_EXPIRED" }));
  });

  it("blocks reauthorization and quoting when the shop is paused", async () => {
    const repo = repository();
    vi.mocked(repo.getPublicConfig).mockResolvedValue({
      shopName: "Shop",
      contactPhone: null,
      customerNotice: null,
      onlinePrintingEnabled: false,
      maxPdfSizeBytes: 100,
      availablePrintOptions: [],
    });
    await expect(service(repo).authorizeUpload("token")).rejects.toEqual(
      expect.objectContaining({ code: "ONLINE_PRINTING_DISABLED" }),
    );
    await expect(
      service(repo).quote("token", {
        selectedPages: "1",
        copies: 1,
        paperSize: "A4",
        colorMode: "BW",
        sides: "SINGLE",
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "ONLINE_PRINTING_DISABLED" }),
    );
  });

  it("derives selected page count from the normalized range", async () => {
    const repo = repository();
    const quote = await service(repo).quote("token-a", {
      selectedPages: "1,2,2,5-6",
      copies: 2,
      paperSize: "A4",
      colorMode: "BW",
      sides: "SINGLE",
    });
    expect(quote.normalizedSelectedPages).toBe("1-2,5-6");
    expect(quote.selectedPageCount).toBe(4);
    expect(quote.printingAmountPaise).toBe(1600);
  });

  it("fails closed when a token does not resolve to its own draft", async () => {
    await expect(
      service(repository(null)).authorizeUpload("token-b"),
    ).rejects.toEqual(expect.objectContaining({ code: "DRAFT_INVALID" }));
  });

  it("uses authoritative stored size for the service-charge band", async () => {
    const repo = repository({
      ...draft,
      expectedSizeBytes: 1,
      actualSizeBytes: 3 * 1024 * 1024,
    });
    vi.mocked(repo.getPricingConfiguration).mockResolvedValueOnce({
      maxPdfSizeBytes: 25 * 1024 * 1024,
      printRates: (["A4", "A3"] as const).flatMap((selectedPaper) =>
        (["BW", "COLOR"] as const).flatMap((selectedColor) =>
          (["SINGLE", "DOUBLE"] as const).map((selectedSides) => ({
            paperSize: selectedPaper,
            colorMode: selectedColor,
            sides: selectedSides,
            pricePerPagePaise: 200,
            enabled: true,
          })),
        ),
      ),
      fileSizeServiceCharges: FILE_SIZE_SERVICE_CHARGE_BANDS.map(
        (band, index) => ({
          ...band,
          chargePaise: (index + 1) * 100,
          enabled: true,
        }),
      ),
    });
    const quote = await service(repo).quote("token", {
      selectedPages: "1",
      copies: 1,
      paperSize: "A4",
      colorMode: "BW",
      sides: "SINGLE",
    });
    expect(quote.serviceChargePaise).toBe(200);
  });

  it("transitions only after object verification succeeds", async () => {
    const repo = repository({
      ...draft,
      status: "UPLOADING",
      storageStatus: "PENDING",
      actualSizeBytes: null,
    });
    const objectStore = {
      head: vi.fn(() => Promise.resolve({ size: 100 })),
      readPrefix: vi.fn(() =>
        Promise.resolve(
          new TextEncoder().encode("%PDF-1.7\n%%EOF").buffer as ArrayBuffer,
        ),
      ),
      delete: vi.fn(() => Promise.resolve()),
    };
    const uploadService = new CustomerService(
      repo,
      {
        createUploadAuthorization: vi.fn(() =>
          Promise.reject(new Error("unused")),
        ),
      },
      objectStore,
      () => now,
    );
    await expect(uploadService.completeUpload("token")).resolves.toEqual({
      sizeBytes: 100,
      uploadedAt: new Date(now).toISOString(),
      draftExpiresAt: new Date(now + 600_000).toISOString(),
    });
    expect(repo.markUploadValidated).toHaveBeenCalledWith(
      expect.objectContaining({ actualSizeBytes: 100 }),
    );
  });

  it("deletes a size-mismatched object and refuses the transition", async () => {
    const repo = repository({
      ...draft,
      status: "UPLOADING",
      storageStatus: "PENDING",
      actualSizeBytes: null,
    });
    const objectStore = {
      head: vi.fn(() => Promise.resolve({ size: 101 })),
      readPrefix: vi.fn(() => Promise.resolve(null)),
      delete: vi.fn(() => Promise.resolve()),
    };
    const uploadService = new CustomerService(
      repo,
      {
        createUploadAuthorization: vi.fn(() =>
          Promise.reject(new Error("unused")),
        ),
      },
      objectStore,
      () => now,
    );
    await expect(uploadService.completeUpload("token")).rejects.toEqual(
      expect.objectContaining({ code: "UPLOAD_INVALID" }),
    );
    expect(objectStore.delete).toHaveBeenCalledWith("private-a");
    expect(repo.markValidationFailure).toHaveBeenCalledWith(
      "upload-a",
      "SIZE_MISMATCH",
      now,
    );
    expect(repo.markUploadValidated).not.toHaveBeenCalled();
  });
});
