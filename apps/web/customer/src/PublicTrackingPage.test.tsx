// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PublicOrderTrackingData } from "@printgo/api-contract";

import { customerApi } from "./api";
import { PublicTrackingPage } from "./PublicTrackingPage";

vi.mock("./api", () => ({
  customerApi: { trackPublic: vi.fn() },
}));

const tracking: PublicOrderTrackingData = {
  pickupCode: "PA-001",
  status: "FINISHING",
  statusLabel: "Finishing",
  statusMessage: "The shop is finishing your order.",
  isPriority: false,
  totalFiles: 1,
  completedFiles: 1,
  identificationRequired: false,
  createdAt: "2026-10-04T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(customerApi.trackPublic).mockResolvedValue(tracking);
});

afterEach(cleanup);

describe("public tracking page", () => {
  it("keeps finishing distinct from ready", async () => {
    render(<PublicTrackingPage pickupCode="PA-001" />);
    expect(await screen.findByText("PrintGo V2")).toBeTruthy();
    expect(screen.getByText("The shop is finishing your order.")).toBeTruthy();
    expect(screen.getByText("Pickup code PA-001")).toBeTruthy();
    expect(screen.queryByText("Ready for pickup")).toBeNull();
  });

  it("shows the real pickup code only after the backend says ready", async () => {
    vi.mocked(customerApi.trackPublic).mockResolvedValueOnce({
      ...tracking,
      status: "READY_FOR_PICKUP",
      statusLabel: "Ready for Pickup",
      statusMessage: "Your order is ready for pickup at the counter.",
    });
    render(<PublicTrackingPage pickupCode="PA-001" />);
    expect(await screen.findByText("Ready for pickup")).toBeTruthy();
    expect(screen.getByText("Pickup code")).toBeTruthy();
    expect(screen.getByText("PA-001")).toBeTruthy();
  });

  it("shows a printer issue without progress toward ready", async () => {
    vi.mocked(customerApi.trackPublic).mockResolvedValueOnce({
      ...tracking,
      status: "PRINTER_ISSUE",
      statusLabel: "Printer Issue",
      statusMessage: "The shop is attending to the printer.",
    });
    render(<PublicTrackingPage pickupCode="PA-001" />);
    expect(await screen.findByText("Printer Issue")).toBeTruthy();
    expect(
      screen.getByText("The shop is attending to the printer."),
    ).toBeTruthy();
    expect(screen.queryByText("Ready for pickup")).toBeNull();
  });
});
