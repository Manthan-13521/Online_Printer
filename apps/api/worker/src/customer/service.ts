import type {
  CreateCustomerDraftData,
  CreateCustomerDraftRequest,
  CustomerPrintSettingsRequest,
  CustomerQuoteData,
  UploadAuthorization,
} from "@printgo/api-contract";
import { createSessionToken, hashSessionToken } from "@printgo/auth";
import { parsePageRange, UNPAID_RETENTION_MS } from "@printgo/domain";
import { calculatePrintPrice, PricingError } from "@printgo/pricing";

import type { CustomerRepository, CustomerDraftRecord } from "./repository";
import type { UploadSigner } from "../storage/r2-upload-signer";
import {
  verifyPdfObject,
  type PrivateObjectStore,
} from "../storage/r2-verification";

export type CustomerErrorCode =
  | "ONLINE_PRINTING_DISABLED"
  | "PRINT_OPTIONS_UNAVAILABLE"
  | "DRAFT_INVALID"
  | "DRAFT_EXPIRED"
  | "UPLOAD_STATE_INVALID"
  | "UPLOAD_NOT_FOUND"
  | "UPLOAD_INVALID"
  | "QUOTE_STATE_INVALID"
  | "QUOTE_INVALID";

export class CustomerError extends Error {
  constructor(readonly code: CustomerErrorCode) {
    super(code);
    this.name = "CustomerError";
  }
}

export class CustomerService {
  constructor(
    private readonly repository: CustomerRepository,
    private readonly signer: UploadSigner,
    private readonly objects: PrivateObjectStore,
    private readonly now: () => number = Date.now,
  ) {}

  private async requireDraft(rawToken: string): Promise<CustomerDraftRecord> {
    const draft = await this.repository.findDraft(
      await hashSessionToken(rawToken),
    );
    if (!draft) throw new CustomerError("DRAFT_INVALID");
    if (draft.expiresAtMs <= this.now())
      throw new CustomerError("DRAFT_EXPIRED");
    return draft;
  }

  private async requireOnline() {
    const config = await this.repository.getPublicConfig();
    if (!config?.onlinePrintingEnabled) {
      throw new CustomerError("ONLINE_PRINTING_DISABLED");
    }
    return config;
  }

  async createDraft(
    input: CreateCustomerDraftRequest,
  ): Promise<CreateCustomerDraftData> {
    const config = await this.requireOnline();
    if (
      input.expectedSizeBytes <= 0 ||
      input.expectedSizeBytes > config.maxPdfSizeBytes
    ) {
      throw new CustomerError("UPLOAD_INVALID");
    }
    const option = await this.repository.getDefaultPrintOption();
    if (!option) throw new CustomerError("PRINT_OPTIONS_UNAVAILABLE");
    const token = await createSessionToken();
    const nowMs = this.now();
    const expiresAtMs = nowMs + UNPAID_RETENTION_MS;
    const orderId = crypto.randomUUID();
    const uploadId = crypto.randomUUID();
    const date = new Date(nowMs);
    const objectKey = `uploads/${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, "0")}/${orderId}/${crypto.randomUUID()}.pdf`;
    await this.repository.createDraft({
      ...input,
      ...option,
      orderId,
      uploadId,
      tokenHash: token.tokenHash,
      objectKey,
      nowMs,
      expiresAtMs,
    });
    return {
      draftToken: token.rawToken,
      draftExpiresAt: new Date(expiresAtMs).toISOString(),
      upload: await this.signer.createUploadAuthorization(objectKey),
    };
  }

  async authorizeUpload(rawToken: string): Promise<UploadAuthorization> {
    await this.requireOnline();
    const draft = await this.requireDraft(rawToken);
    if (draft.storageStatus !== "PENDING" || draft.status !== "UPLOADING") {
      throw new CustomerError("UPLOAD_STATE_INVALID");
    }
    return this.signer.createUploadAuthorization(draft.objectKey);
  }

