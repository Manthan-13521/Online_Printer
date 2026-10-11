// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AdminLiveOrder, QueueStallDetails } from "@printgo/api-contract";
import { LiveOrdersPage } from "./LiveOrdersPage";

const {
  getLiveOrders,
  recoverQueue,
  clearSpooler,
  manualCompleteOrder,
  deleteOrder,
  getOrderPdfUrl,
} = vi.hoisted(() => ({
  getLiveOrders: vi.fn(),
  recoverQueue: vi.fn(),
  clearSpooler: vi.fn(),
  manualCompleteOrder: vi.fn(),
  deleteOrder: vi.fn(),
  getOrderPdfUrl: vi.fn(),
}));

vi.mock("./api", () => ({
  adminApi: {
    getLiveOrders,
    recoverQueue,
    clearSpooler,
    manualCompleteOrder,
    deleteOrder,
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

const sampleOrder: AdminLiveOrder = {
  orderId: "ord-test-1",
  jobCode: "JOB-4242",
  customerName: "Alex Smith",
  customerPhone: "+919876543210",
  printSummary: {
    paperSize: "A4",
    colorMode: "BW",
    sides: "SINGLE",
    copies: 1,
    selectedPages: "1-3",
  },
  amountPaidPaise: 600,
  currency: "INR",
  status: "QUEUED",
  agentName: "Agent-01",
  printerName: "HP-LaserJet",
  issue: null,
  paidAt: new Date(Date.now() - 60_000).toISOString(),
  updatedAt: new Date(Date.now() - 60_000).toISOString(),
  pickupCode: "P-4242",
};

describe("Admin LiveOrdersPage — Compact Redesign", () => {
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

  it("renders All Clear badge and friendly empty state card when there are no active orders and no issues", async () => {
    getLiveOrders.mockResolvedValue({
      ok: true,
      data: {
        orders: [],
        stallDetails: null,
      },
    });

    render(<LiveOrdersPage onSessionExpired={vi.fn()} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // Heading and intro
    expect(
      screen.getByRole("heading", { level: 1, name: "Live Orders" }),
    ).toBeDefined();
    expect(
      screen.getByText("Paid orders and live printing activity"),
    ).toBeDefined();

    // Top-right status: All Clear
    expect(screen.getByText("All clear")).toBeDefined();
    expect(screen.getByText("No action needed")).toBeDefined();

    // Recovery controls must NOT be visible during normal all-clear state
    expect(
      screen.queryByRole("button", { name: /Print Recovery/i }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /Clear Queue/i })).toBeNull();

    // Empty state card
    expect(screen.getByText("No active orders")).toBeDefined();
    expect(
      screen.getByText("New paid orders will appear here automatically."),
    ).toBeDefined();
    expect(screen.getByText("✓")).toBeDefined();
  });

  it("renders active orders and All Clear badge when jobs exist without stalls or hardware errors", async () => {
    getLiveOrders.mockResolvedValue({
      ok: true,
      data: {
        orders: [sampleOrder],
        stallDetails: null,
      },
    });

    render(<LiveOrdersPage onSessionExpired={vi.fn()} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // All clear status
    expect(screen.getByText("All clear")).toBeDefined();
    expect(screen.getByText("No action needed")).toBeDefined();
    expect(
      screen.queryByRole("button", { name: /Print Recovery/i }),
    ).toBeNull();

    // Order card details
    expect(screen.getAllByText("P-4242").length).toBeGreaterThan(0);
    expect(screen.getByText("Alex Smith")).toBeDefined();
  });

  it("displays Needs Attention and reveals Print Recovery and Clear Queue buttons when queue stall is detected", async () => {
    const stall: QueueStallDetails = {
      isStalled: true,
      reason: "Printer offline or spooler stuck for 5m+",
      waitingCount: 2,
      activeCount: 1,
      needsReviewCount: 0,
    };

    getLiveOrders.mockResolvedValue({
      ok: true,
      data: {
        orders: [sampleOrder],
        stallDetails: stall,
      },
    });

    render(<LiveOrdersPage onSessionExpired={vi.fn()} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // Needs attention badge
    expect(screen.getByText(/1 needs attention/i)).toBeDefined();
    expect(screen.queryByText("All clear")).toBeNull();

    // Print Recovery and Clear Queue buttons are now revealed
    const recoveryBtn = screen.getByRole("button", { name: /Print Recovery/i });
    const clearBtn = screen.getByRole("button", { name: /Clear Queue/i });
    expect(recoveryBtn).toBeDefined();
    expect(clearBtn).toBeDefined();

    // Clicking Print Recovery opens confirmation dialog
    fireEvent.click(recoveryBtn);
    expect(screen.getByText(/Confirm Smart Print Recovery/i)).toBeDefined();

    // Cancelling closes the panel without executing recovery
    const cancelBtn = screen.getByRole("button", { name: "Cancel" });
    fireEvent.click(cancelBtn);
    expect(screen.queryByText(/Confirm Smart Print Recovery/i)).toBeNull();
    expect(recoverQueue).not.toHaveBeenCalled();

    // Opening again and executing recovery
    fireEvent.click(recoveryBtn);
    recoverQueue.mockResolvedValueOnce({
      ok: true,
      data: {
        recoveredOrdersCount: 1,
        resumedOrdersCount: 1,
        uncertainOrdersCount: 0,
        printerOnline: true,
        printerName: "HP-LaserJet",
        message: "Successfully recovered 1 order",
        details: ["Re-queued JOB-4242"],
      },
    });

    const executeBtn = screen.getByRole("button", {
      name: "Execute Print Recovery",
    });
    fireEvent.click(executeBtn);

    expect(recoverQueue).toHaveBeenCalledTimes(1);
  });

  it("displays Needs Attention and allows Selective Spooler Clear when hardware issue is detected", async () => {
    const stall: QueueStallDetails = {
      isStalled: false,
      printerIssue: "Paper tray empty",
      waitingCount: 1,
      activeCount: 0,
      needsReviewCount: 0,
    };

    getLiveOrders.mockResolvedValue({
      ok: true,
      data: {
        orders: [sampleOrder],
        stallDetails: stall,
      },
    });

    render(<LiveOrdersPage onSessionExpired={vi.fn()} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // Needs attention badge and printer issue alert
    expect(screen.getByText(/1 needs attention/i)).toBeDefined();
    expect(screen.getByText(/Paper tray empty/i)).toBeDefined();

    // Clear Queue button opens confirmation panel
    const clearBtn = screen.getByRole("button", { name: /Clear Queue/i });
    fireEvent.click(clearBtn);
    expect(screen.getByText(/Confirm Selective Spooler Clear/i)).toBeDefined();

    // Confirm Clear Spooler calls API
    clearSpooler.mockResolvedValueOnce({
      ok: true,
      data: {
        commandId: "cmd-clear-1",
        agentId: "agent-1",
        printerId: "printer-1",
        status: "PENDING",
        message: "Spooler clear command queued",
      },
    });

    const confirmClearBtn = screen.getByRole("button", {
      name: "Confirm Clear Spooler",
    });
    fireEvent.click(confirmClearBtn);

    expect(clearSpooler).toHaveBeenCalledTimes(1);
  });

  it("shows Needs Attention when an order has problem status like PRINT_FAILED or NEEDS_ADMIN", async () => {
    const failedOrder: AdminLiveOrder = {
      ...sampleOrder,
      orderId: "ord-failed-2",
      jobCode: "JOB-9999",
      status: "PRINT_FAILED",
      issue: "Ink cartridge dry",
    };

    getLiveOrders.mockResolvedValue({
      ok: true,
      data: {
        orders: [failedOrder],
        stallDetails: null,
      },
    });

    render(<LiveOrdersPage onSessionExpired={vi.fn()} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // Status area shows needs attention
    expect(screen.getByText(/1 needs attention/i)).toBeDefined();
    expect(
      screen.getByRole("button", { name: /Print Recovery/i }),
    ).toBeDefined();
  });
});
