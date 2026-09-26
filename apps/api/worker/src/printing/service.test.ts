/* eslint-disable @typescript-eslint/unbound-method -- Vitest inspects method mocks without invoking them. */
import { describe, expect, it, vi } from "vitest";

import type { DownloadSigner } from "../storage/r2-upload-signer.js";
import type { PrintingRepository } from "./repository.js";
import { PrintingService } from "./service.js";

function repository() {
  return {
    claimOrRenew: vi.fn(),
    authenticateAgent: vi.fn(),
    startStep: vi.fn(),
    recordSubmission: vi.fn(),
    recordResult: vi.fn(),
    recoverExpiredClaims: vi.fn(),
    findOwnedStep: vi.fn(),
    listLiveOrders: vi.fn(),
  } as unknown as PrintingRepository;
}

describe("PrintingService authorization contract", () => {
  it("signs a private GET only after an eligible claim exists and returns no infrastructure secrets", async () => {
    const repo = repository();
    vi.mocked(repo.claimOrRenew).mockResolvedValue({
      orderId: "order",
      attemptId: "attempt",
      claimId: "claim",
      leaseExpiresAtMs: 10_000,
      jobCode: "PG-ABC234",
      printerId: "printer",
      windowsPrinterName: "Exact Printer",
      objectKey: "private/order.pdf",
      expectedSizeBytes: 100,
      sourcePageCount: 2,
      pageRange: "1-2",
      copies: 2,
      paperSize: "A4",
      colorMode: "BW",
      sides: "SINGLE",
      identificationSheet: null,
      currentStep: {
        stepId: "step",
        sequenceNumber: 1,
        type: "CUSTOMER_DOCUMENT",
        status: "PENDING",
        spoolerJobId: null,
      },
    });
    const signer = {
      createDownloadAuthorization: vi.fn(() =>
        Promise.resolve({
          url: "https://signed.invalid/object?signature=opaque",
          expiresAtMs: 9_000,
        }),
      ),
    } satisfies DownloadSigner;
    const service = new PrintingService(repo, signer, () => 1_000);
    const result = await service.claimOrRenew("agent");
    expect(signer.createDownloadAuthorization).toHaveBeenCalledWith(
      "private/order.pdf",
    );
    expect(result).not.toHaveProperty("objectKey");
    expect(JSON.stringify(result)).not.toMatch(
      /accessKey|secret|razorpay|trackingToken|draftToken/iu,
    );

    vi.mocked(repo.claimOrRenew).mockResolvedValue(null);
    vi.mocked(signer.createDownloadAuthorization).mockClear();
    expect(await service.claimOrRenew("agent")).toBeNull();
    expect(signer.createDownloadAuthorization).not.toHaveBeenCalled();
  });

  it("rejects a revoked/wrong Agent before evaluating claim ownership", async () => {
    const repo = repository();
    vi.mocked(repo.authenticateAgent).mockResolvedValue(null);
    const service = new PrintingService(repo, {
      createDownloadAuthorization: vi.fn(),
    });
    await expect(
      service.startStep("wrong-secret", "order", "step", "claim"),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "AGENT_UNAUTHORIZED",
      }),
    );
    expect(repo.startStep).not.toHaveBeenCalled();
  });
});
