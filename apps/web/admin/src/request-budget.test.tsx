// @vitest-environment jsdom

/* eslint-disable @typescript-eslint/unbound-method -- Vitest inspects method mocks without invoking them. */

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { adminApi } from "./api";
import { LiveOrdersPage } from "./LiveOrdersPage";

vi.mock("./api", () => ({
  adminApi: {
    getLiveOrders: vi.fn(),
  },
  AdminApiError: class AdminApiError extends Error {
    constructor(
      public status: number,
      public code: string,
      message: string,
    ) {
      super(message);
    }
  },
  friendlyAdminError: (err: unknown) =>
    err instanceof Error ? err.message : String(err),
}));

describe("Admin Live Orders Request Budget & Polling Optimization", () => {
  const getLiveOrdersMock = vi.mocked(adminApi.getLiveOrders);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("polls boundedly when visible, but makes ZERO calls when tab is hidden", async () => {
    const mockOrders = {
      ok: true as const,
      data: { orders: [] },
    };
    getLiveOrdersMock.mockResolvedValue(mockOrders);

    render(<LiveOrdersPage onSessionExpired={vi.fn()} pollIntervalMs={1000} />);

    // Initial fetch on mount
    expect(getLiveOrdersMock).toHaveBeenCalledTimes(1);

    // Advance 1 second while visible -> 2nd call
    await vi.advanceTimersByTimeAsync(1000);
    expect(getLiveOrdersMock).toHaveBeenCalledTimes(2);

    // Now tab becomes hidden
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));

    // Advance 10 seconds while hidden -> ZERO additional calls!
    await vi.advanceTimersByTimeAsync(10000);
    expect(getLiveOrdersMock).toHaveBeenCalledTimes(2);

    // Tab becomes visible again -> triggers immediate refresh and resumes
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(getLiveOrdersMock).toHaveBeenCalledTimes(3);

    // Advance 1 second visible -> 4th call
    await vi.advanceTimersByTimeAsync(1000);
    expect(getLiveOrdersMock).toHaveBeenCalledTimes(4);
  });

  it("stops all polling and timers upon unmount", async () => {
    const mockOrders = {
      ok: true as const,
      data: { orders: [] },
    };
    getLiveOrdersMock.mockResolvedValue(mockOrders);

    const { unmount } = render(
      <LiveOrdersPage onSessionExpired={vi.fn()} pollIntervalMs={1000} />,
    );
    expect(getLiveOrdersMock).toHaveBeenCalledTimes(1);

    unmount();

    // Advance time after unmount -> ZERO additional calls
    await vi.advanceTimersByTimeAsync(5000);
    expect(getLiveOrdersMock).toHaveBeenCalledTimes(1);
  });
});
