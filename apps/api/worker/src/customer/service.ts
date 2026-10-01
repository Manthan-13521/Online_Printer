import type {
  AddCustomerFileData,
  AddCustomerFileRequest,
  CompleteCustomerUploadData,
  CreateCustomerDraftData,
  CreateCustomerDraftRequest,
  CustomerDraftData,
  CustomerFileQuoteData,
  CustomerOrderQuoteRequest,
  CustomerPrintSettingsRequest,
  CustomerQuoteData,
  UploadAuthorization,
} from "@printgo/api-contract";
import { createSessionToken, hashSessionToken } from "@printgo/auth";
import {
  MAX_ORDER_UPLOAD_BYTES,
  MAX_ORDER_FILES,
  parsePageRange,
  UNPAID_RETENTION_MS,
} from "@printgo/domain";
import { calculatePrintPrice, PricingError } from "@printgo/pricing";

import type {
  CustomerRepository,
  CustomerDraftRecord,
  CustomerDraftSummary,
  CustomerFileRecord,
} from "./repository";
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
  | "FILE_LIMIT_REACHED"
  | "AGGREGATE_LIMIT_REACHED"
  | "FILE_NOT_FOUND"
  | "LAST_FILE_REQUIRED"
  | "FILE_DELETE_FAILED"
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

  private async requireSummary(rawToken: string): Promise<{
    tokenHash: string;
    draft: CustomerDraftSummary;
  }> {
    const tokenHash = await hashSessionToken(rawToken);
    const draft = await this.repository.findDraftSummary(tokenHash);
    if (!draft) throw new CustomerError("DRAFT_INVALID");
    if (draft.expiresAtMs <= this.now())
      throw new CustomerError("DRAFT_EXPIRED");
    return { tokenHash, draft };
  }

  private async requireFile(
    rawToken: string,
    fileId?: string,
  ): Promise<{ tokenHash: string; file: CustomerFileRecord }> {
    if (!fileId) {
      const tokenHash = await hashSessionToken(rawToken);
      const legacy = await this.requireDraft(rawToken);
      return {
        tokenHash,
        file: {
          id: legacy.uploadId,
          orderId: legacy.orderId,
          position: 1,
          originalFilename: "document.pdf",
          objectKey: legacy.objectKey,
          expectedSizeBytes: legacy.expectedSizeBytes,
          actualSizeBytes: legacy.actualSizeBytes,
          sourcePageCount: legacy.sourcePageCount,
          selectedPages: "ALL",
          selectedPageCount: null,
          copies: 1,
          paperSize: "A4",
          colorMode: "BW",
          sides: "SINGLE",
          printingAmountPaise: 0,
          serviceChargePaise: 0,
          uploadStatus: legacy.storageStatus,
          printStatus: "PENDING",
          expiresAtMs: legacy.expiresAtMs,
        },
      };
    }
    const { tokenHash } = await this.requireSummary(rawToken);
    const file = await this.repository.findFile(tokenHash, fileId);
    if (!file) throw new CustomerError("FILE_NOT_FOUND");
    return { tokenHash, file };
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
    const objectKey = `uploads/${orderId}/${uploadId}.pdf`;
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
      fileId: uploadId,
      position: 1,
      upload: await this.signer.createUploadAuthorization(objectKey),
    };
  }

  async authorizeUpload(
    rawToken: string,
    fileId?: string,
  ): Promise<UploadAuthorization> {
    await this.requireOnline();
    const { file } = await this.requireFile(rawToken, fileId);
    if (file.uploadStatus !== "PENDING") {
      throw new CustomerError("UPLOAD_STATE_INVALID");
    }
    return this.signer.createUploadAuthorization(file.objectKey);
  }

  async completeUpload(
    rawToken: string,
    fileId?: string,
  ): Promise<CompleteCustomerUploadData> {
    const config = await this.requireOnline();
    const { file } = await this.requireFile(rawToken, fileId);
    if (file.uploadStatus === "UPLOADED" && file.actualSizeBytes) {
      return {
        ...(fileId ? { fileId: file.id } : {}),
        sizeBytes: file.actualSizeBytes,
        uploadedAt: new Date(this.now()).toISOString(),
        draftExpiresAt: new Date(file.expiresAtMs).toISOString(),
      };
    }
    if (file.uploadStatus !== "PENDING") {
      throw new CustomerError("UPLOAD_STATE_INVALID");
    }
    const result = await verifyPdfObject(this.objects, {
      key: file.objectKey,
      expectedSizeBytes: file.expectedSizeBytes,
      maximumSizeBytes: config.maxPdfSizeBytes,
    });
    if (!result.ok) {
      if (result.code !== "OBJECT_MISSING") {
        try {
          await this.objects.delete(file.objectKey);
        } catch {
          // The UNPAID cleanup deadline remains authoritative if immediate deletion fails.
        }
      }
      await this.repository.markValidationFailure(
        file.id,
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
      orderId: file.orderId,
      uploadId: file.id,
      actualSizeBytes: result.sizeBytes,
      nowMs,
      expiresAtMs,
    });
    return {
      ...(fileId ? { fileId: file.id } : {}),
      sizeBytes: result.sizeBytes,
      uploadedAt: new Date(nowMs).toISOString(),
      draftExpiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  async addFile(
    rawToken: string,
    input: AddCustomerFileRequest,
  ): Promise<AddCustomerFileData> {
    const config = await this.requireOnline();
    if (
      input.expectedSizeBytes <= 0 ||
      input.expectedSizeBytes > config.maxPdfSizeBytes
    )
      throw new CustomerError("UPLOAD_INVALID");
    const { tokenHash, draft } = await this.requireSummary(rawToken);
    const files = await this.repository.listFiles(tokenHash);
    if (files.length >= MAX_ORDER_FILES)
      throw new CustomerError("FILE_LIMIT_REACHED");
    if (
      files.reduce((total, file) => total + file.expectedSizeBytes, 0) +
        input.expectedSizeBytes >
      (config.maxOrderUploadBytes ?? MAX_ORDER_UPLOAD_BYTES)
    )
      throw new CustomerError("AGGREGATE_LIMIT_REACHED");
    const option = await this.repository.getDefaultPrintOption();
    if (!option) throw new CustomerError("PRINT_OPTIONS_UNAVAILABLE");
    const nowMs = this.now();
    const expiresAtMs = nowMs + UNPAID_RETENTION_MS;
    const fileId = crypto.randomUUID();
    const objectKey = `uploads/${draft.orderId}/${fileId}.pdf`;
    const created = await this.repository.addFile({
      tokenHash,
      fileId,
      objectKey,
      ...input,
      ...option,
      nowMs,
      expiresAtMs,
    });
    if (!created) throw new CustomerError("UPLOAD_STATE_INVALID");
    return {
      fileId,
      position: created.position,
      draftExpiresAt: new Date(expiresAtMs).toISOString(),
      upload: await this.signer.createUploadAuthorization(objectKey),
    };
  }

  async removeFile(
    rawToken: string,
    fileId: string,
  ): Promise<CustomerDraftData> {
    const { tokenHash } = await this.requireSummary(rawToken);
    const files = await this.repository.listFiles(tokenHash);
    if (files.length <= 1) throw new CustomerError("LAST_FILE_REQUIRED");
    const selected = files.find((file) => file.id === fileId);
    if (!selected) throw new CustomerError("FILE_NOT_FOUND");
    const nowMs = this.now();
    if (!(await this.repository.claimFileRemoval(tokenHash, fileId, nowMs)))
      throw new CustomerError("UPLOAD_STATE_INVALID");
    try {
      await this.objects.delete(selected.objectKey);
    } catch {
      await this.repository.markFileRemovalFailed(fileId, this.now());
      throw new CustomerError("FILE_DELETE_FAILED");
    }
    if (!(await this.repository.deleteFile(tokenHash, fileId, this.now())))
      throw new CustomerError("UPLOAD_STATE_INVALID");
    return this.getDraft(rawToken);
  }

  async getDraft(rawToken: string): Promise<CustomerDraftData> {
    const { tokenHash, draft } = await this.requireSummary(rawToken);
    const files = await this.repository.listFiles(tokenHash);
    return {
      customerName: draft.customerName,
      customerPhone: draft.customerPhone,
      instructions: draft.instructions,
      status: draft.status,
      files: files.map((file) => ({
        fileId: file.id,
        originalFilename: file.originalFilename,
        sizeBytes: file.actualSizeBytes,
        sourcePageCount: file.sourcePageCount,
        selectedPages: file.selectedPages,
        copies: file.copies,
        paperSize: file.paperSize,
        colorMode: file.colorMode,
        sides: file.sides,
        printingAmountPaise: file.printingAmountPaise,
        serviceChargePaise: file.serviceChargePaise,
        uploadStatus: file.uploadStatus,
      })),
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

  async quoteOrder(
    rawToken: string,
    input: CustomerOrderQuoteRequest,
  ): Promise<CustomerQuoteData> {
    await this.requireOnline();
    const { tokenHash } = await this.requireSummary(rawToken);
    const stored = await this.repository.listFiles(tokenHash);
    if (
      stored.length < 1 ||
      stored.length > MAX_ORDER_FILES ||
      input.files.length !== stored.length ||
      new Set(input.files.map((file) => file.fileId)).size !== stored.length ||
      stored.some((file) => file.uploadStatus !== "UPLOADED")
    )
      throw new CustomerError("QUOTE_STATE_INVALID");
    const byId = new Map(input.files.map((file) => [file.fileId, file]));
    const configuration = await this.repository.getPricingConfiguration();
    const quoted: CustomerFileQuoteData[] = [];
    try {
      for (const file of stored) {
        const requested = byId.get(file.id);
        if (!requested || !file.actualSizeBytes)
          throw new CustomerError("QUOTE_STATE_INVALID");
        const selection = parsePageRange(
          requested.selectedPages,
          file.sourcePageCount,
        );
        const price = calculatePrintPrice(
          {
            pageCount: selection.selectedPageCount,
            copies: requested.copies,
            fileSizeBytes: file.actualSizeBytes,
            paperSize: requested.paperSize,
            colorMode: requested.colorMode,
            sides: requested.sides,
          },
          configuration,
        );
        quoted.push({
          fileId: file.id,
          originalFilename: file.originalFilename,
          sizeBytes: file.actualSizeBytes,
          sourcePageCount: file.sourcePageCount,
          selectedPages: selection.normalized,
          selectedPageCount: selection.selectedPageCount,
          copies: requested.copies,
          paperSize: requested.paperSize,
          colorMode: requested.colorMode,
          sides: requested.sides,
          printingAmountPaise: price.printingAmountPaise,
          serviceChargePaise: price.serviceChargePaise,
          uploadStatus: file.uploadStatus,
        });
      }
    } catch (error) {
      if (
        error instanceof CustomerError ||
        error instanceof PricingError ||
        error instanceof RangeError ||
        (error instanceof Error && error.name === "PageRangeError")
      )
        throw new CustomerError("QUOTE_INVALID");
      throw error;
    }
    const printingAmountPaise = quoted.reduce(
      (total, file) => total + file.printingAmountPaise,
      0,
    );
    // Existing pricing applies the size-band service charge per uploaded PDF.
    const serviceChargePaise = quoted.reduce(
      (total, file) => total + file.serviceChargePaise,
      0,
    );
    const totalAmountPaise = printingAmountPaise + serviceChargePaise;
    const expiresAtMs = this.now() + UNPAID_RETENTION_MS;
    if (
      !(await this.repository.saveOrderQuote({
        tokenHash,
        files: quoted.map((file) => ({
          fileId: file.fileId,
          selectedPages: file.selectedPages,
          selectedPageCount: file.selectedPageCount,
          copies: file.copies,
          paperSize: file.paperSize,
          colorMode: file.colorMode,
          sides: file.sides,
          printingAmountPaise: file.printingAmountPaise,
          serviceChargePaise: file.serviceChargePaise,
        })),
        printingAmountPaise,
        serviceChargePaise,
        totalAmountPaise,
        nowMs: this.now(),
        expiresAtMs,
      }))
    )
      throw new CustomerError("QUOTE_STATE_INVALID");
    const first = quoted[0];
    if (!first) throw new CustomerError("QUOTE_STATE_INVALID");
    return {
      normalizedSelectedPages: first.selectedPages,
      selectedPageCount: first.selectedPageCount,
      copies: first.copies,
      paperSize: first.paperSize,
      colorMode: first.colorMode,
      sides: first.sides,
      printingAmountPaise,
      serviceChargePaise,
      totalAmountPaise,
      currency: "INR",
      expiresAt: new Date(expiresAtMs).toISOString(),
      files: quoted,
    };
  }
}
