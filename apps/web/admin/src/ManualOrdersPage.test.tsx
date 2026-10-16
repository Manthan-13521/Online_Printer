// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ManualOrdersPage } from "./ManualOrdersPage";
import { adminApi } from "./api";
import type * as ApiModule from "./api";

/* eslint-disable @typescript-eslint/unbound-method -- Vitest inspects API method mocks without invoking them. */

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return {
    ...actual,
    adminApi: {
      getCashOrders: vi.fn(),
      getManualOrders: vi.fn(),
      confirmCashPayment: vi.fn(),
      markOrderPrinted: vi.fn(),
      markOrderFinished: vi.fn(),
      setPickupCharge: vi.fn(),
      getOrderPdfUrl: vi.fn(),
    },
  };
});

const mockedApi = vi.mocked(adminApi);

describe("ManualOrdersPage Redesign", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(cleanup);

  it("renders empty states cleanly when there are no cash or manual orders", async () => {
    mockedApi.getCashOrders.mockResolvedValue({
      ok: true,
      data: { orders: [] },
    });
    mockedApi.getManualOrders.mockResolvedValue({
      ok: true,
      data: { orders: [], nextCursor: null },
    });

    render(<ManualOrdersPage onSessionExpired={vi.fn()} />);

    expect(
      await screen.findByRole("heading", { name: "Cash & Manual Orders" }),
    ).toBeTruthy();
    expect(screen.getByText("SHOP STAFF")).toBeTruthy();

    // Verify empty state headings
    expect(screen.getByText("No more pending cash orders!")).toBeTruthy();
    expect(screen.getByText("No manual or finishing orders")).toBeTruthy();
  });

  it("renders cash order on the right column without a Contact button and allows confirmation", async () => {
    const cashOrder = {
      orderId: "order-cash-1",
      publicJobCode: "CASH-842",
      payableAmountPaise: 100,
      customerName: "Manthan Jaiswal",
      customerPhone: "8125626011",
      status: "AWAITING_CASH",
      cashExpiresAtMs: Date.now() + 600_000,
      cashGraceUntilMs: Date.now() + 720_000,
      createdAtMs: Date.now(),
    };

    mockedApi.getCashOrders.mockResolvedValue({
      ok: true,
      data: { orders: [cashOrder] },
    });
    mockedApi.getManualOrders.mockResolvedValue({
      ok: true,
      data: { orders: [], nextCursor: null },
    });
    mockedApi.confirmCashPayment.mockResolvedValue({
      ok: true,
      data: {
        orderId: "order-cash-1",
        publicJobCode: "CASH-842",
        status: "QUEUED",
        confirmedAtMs: Date.now(),
      },
    });

    const user = userEvent.setup();
    render(<ManualOrdersPage onSessionExpired={vi.fn()} />);

    // Cash order rendered
    expect(await screen.findByText("CASH-842")).toBeTruthy();
    expect(screen.getByText("AWAITING CASH PAYMENT")).toBeTruthy();
    expect(screen.getByText("Manthan Jaiswal")).toBeTruthy();
    expect(screen.getByText("8125626011")).toBeTruthy();
    expect(screen.getByText("₹1.00")).toBeTruthy();

    // Verify avatar initials MJ
    expect(screen.getByText("MJ")).toBeTruthy();

    // Verify NO Contact button
    expect(screen.queryByRole("button", { name: /contact/i })).toBeNull();

    // Verify empty state is NOT rendered for cash orders when orders exist
    expect(screen.queryByText("No more pending cash orders!")).toBeNull();

    // Click Confirm Cash Received
    const confirmBtn = screen.getByRole("button", {
      name: /confirm cash received/i,
    });
    await user.click(confirmBtn);

    // Modal opens
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Confirm Cash Payment")).toBeTruthy();

    // Click confirm in dialog
    const modalConfirmBtn = screen.getByRole("button", {
      name: /yes, confirm cash/i,
    });
    await user.click(modalConfirmBtn);

    await waitFor(() => {
      expect(mockedApi.confirmCashPayment).toHaveBeenCalledWith("order-cash-1");
    });
  });

  it("renders manual order on the left column without the MJ avatar and allows marking finished", async () => {
    const manualOrder = {
      orderId: "order-manual-1",
      pickupCode: "PA-004",
      jobCode: "PG-004",
      customerName: "Manthan Jaiswal",
      customerPhone: "8125626011",
      status: "AWAITING_FINISHING" as const,
      isPriority: false,
      instructions: null,
      fileCount: 1,
      onlineAmountPaise: 100,
      dueAtPickupPaise: 0,
      currency: "INR" as const,
      paidAt: new Date().toISOString(),
      hasStaffPriced: false,
      hasPostPrint: true,
      paymentMethod: "ONLINE" as const,
      addonServices: [
        {
          serviceId: "svc-1",
          serviceName: "STAPPLE PLS",
          pricingType: "FIXED_PRICE" as const,
          onlinePricePaise: 0,
          handlingMode: "POST_PRINT" as const,
        },
      ],
    };

    mockedApi.getCashOrders.mockResolvedValue({
      ok: true,
      data: { orders: [] },
    });
    mockedApi.getManualOrders.mockResolvedValue({
      ok: true,
      data: { orders: [manualOrder], nextCursor: null },
    });
    mockedApi.markOrderFinished.mockResolvedValue({
      ok: true,
      data: {
        orderId: "order-manual-1",
        status: "COMPLETED",
      },
    });

    const user = userEvent.setup();
    render(<ManualOrdersPage onSessionExpired={vi.fn()} />);

    // Manual order rendered
    expect(await screen.findAllByText("PA-004")).toHaveLength(2);
    expect(screen.getByText("AWAITING FINISHING")).toBeTruthy();
    expect(screen.getByText(/STAPPLE PLS/i)).toBeTruthy();
    expect(screen.getByText("8125626011")).toBeTruthy();
    expect(screen.getByText("Manual finishing")).toBeTruthy();

    // Verify empty state is NOT rendered for manual orders when an order exists
    expect(screen.queryByText("No manual or finishing orders")).toBeNull();

    // Verify Download PDF button and Mark Finished button exist
    expect(screen.getByRole("button", { name: /download pdf/i })).toBeTruthy();
    const finishBtn = screen.getByRole("button", { name: /mark finished/i });
    expect(finishBtn).toBeTruthy();

    await user.click(finishBtn);
    await waitFor(() => {
      expect(mockedApi.markOrderFinished).toHaveBeenCalledWith(
        "order-manual-1",
      );
    });
  });

  it("header Refresh all button triggers reload of both cash and manual orders", async () => {
    mockedApi.getCashOrders.mockResolvedValue({
      ok: true,
      data: { orders: [] },
    });
    mockedApi.getManualOrders.mockResolvedValue({
      ok: true,
      data: { orders: [], nextCursor: null },
    });

    const user = userEvent.setup();
    render(<ManualOrdersPage onSessionExpired={vi.fn()} />);

    const refreshBtn = await screen.findByRole("button", {
      name: /refresh all/i,
    });
    expect(refreshBtn).toBeTruthy();

    await user.click(refreshBtn);

    await waitFor(() => {
      // Called on mount and on refresh
      expect(mockedApi.getCashOrders).toHaveBeenCalledTimes(2);
      expect(mockedApi.getManualOrders).toHaveBeenCalledTimes(2);
    });
  });
});
