// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { customerApi } from "./api";
import { App } from "./App";
import { TrackingPage } from "./TrackingPage";

vi.mock("./api", () => ({
  customerApi: {
    config: vi.fn(),
    createDraft: vi.fn(),
    authorize: vi.fn(),
    complete: vi.fn(),
    quote: vi.fn(),
    createPayment: vi.fn(),
    verifyPayment: vi.fn(),
    cancelPayment: vi.fn(),
    tracking: vi.fn(),
  },
  uploadDirectly: vi.fn(),
}));

const mockConfig = {
  shopName: "PrintGo Test",
  contactPhone: "9876543210",
  customerNotice: null,
  onlinePrintingEnabled: true,
  maxPdfSizeBytes: 25 * 1024 * 1024,
  availablePrintOptions: [
    {
      paperSize: "A4" as const,
      colorMode: "BW" as const,
      sides: "SINGLE" as const,
    },
  ],
};

describe("Customer App Request Budget & Polling Optimization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
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

  it("calls config exactly ONCE on boot and generates ZERO network calls while typing", async () => {
    vi.mocked(customerApi.config).mockResolvedValue(mockConfig);

    render(<App />);

    // Wait for config to load and form to render
    const nameInput = await screen.findByLabelText("Name");
    expect(customerApi.config).toHaveBeenCalledTimes(1);
    const phoneInput = screen.getByLabelText("Phone");
    const instructionsInput = screen.getByLabelText(/instructions/i);

    fireEvent.change(nameInput, { target: { value: "A" } });
    fireEvent.change(nameInput, { target: { value: "Alice" } });
    fireEvent.change(phoneInput, { target: { value: "9876543210" } });
    fireEvent.change(instructionsInput, { target: { value: "Staple please" } });

    // Verify ZERO additional network requests while typing
    expect(customerApi.config).toHaveBeenCalledTimes(1);
    expect(customerApi.createDraft).not.toHaveBeenCalled();
    expect(customerApi.quote).not.toHaveBeenCalled();
    expect(customerApi.createPayment).not.toHaveBeenCalled();
  });

  it("stops tracking polling completely once a terminal status is reached", async () => {
    vi.useFakeTimers();
    sessionStorage.setItem("printgo.tracking.PG-JOB123", "a".repeat(43));

    const baseTracking = {
      jobCode: "PG-JOB123",
      customerName: "Alice",
      paymentStatus: "PAYMENT_RECEIVED" as const,
      orderStatus: "PRINTING" as const,
      statusLabel: "Printing",
      statusMessage: "Your document is currently being printed.",
      submittedAt: "2026-09-26T00:00:00.000Z",
      paidAt: "2026-09-26T00:01:00.000Z",
      amountPaidPaise: 400,
      currency: "INR" as const,
      instructions: null,
      fileRetentionStatus: "TEMPORARILY_RETAINED" as const,
      printSummary: {
        selectedPages: "1-2",
        copies: 1,
        paperSize: "A4" as const,
        colorMode: "BW" as const,
        sides: "SINGLE" as const,
      },
      timeline: [],
      trackingExpiresAt: "2026-10-10T00:00:00.000Z",
    };

    vi.mocked(customerApi.tracking)
      .mockResolvedValueOnce(baseTracking)
      .mockResolvedValueOnce({
        ...baseTracking,
        orderStatus: "PRINTED",
        statusLabel: "Printed",
        statusMessage: "Your document has been printed.",
        fileRetentionStatus: "DELETION_PENDING",
      });

    render(<TrackingPage jobCode="PG-JOB123" />);

    // Initial tracking fetch
    await vi.advanceTimersByTimeAsync(0);
    expect(customerApi.tracking).toHaveBeenCalledTimes(1);

    // Advance 15 seconds: second poll returns terminal status PRINTED
    await vi.advanceTimersByTimeAsync(15_000);
    expect(customerApi.tracking).toHaveBeenCalledTimes(2);

    // Advance another 60 seconds: ZERO subsequent polling calls!
    await vi.advanceTimersByTimeAsync(60_000);
    expect(customerApi.tracking).toHaveBeenCalledTimes(2);
  });
  it("terminal tracking stays idle after visibility resumes", async () => {
    vi.useFakeTimers();
    sessionStorage.setItem("printgo.tracking.PG-JOB123", "a".repeat(43));
    vi.mocked(customerApi.tracking).mockResolvedValue({
      jobCode: "PG-JOB123",
      customerName: "Synthetic",
      paymentStatus: "PAYMENT_RECEIVED",
      orderStatus: "PRINTED",
      statusLabel: "Printed",
      statusMessage: "Printed",
      submittedAt: "2026-09-26T00:00:00.000Z",
      paidAt: "2026-09-26T00:01:00.000Z",
      amountPaidPaise: 100,
      currency: "INR",
      instructions: null,
      fileRetentionStatus: "DELETION_PENDING",
      printSummary: {
        selectedPages: "1",
        copies: 1,
        paperSize: "A4",
        colorMode: "BW",
        sides: "SINGLE",
      },
      timeline: [],
      trackingExpiresAt: "2026-10-10T00:00:00.000Z",
    });
    render(<TrackingPage jobCode="PG-JOB123" />);
    await vi.advanceTimersByTimeAsync(0);
    expect(customerApi.tracking).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    // Currently receives a second call: effect closure still sees data=null.
    expect(customerApi.tracking).toHaveBeenCalledTimes(1);
  });
});
