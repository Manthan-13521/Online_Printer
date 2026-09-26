import { describe, expect, it, vi } from "vitest";

/* eslint-disable @typescript-eslint/unbound-method -- Vitest inspects method mocks without invoking them. */

import type { WorkerEnv } from "../env";
import { handleCustomerRequest, type CustomerActions } from "./routes";

const env = {
  CUSTOMER_ALLOWED_ORIGIN: "https://print.example.test",
} as WorkerEnv;
const token = "A".repeat(43);

function actions(): CustomerActions {
  return {
    getConfig: vi.fn(() =>
      Promise.resolve({
        shopName: "ABC Xerox",
        contactPhone: null,
        customerNotice: null,
        onlinePrintingEnabled: true,
        maxPdfSizeBytes: 100,
        availablePrintOptions: [
          {
            paperSize: "A4" as const,
            colorMode: "BW" as const,
            sides: "SINGLE" as const,
          },
        ],
      }),
    ),
    createDraft: vi.fn(() =>
      Promise.resolve({
        draftToken: token,
        draftExpiresAt: "2026-09-26T00:10:00.000Z",
        upload: {
          uploadUrl: "https://r2.test/signed",
          expiresAt: "2026-09-26T00:05:00.000Z",
          requiredHeaders: {},
        },
      }),
    ),
    authorizeUpload: vi.fn(() =>
      Promise.resolve({
        uploadUrl: "https://r2.test/signed",
        expiresAt: "soon",
        requiredHeaders: {},
      }),
    ),
    completeUpload: vi.fn(() =>
      Promise.resolve({
        sizeBytes: 10,
        uploadedAt: "now",
        draftExpiresAt: "later",
      }),
    ),
    quote: vi.fn(() =>
      Promise.resolve({
        normalizedSelectedPages: "1-3",
        selectedPageCount: 3,
        copies: 1,
        paperSize: "A4" as const,
        colorMode: "BW" as const,
        sides: "SINGLE" as const,
        printingAmountPaise: 300,
        serviceChargePaise: 100,
        totalAmountPaise: 400,
        currency: "INR" as const,
        expiresAt: "later",
      }),
    ),
  };
}

function request(
  path: string,
  method: string,
  body?: unknown,
  origin = env.CUSTOMER_ALLOWED_ORIGIN,
) {
  return new Request(`https://api.test${path}`, {
    method,
    headers: {
      Origin: origin,
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("customer routes", () => {
  it("returns safe public configuration with no-store", async () => {
    const response = await handleCustomerRequest(
      request("/api/customer/config", "GET"),
      env,
      actions(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(JSON.stringify(await response.json())).not.toContain("secret");
  });

  it("rejects state changes from untrusted origins before actions", async () => {
    const api = actions();
    const response = await handleCustomerRequest(
      request("/api/customer/drafts", "POST", {}, "https://evil.test"),
      env,
      api,
    );
    expect(response.status).toBe(403);
    expect(api.createDraft).not.toHaveBeenCalled();
  });

  it("ignores a client-selected page count instead of treating it as authoritative", async () => {
    const api = actions();
    const response = await handleCustomerRequest(
      request("/api/customer/draft/print-settings", "PUT", {
        selectedPages: "1-3",
        selectedPageCount: 1,
        copies: 1,
        paperSize: "A4",
        colorMode: "BW",
        sides: "SINGLE",
      }),
      env,
      api,
    );
    expect(response.status).toBe(200);
    expect(api.quote).toHaveBeenCalledWith(token, {
      selectedPages: "1-3",
      copies: 1,
      paperSize: "A4",
      colorMode: "BW",
      sides: "SINGLE",
    });
  });

  it("does not accept a token in the body", async () => {
    const api = actions();
    const response = await handleCustomerRequest(
      new Request("https://api.test/api/customer/uploads/complete", {
        method: "POST",
        headers: {
          Origin: env.CUSTOMER_ALLOWED_ORIGIN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ draftToken: token }),
      }),
      env,
      api,
    );
    expect(response.status).toBe(401);
    expect(api.completeUpload).not.toHaveBeenCalled();
  });
});
