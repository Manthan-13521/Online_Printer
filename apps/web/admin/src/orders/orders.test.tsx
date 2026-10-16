// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AdminCashOrder,
  AdminLiveOrder,
  AdminManualOrder,
} from "@printgo/api-contract";
import {
  CashEmptyState,
  CashOrderCard,
  LiveOrderRow,
  ManualEmptyState,
  ManualOrderCard,
  RelativeTimeBadge,
} from "./index";

const { markOrderPrinted, markOrderFinished, setPickupCharge, getOrderPdfUrl } =
  vi.hoisted(() => ({
    markOrderPrinted: vi.fn(),
    markOrderFinished: vi.fn(),
    setPickupCharge: vi.fn(),
    getOrderPdfUrl: vi.fn(),
  }));

vi.mock("../api", () => ({
  adminApi: {
    markOrderPrinted,
    markOrderFinished,
    setPickupCharge,
    getOrderPdfUrl,
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

describe("Admin Orders Components", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  describe("OrderEmptyStates", () => {
    it("renders CashEmptyState correctly", () => {
      render(<CashEmptyState />);
      expect(screen.getByText("No more pending cash orders!")).toBeTruthy();
      expect(
        screen.getByText(/All cash orders have been confirmed/i),
      ).toBeTruthy();
    });

    it("renders ManualEmptyState correctly", () => {
      render(<ManualEmptyState />);
      expect(screen.getByText("No manual or finishing orders")).toBeTruthy();
      expect(
        screen.getByText(
          /All manual and finishing orders have been completed/i,
        ),
      ).toBeTruthy();
    });

    it("renders RelativeTimeBadge correctly", () => {
      render(<RelativeTimeBadge lastRefreshedAt={Date.now()} />);
      expect(screen.getByText("Last updated just now")).toBeTruthy();
    });
  });

  describe("CashOrderCard", () => {
    const cashOrder: AdminCashOrder = {
      orderId: "ord-cash-100",
      publicJobCode: "CASH-789",
      customerName: "Rahul Sharma",
      customerPhone: "9876543210",
      payableAmountPaise: 2500,
      status: "AWAITING_CASH",
      cashExpiresAtMs: Date.now() + 600_000,
      cashGraceUntilMs: Date.now() + 720_000,
      createdAtMs: Date.now(),
    };

    it("renders cash order details and handles confirmation click", async () => {
      const handleConfirm = vi.fn();
      const user = userEvent.setup();

      render(<CashOrderCard order={cashOrder} onConfirm={handleConfirm} />);

      expect(screen.getByText("CASH-789")).toBeTruthy();
      expect(screen.getByText("AWAITING CASH PAYMENT")).toBeTruthy();
      expect(screen.getByText("Rahul Sharma")).toBeTruthy();
      expect(screen.getByText("9876543210")).toBeTruthy();
      expect(screen.getByText("₹25.00")).toBeTruthy();

      const confirmBtn = screen.getByRole("button", {
        name: /confirm cash received/i,
      });
      await user.click(confirmBtn);

      expect(handleConfirm).toHaveBeenCalledWith(cashOrder);
    });

    it("shows grace countdown when order is in grace window", () => {
      const graceOrder: AdminCashOrder = {
        ...cashOrder,
        cashExpiresAtMs: Date.now() - 10_000,
        cashGraceUntilMs: Date.now() + 60_000,
      };

      render(<CashOrderCard order={graceOrder} onConfirm={vi.fn()} />);

      expect(screen.getByText(/Grace:/i)).toBeTruthy();
    });
  });

  describe("ManualOrderCard", () => {
    const manualOrder: AdminManualOrder = {
      orderId: "ord-man-200",
      jobCode: "MAN-200",
      pickupCode: "P-200",
      customerName: "Priya Patel",
      customerPhone: "9123456789",
      onlineAmountPaise: 3500,
      dueAtPickupPaise: 0,
      paymentMethod: "ONLINE",
      status: "MANUAL_PRINT",
      currency: "INR",
      paidAt: new Date().toISOString(),
      hasStaffPriced: false,
      hasPostPrint: true,
      instructions: "Spiral bind on left margin",
      addonServices: [
        {
          serviceId: "srv-spiral",
          serviceName: "Spiral Binding",
          pricingType: "FIXED_PRICE",
          onlinePricePaise: 500,
          handlingMode: "POST_PRINT",
        },
      ],
      fileCount: 1,
    };

    it("renders manual order details and handles mark printed", async () => {
      markOrderPrinted.mockResolvedValue({
        ok: true,
        data: { status: "COMPLETED" },
      });
      const handleAction = vi.fn();
      const user = userEvent.setup();

      render(
        <ManualOrderCard
          order={manualOrder}
          onAction={handleAction}
          onSessionExpired={vi.fn()}
        />,
      );

      expect(screen.getAllByText("P-200").length).toBeGreaterThan(0);
      expect(screen.getByText("MANUAL PRINTING")).toBeTruthy();
      expect(screen.getByText("Priya Patel")).toBeTruthy();
      expect(screen.getByText("9123456789")).toBeTruthy();
      expect(screen.getByText(/Spiral Binding/i)).toBeTruthy();
      expect(screen.getByText(/Spiral bind on left margin/i)).toBeTruthy();

      const markPrintedBtn = screen.getByRole("button", {
        name: /mark printed/i,
      });
      await user.click(markPrintedBtn);

      expect(markOrderPrinted).toHaveBeenCalledWith("ord-man-200");
      expect(handleAction).toHaveBeenCalled();
    });

    it("renders mark finished for AWAITING_FINISHING status", async () => {
      markOrderFinished.mockResolvedValue({
        ok: true,
        data: { status: "COMPLETED" },
      });
      const finishingOrder: AdminManualOrder = {
        ...manualOrder,
        status: "AWAITING_FINISHING",
      };
      const handleAction = vi.fn();
      const handleFinished = vi.fn();
      const user = userEvent.setup();

      render(
        <ManualOrderCard
          order={finishingOrder}
          onAction={handleAction}
          onFinished={handleFinished}
          onSessionExpired={vi.fn()}
        />,
      );

      expect(screen.getByText("AWAITING FINISHING")).toBeTruthy();

      const markFinishedBtn = screen.getByRole("button", {
        name: /mark finished/i,
      });
      await user.click(markFinishedBtn);

      expect(markOrderFinished).toHaveBeenCalledWith("ord-man-200");
      expect(handleFinished).toHaveBeenCalledWith("ord-man-200");
      expect(handleAction).toHaveBeenCalled();
    });
  });

  describe("LiveOrderRow", () => {
    const liveOrder: AdminLiveOrder = {
      orderId: "ord-live-300",
      jobCode: "LIVE-300",
      pickupCode: "P-300",
      customerName: "Amit Kumar",
      customerPhone: "9988776655",
      printSummary: {
        paperSize: "A4",
        colorMode: "COLOR",
        sides: "DOUBLE",
        copies: 2,
        selectedPages: "1-10",
      },
      amountPaidPaise: 4000,
      currency: "INR",
      status: "QUEUED",
      paymentMethod: "ONLINE",
      agentName: "Agent-01",
      printerName: "Canon-iR",
      issue: null,
      paidAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    it("renders live order row details and delegates action callbacks", () => {
      const handleDownloadPdf = vi.fn();
      const handleDeleteOrder = vi.fn();

      render(
        <LiveOrderRow
          order={liveOrder}
          actionBusyId={null}
          confirmRetryId={null}
          onDownloadPdf={handleDownloadPdf}
          onManualComplete={vi.fn()}
          onRetry={vi.fn()}
          onSetConfirmRetryId={vi.fn()}
          onConvertSingleSided={vi.fn()}
          onDeleteOrder={handleDeleteOrder}
        />,
      );

      expect(screen.getAllByText("P-300").length).toBeGreaterThan(0);
      expect(screen.getByText("Amit Kumar")).toBeTruthy();
      expect(screen.getByText(/A4 · Colour · Duplex · 2 copies/i)).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: /download pdf/i }));
      expect(handleDownloadPdf).toHaveBeenCalledWith(liveOrder);

      fireEvent.click(screen.getByRole("button", { name: /delete order/i }));
      expect(handleDeleteOrder).toHaveBeenCalledWith(liveOrder);
    });
  });
});
