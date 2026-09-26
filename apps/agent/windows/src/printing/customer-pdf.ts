import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { FILE_SIZE_25_MIB, parsePageRange } from "@printgo/domain";

export class CustomerPdfError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CustomerPdfError";
  }
}

export interface DownloadCustomerPdfInput {
  url: string;
  expectedSizeBytes: number;
  sourcePageCount: number;
  pageRange: string;
}

export interface LocalCustomerPdf {
  filePath: string;
  cleanup(): Promise<void>;
}

export async function downloadAndValidateCustomerPdf(
  input: DownloadCustomerPdfInput,
  fetcher: typeof fetch = fetch,
  tempRoot = os.tmpdir(),
): Promise<LocalCustomerPdf> {
  if (
    !Number.isSafeInteger(input.expectedSizeBytes) ||
    input.expectedSizeBytes < 1 ||
    input.expectedSizeBytes > FILE_SIZE_25_MIB
  ) {
    throw new CustomerPdfError(
      "INVALID_EXPECTED_SIZE",
      "Expected PDF size is outside the supported bound.",
    );
  }
  if (input.pageRange.trim().toUpperCase() !== "ALL") {
    parsePageRange(input.pageRange, input.sourcePageCount);
  }
  const directory = await fs.mkdtemp(path.join(tempRoot, "printgo-paid-"));
  await fs.chmod(directory, 0o700);
  const filePath = path.join(
    directory,
    `${crypto.randomBytes(16).toString("hex")}.pdf`,
  );
  let handle: fs.FileHandle | null = null;
  try {
    const response = await fetcher(input.url, {
      method: "GET",
      redirect: "error",
    });
    if (!response.ok || !response.body)
      throw new CustomerPdfError(
        "DOWNLOAD_FAILED",
        `Private PDF download failed with HTTP ${response.status}.`,
      );
    const declared = response.headers.get("content-length");
    if (declared && Number(declared) !== input.expectedSizeBytes)
      throw new CustomerPdfError(
        "SIZE_MISMATCH",
        "Downloaded PDF size does not match the verified upload.",
      );
    handle = await fs.open(filePath, "wx", 0o600);
    const reader = response.body.getReader();
    let received = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value: unknown = chunk.value;
      if (!(value instanceof Uint8Array)) {
        throw new CustomerPdfError(
          "DOWNLOAD_FAILED",
          "Private PDF download returned an invalid byte stream.",
        );
      }
      received += value.byteLength;
      if (received > input.expectedSizeBytes || received > FILE_SIZE_25_MIB) {
        await reader.cancel();
        throw new CustomerPdfError(
          "SIZE_MISMATCH",
          "Downloaded PDF exceeded the verified size.",
        );
      }
      await handle.write(value);
    }
    await handle.close();
    handle = null;
    if (received !== input.expectedSizeBytes)
      throw new CustomerPdfError(
        "SIZE_MISMATCH",
        "Downloaded PDF size does not match the verified upload.",
      );
    const bytes = await fs.readFile(filePath);
    if (
      bytes.subarray(0, 5).toString("ascii") !== "%PDF-" ||
      !bytes
        .subarray(Math.max(0, bytes.length - 2048))
        .toString("latin1")
        .includes("%%EOF")
    ) {
      throw new CustomerPdfError(
        "INVALID_PDF",
        "Downloaded file is not a structurally plausible PDF.",
      );
    }
    return {
      filePath,
      cleanup: () => fs.rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs
      .rm(directory, { recursive: true, force: true })
      .catch(() => undefined);
    throw error;
  }
}
