// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AdminOrderHistoryEntry } from "@printgo/api-contract";
import { OrderHistoryPage } from "./OrderHistoryPage";

const { getOrderHistory, retryOrder, deleteOrder } = vi.hoisted(() => ({
  getOrderHistory: vi.fn(),
  retryOrder: vi.fn(),
  deleteOrder: vi.fn(),
}));

vi.mock("./api", () => ({
  adminApi: {
    getOrderHistory,
    retryOrder,
    deleteOrder,
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

const baseEntry: AdminOrderHistoryEntry = {
  orderId: "ord-hist-1",
  pickupCode: "P-101",
  customerName: "Test Customer",
  customerPhone: "+919876543210",
  createdAt: new Date(Date.now() - 3600_000).toISOString(),
  completedAt: new Date(Date.now() - 1800_000).toISOString(),
  isPriority: false,
  isManual: false,
  addonServices: [],
  onlinePaidPaise: 500,
  dueAtPickupPaise: 0,
  status: "COMPLETED",
  printerUsed: "HP-LaserJet",
  fallbackPrinter: null,
  attemptCount: 1,
  failureHistory: [],
  purged: false,
};

describe("Admin OrderHistoryPage — Payment Method Display", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("displays Cash badge and Cash Paid for cash orders", async () => {
    const cashOrder: AdminOrderHistoryEntry = {
      ...baseEntry,
      orderId: "ord-cash-1",
      customerName: "Sunil Cash",
      paymentMethod: "CASH",
      onlinePaidPaise: 0,
      amountPaidPaise: 750,
      cashConfirmedAt: new Date(Date.now() - 1800_000).toISOString(),
    };

    getOrderHistory.mockResolvedValue({
      ok: true,
      data: {
        orders: [cashOrder],
        nextCursor: null,
      },
    });

    render(<OrderHistoryPage onSessionExpired={vi.fn()} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByText("💵 Cash · Paid ₹7.50")).toBeDefined();
    expect(screen.getByText("Cash Confirmed")).toBeDefined();
    expect(screen.queryByText("Payment Method")).toBeNull();
    expect(screen.queryByText("Online Paid")).toBeNull();
  });

  it("displays Paid badge for online orders", async () => {
    const onlineOrder: AdminOrderHistoryEntry = {
      ...baseEntry,
      orderId: "ord-online-1",
      customerName: "Ananya Online",
      paymentMethod: "ONLINE",
      onlinePaidPaise: 1200,
      amountPaidPaise: 1200,
      cashConfirmedAt: null,
    };

    getOrderHistory.mockResolvedValue({
      ok: true,
      data: {
        orders: [onlineOrder],
        nextCursor: null,
      },
    });

    render(<OrderHistoryPage onSessionExpired={vi.fn()} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByText("Paid ₹12")).toBeDefined();
    expect(screen.queryByText("Payment Method")).toBeNull();
    expect(screen.queryByText("Online Paid")).toBeNull();
  });

  it("displays Paid badge when paymentMethod is unknown", async () => {
    const unknownOrder: AdminOrderHistoryEntry = {
      ...baseEntry,
      orderId: "ord-unknown-1",
      customerName: "Legacy Order",
      paymentMethod: "UNKNOWN",
      onlinePaidPaise: 400,
      amountPaidPaise: 400,
      cashConfirmedAt: null,
    };

    getOrderHistory.mockResolvedValue({
      ok: true,
      data: {
        orders: [unknownOrder],
        nextCursor: null,
      },
    });

    render(<OrderHistoryPage onSessionExpired={vi.fn()} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByText("Paid ₹4")).toBeDefined();
    expect(screen.queryByText("Payment Method")).toBeNull();
    expect(screen.queryByText("Paid Amount")).toBeNull();
  });

  it("opens accessible deletion modal, allows canceling, and confirms permanent deletion", async () => {
    getOrderHistory.mockResolvedValue({
      ok: true,
      data: {
        orders: [baseEntry],
        nextCursor: null,
      },
    });
    deleteOrder.mockResolvedValue({
      ok: true,
      data: { orderId: baseEntry.orderId, deleted: true },
    });

    render(<OrderHistoryPage onSessionExpired={vi.fn()} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const deleteBtn = screen.getByRole("button", { name: "Delete" });
    expect(deleteBtn).toBeDefined();

    // Click delete -> opens modal dialog
    act(() => {
      deleteBtn.click();
    });

    expect(
      screen.getByRole("heading", { name: "Delete Order Permanently" }),
    ).toBeDefined();
    expect(
      screen.getByText(/Are you sure you want to permanently delete order/i),
    ).toBeDefined();

    // Clicking Cancel closes modal without deleting
    const cancelBtn = screen.getByRole("button", { name: "Cancel" });
    act(() => {
      cancelBtn.click();
    });
    expect(
      screen.queryByRole("heading", { name: "Delete Order Permanently" }),
    ).toBeNull();
    expect(deleteOrder).not.toHaveBeenCalled();

    // Open again and confirm
    act(() => {
      deleteBtn.click();
    });
    const confirmDeleteBtn = screen.getByRole("button", {
      name: "Delete Permanently",
    });
    act(() => {
      confirmDeleteBtn.click();
    });

    expect(deleteOrder).toHaveBeenCalledWith(baseEntry.orderId);
  });
});
