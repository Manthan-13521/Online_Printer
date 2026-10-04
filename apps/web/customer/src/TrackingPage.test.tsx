// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CustomerTrackingData } from "@printgo/api-contract";

import { customerApi } from "./api";
import { TrackingPage } from "./TrackingPage";

vi.mock("./api", () => ({
  customerApi: { tracking: vi.fn() },
}));

const token = "T".repeat(43);
const tracking: CustomerTrackingData = {
  jobCode: "PG-ABC234",
  customerName: "Rahul",
  paymentStatus: "PAYMENT_RECEIVED",
  orderStatus: "WAITING_TO_PRINT",
  statusLabel: "Waiting to print",
  statusMessage: "Your paid print job is waiting for the shop printer.",
  submittedAt: "2026-09-26T00:00:00.000Z",
  paidAt: "2026-09-26T00:01:00.000Z",
  printSummary: {
    selectedPages: "1-12",
    copies: 2,
    paperSize: "A4",
    colorMode: "BW",
    sides: "DOUBLE",
  },
  amountPaidPaise: 4_200,
  currency: "INR",
  instructions: "Staple after printing",
  fileRetentionStatus: "TEMPORARILY_RETAINED",
  timeline: [
    {
      status: "PAYMENT_RECEIVED",
      label: "Payment received",
      occurredAt: "2026-09-26T00:01:00.000Z",
    },
    {
      status: "WAITING_TO_PRINT",
      label: "Waiting to print",
      occurredAt: "2026-09-26T00:01:00.001Z",
    },
  ],
  trackingExpiresAt: "2026-10-10T00:01:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/track/PG-ABC234");
  vi.mocked(customerApi.tracking).mockResolvedValue(tracking);
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("customer tracking page", () => {
  it("shows loading while the private status request is pending", () => {
    sessionStorage.setItem("printgo.tracking.PG-ABC234", token);
    vi.mocked(customerApi.tracking).mockImplementationOnce(
      () => new Promise(() => undefined),
    );
    render(<TrackingPage jobCode="PG-ABC234" />);
    expect(screen.getByText("Loading print status…")).toBeTruthy();
  });

  it("consumes the fragment, restores refresh access, and renders safe details", async () => {
    window.history.replaceState(null, "", `/track/PG-ABC234#${token}`);
    const { container } = render(<TrackingPage jobCode="PG-ABC234" />);
    expect(await screen.findByText(/Order PG-ABC234/i)).toBeTruthy();
    expect(window.location.hash).toBe("");
    expect(sessionStorage.getItem("printgo.tracking.PG-ABC234")).toBe(token);
    expect(customerApi.tracking).toHaveBeenCalledWith("PG-ABC234", token);
    expect(
      container.querySelector(".track-journey-root") ||
        container.querySelector("svg"),
    ).toBeTruthy();
    expect(screen.queryByText(/9876543210/u)).toBeNull();
  });

  it("uses sessionStorage after refresh", async () => {
    sessionStorage.setItem("printgo.tracking.PG-ABC234", token);
    render(<TrackingPage jobCode="PG-ABC234" />);
    expect(await screen.findByText(/Order PG-ABC234/i)).toBeTruthy();
    expect(customerApi.tracking).toHaveBeenCalledWith("PG-ABC234", token);
  });

  it("shows the same invalid or expired-link experience without a token", async () => {
    render(<TrackingPage jobCode="PG-ABC234" />);
    expect(await screen.findByText("Tracking link unavailable")).toBeTruthy();
    expect(customerApi.tracking).not.toHaveBeenCalled();
  });

  it("shows completed status after the PDF has been deleted", async () => {
    sessionStorage.setItem("printgo.tracking.PG-ABC234", token);
    vi.mocked(customerApi.tracking).mockResolvedValueOnce({
      ...tracking,
      orderStatus: "COMPLETED",
      statusLabel: "Completed",
      statusMessage: "Your print job is complete.",
      fileRetentionStatus: "DELETED",
    });
    render(<TrackingPage jobCode="PG-ABC234" />);
    expect(await screen.findByText("Ready for pickup")).toBeTruthy();
    expect(screen.getByText("Order code")).toBeTruthy();
    expect(screen.getByText("PG-ABC234")).toBeTruthy();
  });

  it("does not show ready while staff finishing is pending", async () => {
    sessionStorage.setItem("printgo.tracking.PG-ABC234", token);
    vi.mocked(customerApi.tracking).mockResolvedValueOnce({
      ...tracking,
      orderStatus: "FINISHING",
      statusLabel: "Finishing",
      statusMessage: "The shop is finishing your order.",
    });
    render(<TrackingPage jobCode="PG-ABC234" />);
    expect(await screen.findByText(/Order PG-ABC234/i)).toBeTruthy();
    expect(screen.getByText("The shop is finishing your order.")).toBeTruthy();
    expect(screen.queryByText("Ready for pickup")).toBeNull();
  });

  it("does not claim pickup readiness for a PRINTED order awaiting completion", async () => {
    sessionStorage.setItem("printgo.tracking.PG-ABC234", token);
    vi.mocked(customerApi.tracking).mockResolvedValueOnce({
      ...tracking,
      orderStatus: "PRINTED",
      statusLabel: "Printed",
      statusMessage: "Your document has been printed.",
    });
    render(<TrackingPage jobCode="PG-ABC234" />);
    expect(
      await screen.findByText("Your document has been printed."),
    ).toBeTruthy();
    expect(screen.queryByText("Ready for pickup")).toBeNull();
  });

  it("shows the backend printer issue instead of ordinary progress", async () => {
    sessionStorage.setItem("printgo.tracking.PG-ABC234", token);
    vi.mocked(customerApi.tracking).mockResolvedValueOnce({
      ...tracking,
      orderStatus: "PRINTER_NEEDS_ATTENTION",
      statusLabel: "Printer needs attention",
      statusMessage: "The shop is handling a printer issue.",
    });
    render(<TrackingPage jobCode="PG-ABC234" />);
    expect(await screen.findByText("Printer needs attention")).toBeTruthy();
    expect(
      screen.getByText("The shop is handling a printer issue."),
    ).toBeTruthy();
    expect(screen.queryByText("Ready for pickup")).toBeNull();
  });

  it("distinguishes a retryable network failure from an invalid link", async () => {
    sessionStorage.setItem("printgo.tracking.PG-ABC234", token);
    vi.mocked(customerApi.tracking).mockRejectedValueOnce(
      new Error("Failed to fetch"),
    );
    render(<TrackingPage jobCode="PG-ABC234" />);
    expect(await screen.findByText("Could not refresh status")).toBeTruthy();
    expect(screen.getByText(/Check your connection/iu)).toBeTruthy();
  });

  it("shows invalid or expired for a rejected private credential", async () => {
    sessionStorage.setItem("printgo.tracking.PG-ABC234", token);
    vi.mocked(customerApi.tracking).mockRejectedValueOnce(
      new Error("TRACKING_NOT_FOUND"),
    );
    render(<TrackingPage jobCode="PG-ABC234" />);
    await waitFor(() =>
      expect(screen.getByText("Tracking link unavailable")).toBeTruthy(),
    );
  });
});
