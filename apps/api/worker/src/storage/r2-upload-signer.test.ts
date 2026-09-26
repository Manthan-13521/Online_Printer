import { describe, expect, it } from "vitest";
import { PRINT_DOWNLOAD_AUTHORIZATION_MS } from "@printgo/domain";

import { R2UploadSigner, UPLOAD_URL_EXPIRY_SECONDS } from "./r2-upload-signer";

describe("R2UploadSigner", () => {
  it("creates a short-lived, PUT-only authorization with immutable-object headers", async () => {
    const now = Date.UTC(2026, 8, 26, 12);
    const result = await new R2UploadSigner(
      {
        accountId: "account",
        bucketName: "private-pdfs",
        accessKeyId: "test-access",
        secretAccessKey: "test-secret",
      },
      () => now,
    ).createUploadAuthorization("uploads/2026/09/order/file name.pdf");
    const url = new URL(result.uploadUrl);
    expect(url.pathname).toContain("file%20name.pdf");
    expect(url.searchParams.get("X-Amz-Expires")).toBe(
      String(UPLOAD_URL_EXPIRY_SECONDS),
    );
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toContain(
      "content-type",
    );
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toContain(
      "if-none-match",
    );
    expect(result.requiredHeaders).toEqual({
      "Content-Type": "application/pdf",
      "If-None-Match": "*",
    });
    expect(result.expiresAt).toBe(new Date(now + 300_000).toISOString());
    expect(result.uploadUrl).not.toContain("test-secret");
  });

  it("creates a short-lived GET capability without exposing permanent credentials", async () => {
    const now = Date.UTC(2026, 8, 26, 12);
    const result = await new R2UploadSigner(
      {
        accountId: "account",
        bucketName: "private-pdfs",
        accessKeyId: "test-access",
        secretAccessKey: "test-secret",
      },
      () => now,
    ).createDownloadAuthorization("orders/private/file.pdf");
    const url = new URL(result.url);
    expect(url.searchParams.get("X-Amz-Expires")).toBe(
      String(PRINT_DOWNLOAD_AUTHORIZATION_MS / 1000),
    );
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
    expect(result.expiresAtMs).toBe(now + PRINT_DOWNLOAD_AUTHORIZATION_MS);
    expect(result.url).not.toContain("test-secret");
  });
});
