import { describe, expect, it, vi } from "vitest";

import { customerApi, resolveCustomerApiUrl } from "./api";

describe("customer api URL resolution", () => {
  it("resolves relative paths with no base URL to clean relative path", () => {
    expect(resolveCustomerApiUrl("/api/customer/config", "")).toBe(
      "/api/customer/config",
    );
    expect(resolveCustomerApiUrl("api/customer/config", "")).toBe(
      "/api/customer/config",
    );
  });

  it("normalizes base URL and removes trailing slash", () => {
    const withSlash = "https://printgo-api.printgo-worker.workers.dev/";
    const withoutSlash = "https://printgo-api.printgo-worker.workers.dev";

    expect(resolveCustomerApiUrl("/api/customer/config", withSlash)).toBe(
      "https://printgo-api.printgo-worker.workers.dev/api/customer/config",
    );
    expect(resolveCustomerApiUrl("/api/customer/config", withoutSlash)).toBe(
      "https://printgo-api.printgo-worker.workers.dev/api/customer/config",
    );
  });

  it("resolves customer API endpoints correctly", () => {
    const base = "https://printgo-api.printgo-worker.workers.dev";
    expect(resolveCustomerApiUrl("/api/customer/drafts", base)).toBe(
      "https://printgo-api.printgo-worker.workers.dev/api/customer/drafts",
    );
    expect(
      resolveCustomerApiUrl("/api/customer/tracking/PG-ABC123", base),
    ).toBe(
      "https://printgo-api.printgo-worker.workers.dev/api/customer/tracking/PG-ABC123",
    );
    expect(resolveCustomerApiUrl("/api/customer/payments/create", base)).toBe(
      "https://printgo-api.printgo-worker.workers.dev/api/customer/payments/create",
    );
  });

  it("leaves absolute URLs intact (e.g. presigned R2 PUT URLs)", () => {
    const r2PresignedUrl =
      "https://ba188f82338d7a85fc6f79913fb6a653.r2.cloudflarestorage.com/printgo-pdfs/drafts/test.pdf?X-Amz-Expires=300";
    expect(
      resolveCustomerApiUrl(
        r2PresignedUrl,
        "https://printgo-api.printgo-worker.workers.dev",
      ),
    ).toBe(r2PresignedUrl);
  });

  it("customerApi.config makes a fetch request to the resolved URL", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          ok: true,
          data: { shopName: "Test Shop" },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await customerApi.config();

    expect(mockFetch).toHaveBeenCalledOnce();
    const [calledUrl] = mockFetch.mock.calls[0] as [
      string,
      RequestInit | undefined,
    ];
    expect(calledUrl).toMatch(/\/api\/customer\/config$/u);

    vi.unstubAllGlobals();
  });
});
