// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AdminPickupOrder } from "@printgo/api-contract";
import { PickupOrdersPage } from "./PickupOrdersPage";

const {
  getPickupOrders,
  setPickupAutoPrint,
  printPickupOrder,
  markPickupCollected,
  retryPickupOrder,
} = vi.hoisted(() => ({
  getPickupOrders: vi.fn(),
  setPickupAutoPrint: vi.fn(),
  printPickupOrder: vi.fn(),
  markPickupCollected: vi.fn(),
  retryPickupOrder: vi.fn(),
}));

vi.mock("./api", () => ({
  adminApi: {
    getPickupOrders,
    setPickupAutoPrint,
    printPickupOrder,
    markPickupCollected,
    retryPickupOrder,
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

const samplePickupOrder: AdminPickupOrder = {
  orderId: "ord-pickup-1",
  jobCode: "JOB-1001",
  pickupCode: "PA-001",
  customerName: "Rohan Sharma",
  customerPhone: "+919876543210",
  originalFilename: "thesis_final.pdf",
  fileCount: 1,
  totalAmountPaise: 5100,
  paymentMethod: "ONLINE",
  paymentStatus: "PAID",
  status: "QUEUED",
  isPickup: true,
  pickupTargetTime: "2026-10-21T07:00:00.000Z",
  pickupFormatted: "21 Oct, from 7:00 AM",
  pickupManualPrintRequested: false,
  pickupCollectedAt: null,
  createdAt: "2026-10-20T20:30:00.000Z",
  paidAt: "2026-10-20T20:31:00.000Z",
  printedAt: null,
  instructions: "Please staple in top left corner",
  files: [
    {
      id: "f-1",
      position: 1,
      originalFilename: "thesis_final.pdf",
      sizeBytes: 1048576,
      pageCount: 15,
      copies: 1,
      colorMode: "BW",
      paperSize: "A4",
      sides: "DOUBLE",
      selectedPages: "1-15",
      printStatus: "QUEUED",
    },
  ],
};

describe("PickupOrdersPage", () => {
  const onSessionExpired = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders empty state when there are no pickup orders", async () => {
    getPickupOrders.mockResolvedValueOnce({
      ok: true,
      data: { orders: [], autoPrintEnabled: false, nextCursor: null },
    });

    render(<PickupOrdersPage onSessionExpired={onSessionExpired} />);

    await waitFor(() => {
      expect(screen.getByText("No Pickup Orders")).toBeDefined();
    });
    expect(screen.getByText("Print automatically")).toBeDefined();
  });

  it("renders pickup order cards with details and allows manual Print Now", async () => {
    getPickupOrders.mockResolvedValueOnce({
      ok: true,
      data: {
        orders: [samplePickupOrder],
        autoPrintEnabled: false,
        nextCursor: null,
      },
    });
    printPickupOrder.mockResolvedValueOnce({
      ok: true,
      data: { orderId: "ord-pickup-1", status: "QUEUED" },
    });
    getPickupOrders.mockResolvedValueOnce({
      ok: true,
      data: {
        orders: [{ ...samplePickupOrder, pickupManualPrintRequested: true }],
        autoPrintEnabled: false,
        nextCursor: null,
      },
    });

    render(<PickupOrdersPage onSessionExpired={onSessionExpired} />);

    await waitFor(() => {
      expect(screen.getByText("#PA-001")).toBeDefined();
      expect(screen.getByText("Rohan Sharma")).toBeDefined();
      expect(screen.getByText(/Paid ₹51\.00/)).toBeDefined();
      expect(screen.getByText(/21 Oct, from 7:00 AM/)).toBeDefined();
      expect(screen.getByText("Awaiting Print")).toBeDefined();
    });

    const printNowButton = screen.getByRole("button", { name: "Print Now" });
    act(() => {
      fireEvent.click(printNowButton);
    });

    expect(printPickupOrder).toHaveBeenCalledWith("ord-pickup-1");
  });

  it("toggles Print Automatically and updates backend setting", async () => {
    getPickupOrders.mockResolvedValueOnce({
      ok: true,
      data: { orders: [], autoPrintEnabled: false, nextCursor: null },
    });
    setPickupAutoPrint.mockResolvedValueOnce({
      ok: true,
      data: { autoPrintEnabled: true },
    });

    render(<PickupOrdersPage onSessionExpired={onSessionExpired} />);

    await waitFor(() => {
      expect(
        screen.getByRole("switch", { name: "Print automatically" }),
      ).toBeDefined();
    });

    const toggle = screen.getByRole("switch", { name: "Print automatically" });
    expect((toggle as HTMLInputElement).checked).toBe(false);

    act(() => {
      fireEvent.click(toggle);
    });

    expect(setPickupAutoPrint).toHaveBeenCalledWith(true);
    expect((toggle as HTMLInputElement).checked).toBe(true);
  });

  it("shows Mark as Collected button for PRINTED orders and calls API", async () => {
    const printedOrder: AdminPickupOrder = {
      ...samplePickupOrder,
      status: "PRINTED",
      printedAt: "2026-10-21T07:05:00.000Z",
    };

    getPickupOrders.mockResolvedValueOnce({
      ok: true,
      data: {
        orders: [printedOrder],
        autoPrintEnabled: true,
        nextCursor: null,
      },
    });
    markPickupCollected.mockResolvedValueOnce({
      ok: true,
      data: { orderId: "ord-pickup-1", status: "COMPLETED" },
    });
    getPickupOrders.mockResolvedValueOnce({
      ok: true,
      data: { orders: [], autoPrintEnabled: true, nextCursor: null },
    });

    render(<PickupOrdersPage onSessionExpired={onSessionExpired} />);

    await waitFor(() => {
      expect(screen.getByText("Printed · Ready for Pickup")).toBeDefined();
    });

    const markBtn = screen.getByRole("button", { name: "Mark as Collected" });
    act(() => {
      fireEvent.click(markBtn);
    });

    expect(markPickupCollected).toHaveBeenCalledWith("ord-pickup-1");
  });

  it("shows Retry button for PRINT_FAILED orders", async () => {
    const failedOrder: AdminPickupOrder = {
      ...samplePickupOrder,
      status: "PRINT_FAILED",
    };

    getPickupOrders.mockResolvedValueOnce({
      ok: true,
      data: {
        orders: [failedOrder],
        autoPrintEnabled: false,
        nextCursor: null,
      },
    });
    retryPickupOrder.mockResolvedValueOnce({
      ok: true,
      data: { orderId: "ord-pickup-1", status: "QUEUED" },
    });
    getPickupOrders.mockResolvedValueOnce({
      ok: true,
      data: {
        orders: [{ ...samplePickupOrder, status: "QUEUED" }],
        autoPrintEnabled: false,
        nextCursor: null,
      },
    });

    render(<PickupOrdersPage onSessionExpired={onSessionExpired} />);

    await waitFor(() => {
      expect(screen.getByText("Print Failed")).toBeDefined();
    });

    const retryBtn = screen.getByRole("button", { name: "Retry" });
    act(() => {
      fireEvent.click(retryBtn);
    });

    expect(retryPickupOrder).toHaveBeenCalledWith("ord-pickup-1");
  });
});