  async completeUpload(rawToken: string) {
    const config = await this.requireOnline();
    const draft = await this.requireDraft(rawToken);
    if (draft.storageStatus === "UPLOADED" && draft.actualSizeBytes) {
      return {
        sizeBytes: draft.actualSizeBytes,
        uploadedAt: new Date(this.now()).toISOString(),
        draftExpiresAt: new Date(draft.expiresAtMs).toISOString(),
      };
    }
    if (draft.storageStatus !== "PENDING" || draft.status !== "UPLOADING") {
      throw new CustomerError("UPLOAD_STATE_INVALID");
    }
    const result = await verifyPdfObject(this.objects, {
      key: draft.objectKey,
      expectedSizeBytes: draft.expectedSizeBytes,
      maximumSizeBytes: config.maxPdfSizeBytes,
    });
    if (!result.ok) {
      if (result.code !== "OBJECT_MISSING") {
        try {
          await this.objects.delete(draft.objectKey);
        } catch {
          // The UNPAID cleanup deadline remains authoritative if immediate deletion fails.
        }
      }
      await this.repository.markValidationFailure(
        draft.uploadId,
        result.code,
        this.now(),
      );
      throw new CustomerError(
        result.code === "OBJECT_MISSING"
          ? "UPLOAD_NOT_FOUND"
          : "UPLOAD_INVALID",
      );
    }
    const nowMs = this.now();
    const expiresAtMs = nowMs + UNPAID_RETENTION_MS;
    await this.repository.markUploadValidated({
      orderId: draft.orderId,
      uploadId: draft.uploadId,
      actualSizeBytes: result.sizeBytes,
      nowMs,
      expiresAtMs,
    });
    return {
      sizeBytes: result.sizeBytes,
      uploadedAt: new Date(nowMs).toISOString(),
      draftExpiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  async quote(
    rawToken: string,
    input: CustomerPrintSettingsRequest,
  ): Promise<CustomerQuoteData> {
    await this.requireOnline();
    const draft = await this.requireDraft(rawToken);
    if (
      !["UPLOADED", "PAYMENT_PENDING"].includes(draft.status) ||
      draft.storageStatus !== "UPLOADED" ||
      !draft.actualSizeBytes
    ) {
      throw new CustomerError("QUOTE_STATE_INVALID");
    }
    try {
      const selection = parsePageRange(
        input.selectedPages,
        draft.sourcePageCount,
      );
      const price = calculatePrintPrice(
        {
          pageCount: selection.selectedPageCount,
          copies: input.copies,
          fileSizeBytes: draft.actualSizeBytes,
          paperSize: input.paperSize,
          colorMode: input.colorMode,
          sides: input.sides,
        },
        await this.repository.getPricingConfiguration(),
      );
      await this.repository.saveQuote({
        orderId: draft.orderId,
        selectedPages: selection.normalized,
        copies: input.copies,
        paperSize: input.paperSize,
        colorMode: input.colorMode,
        sides: input.sides,
        printingAmountPaise: price.printingAmountPaise,
        serviceChargePaise: price.serviceChargePaise,
        totalAmountPaise: price.totalAmountPaise,
        nowMs: this.now(),
      });
      return {
        normalizedSelectedPages: selection.normalized,
        selectedPageCount: selection.selectedPageCount,
        copies: input.copies,
        paperSize: input.paperSize,
        colorMode: input.colorMode,
        sides: input.sides,
        printingAmountPaise: price.printingAmountPaise,
        serviceChargePaise: price.serviceChargePaise,
        totalAmountPaise: price.totalAmountPaise,
        currency: "INR",
        expiresAt: new Date(draft.expiresAtMs).toISOString(),
      };
    } catch (error) {
      if (error instanceof PricingError || error instanceof RangeError) {
        throw new CustomerError("QUOTE_INVALID");
      }
      if (error instanceof Error && error.name === "PageRangeError") {
        throw new CustomerError("QUOTE_INVALID");
      }
      throw error;
    }
  }
}
