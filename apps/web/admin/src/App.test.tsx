// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { adminApi, AdminApiError } from "./api";
import type * as ApiModule from "./api";

/* eslint-disable @typescript-eslint/unbound-method -- Vitest inspects API method mocks without invoking them. */
import type {
  AdminPricingConfiguration,
  ShopSettings,
} from "@printgo/api-contract";
import {
  FILE_SIZE_10_MIB,
  FILE_SIZE_SERVICE_CHARGE_BANDS,
} from "@printgo/domain";

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return {
    ...actual,
    adminApi: {
      login: vi.fn(),
      me: vi.fn(),
      logout: vi.fn(),
      revokeAllSessions: vi.fn(),
      changePassword: vi.fn(),
      getSettings: vi.fn(),
      updateSettings: vi.fn(),
      getPricing: vi.fn(),
      updatePricing: vi.fn(),
      getLiveOrders: vi.fn(),
      getOrderHistory: vi.fn(),
      getDashboard: vi.fn(),
    },
  };
});

const mockedApi = vi.mocked(adminApi);
const admin = {
  id: "10000000-0000-4000-8000-000000000001",
  loginIdentifier: "admin",
};

const settings: ShopSettings = {
  shopName: "ABC Xerox",
  contactPhone: "+91 98765 43210",
  address: "Main Road",
  customerNotice: "Collect before 8 PM.",
  onlinePrintingEnabled: true,
  maxPdfSizeBytes: FILE_SIZE_10_MIB,
  identificationSheetEnabled: true,
  identificationSheetPlacement: "FIRST",
};

const pricing: AdminPricingConfiguration = {
  maxPdfSizeBytes: FILE_SIZE_10_MIB,
  printRates: (["A4", "A3"] as const).flatMap((paperSize) =>
    (["BW", "COLOR"] as const).flatMap((colorMode) =>
      (["SINGLE", "DOUBLE"] as const).map((sides) => ({
        paperSize,
        colorMode,
        sides,
        pricePerPagePaise: 200,
        enabled: true,
      })),
    ),
  ),
  fileSizeServiceCharges: FILE_SIZE_SERVICE_CHARGE_BANDS.map((band) => ({
    ...band,
    chargePaise: 100,
  })),
};

describe("Admin application", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/admin");
    vi.resetAllMocks();
    mockedApi.getDashboard.mockResolvedValue({
      ok: true,
      data: {
        settings,
        agents: [],
        defaultProductionPrinterId: null,
        queue: 0,
        attention: 0,
        completedToday: 0,
      },
    });
  });

  afterEach(cleanup);

  it("shows the accessible login form only after auth restoration completes", async () => {
    let rejectMe: ((reason: unknown) => void) | undefined;
    mockedApi.me.mockReturnValue(
      new Promise((_, reject) => {
        rejectMe = reject;
      }),
    );
    render(<App />);
    expect(screen.getByText("Opening PrintGo…")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Sign in" })).toBeNull();
    rejectMe?.(new AdminApiError("AUTH_SESSION_REQUIRED", 401, "expired"));
    expect(
      await screen.findByRole("heading", { name: "Sign in" }),
    ).toBeTruthy();
    expect(screen.getByLabelText("Login")).toBeTruthy();
    expect(screen.getByLabelText("Password")).toBeTruthy();
  });

  it("signs in and exposes the complete accessible navigation without fake data", async () => {
    mockedApi.me.mockRejectedValue(
      new AdminApiError("AUTH_SESSION_REQUIRED", 401, "expired"),
    );
    mockedApi.login.mockResolvedValue({ ok: true, data: { admin } });
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByLabelText("Login"), "admin");
    await user.type(screen.getByLabelText("Password"), "correct password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(
      await screen.findByRole("navigation", { name: "Admin navigation" }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Live Orders" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Security" })).toBeTruthy();
    expect(
      await screen.findByRole("heading", { name: "ABC Xerox" }),
    ).toBeTruthy();
    expect(screen.queryByText(/revenue|37 orders/iu)).toBeNull();
  });

  it("logs out from the shell and returns to login with feedback", async () => {
    mockedApi.me.mockResolvedValue({ ok: true, data: { admin } });
    mockedApi.logout.mockResolvedValue({
      ok: true,
      data: { message: "You have been signed out." },
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(
      await screen.findByRole("heading", { name: "Sign in" }),
    ).toBeTruthy();
    expect(screen.getByText("You have been signed out.")).toBeTruthy();
  });

  it("handles an expired session during password change", async () => {
    window.history.replaceState({}, "", "/admin/security");
    mockedApi.me.mockResolvedValue({ ok: true, data: { admin } });
    mockedApi.changePassword.mockRejectedValue(
      new AdminApiError(
        "AUTH_SESSION_EXPIRED",
        401,
        "Your session has expired. Please sign in again.",
      ),
    );
    const user = userEvent.setup();
    render(<App />);
    await user.type(
      await screen.findByLabelText("Current password"),
      "current password",
    );
    await user.type(
      screen.getByLabelText("New password"),
      "new secure password",
    );
    await user.type(
      screen.getByLabelText("Confirm new password"),
      "new secure password",
    );
    await user.click(screen.getByRole("button", { name: "Change password" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Sign in" })).toBeTruthy(),
    );
    expect(
      screen.getByText("Your session has expired. Please sign in again."),
    ).toBeTruthy();
  });

  it("loads and explicitly saves shop settings", async () => {
    window.history.replaceState({}, "", "/admin/shop-settings");
    mockedApi.me.mockResolvedValue({ ok: true, data: { admin } });
    mockedApi.getSettings.mockResolvedValue({ ok: true, data: { settings } });
    mockedApi.updateSettings.mockImplementation((input) =>
      Promise.resolve({
        ok: true,
        data: { settings: input, message: "Shop settings saved." },
      }),
    );
    const user = userEvent.setup();
    render(<App />);

    const name = await screen.findByLabelText("Shop name *");
    await user.clear(name);
    await user.type(name, "City Prints");
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() =>
      expect(mockedApi.updateSettings).toHaveBeenCalledWith({
        ...settings,
        shopName: "City Prints",
      }),
    );
    expect(await screen.findByText("Shop settings saved.")).toBeTruthy();
  });

  it("loads paginated order history without requesting PDFs", async () => {
    window.history.replaceState({}, "", "/admin/order-history");
    mockedApi.me.mockResolvedValue({ ok: true, data: { admin } });
    mockedApi.getOrderHistory
      .mockResolvedValueOnce({
        ok: true,
        data: {
          orders: [
            {
              orderId: "order-1",
              pickupCode: "PA-123",
              createdAt: "2026-10-01T10:00:00.000Z",
              completedAt: "2026-10-01T11:00:00.000Z",
              isPriority: true,
              isManual: false,
              addonServices: [
                {
                  name: "Binding",
                  onlinePricePaise: 500,
                  handlingMode: "POST_PRINT",
                },
              ],
              onlinePaidPaise: 1200,
              dueAtPickupPaise: 300,
              status: "COMPLETED",
              printerUsed: "Backup Printer",
              fallbackPrinter: "Backup Printer",
              attemptCount: 2,
              failureHistory: [
                { status: "UNCERTAIN", code: "UNKNOWN", at: null },
              ],
              purged: false,
            },
          ],
          nextCursor: "1000:00000000-0000-4000-8000-000000000001",
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: { orders: [], nextCursor: null },
      });
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByText("Pickup PA-123")).toBeTruthy();
    expect(screen.getByText("Binding")).toBeTruthy();
    expect(screen.getAllByText("Backup Printer")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() =>
      expect(mockedApi.getOrderHistory).toHaveBeenLastCalledWith(
        "1000:00000000-0000-4000-8000-000000000001",
      ),
    );
    expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
  });

  it("shows real live orders without a retry control", async () => {
    window.history.replaceState({}, "", "/admin/live-orders");
    mockedApi.me.mockResolvedValue({ ok: true, data: { admin } });
    mockedApi.getLiveOrders.mockResolvedValue({
      ok: true,
      data: {
        orders: [
          {
            orderId: "order-1",
            jobCode: "PG-ABC234",
            customerName: "Asha",
            customerPhone: "+91 98765 43210",
            printSummary: {
              selectedPages: "1-2",
              copies: 2,
              paperSize: "A4",
              colorMode: "BW",
              sides: "SINGLE",
            },
            amountPaidPaise: 5000,
            currency: "INR",
            status: "PRINT_BLOCKED",
            agentName: "Front PC",
            printerName: "Canon",
            issue: "Paper out",
            paidAt: new Date(1_000).toISOString(),
            updatedAt: new Date(2_000).toISOString(),
          },
        ],
      },
    });
    render(<App />);
    expect(
      await screen.findByRole("heading", { name: "Live Orders" }),
    ).toBeTruthy();
    expect(await screen.findByText("PG-ABC234")).toBeTruthy();
    expect(screen.getByText("Paper out", { exact: false })).toBeTruthy();
    expect(screen.getByRole("button", { name: /retry/iu })).toBeTruthy();
  });

  it("requires confirmation before pausing new online printing", async () => {
    window.history.replaceState({}, "", "/admin/shop-settings");
    mockedApi.me.mockResolvedValue({ ok: true, data: { admin } });
    mockedApi.getSettings.mockResolvedValue({ ok: true, data: { settings } });
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await screen.findByRole("switch", { name: "Accept online printing" }),
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(
      screen.getByText(
        "New customers will not be able to upload or pay. Existing paid jobs will continue.",
      ),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Pause Printing" }));
    expect(
      screen.getByRole<HTMLInputElement>("switch", {
        name: "Accept online printing",
      }).checked,
    ).toBe(false);
    expect(mockedApi.updateSettings).not.toHaveBeenCalled();
  });

  it("keeps a customer notice as text instead of rendering markup", async () => {
    window.history.replaceState({}, "", "/admin/shop-settings");
    mockedApi.me.mockResolvedValue({ ok: true, data: { admin } });
    mockedApi.getSettings.mockResolvedValue({
      ok: true,
      data: {
        settings: {
          ...settings,
          customerNotice: "<img src=x onerror=alert(1)>",
        },
      },
    });
    render(<App />);
    const notice = await screen.findByLabelText("Customer notice");
    expect((notice as HTMLTextAreaElement).value).toBe(
      "<img src=x onerror=alert(1)>",
    );
    expect(document.querySelector("img")).toBeNull();
  });

  it("loads, edits, and saves rupee-denominated pricing", async () => {
    window.history.replaceState({}, "", "/admin/pricing");
    mockedApi.me.mockResolvedValue({ ok: true, data: { admin } });
    mockedApi.getPricing.mockResolvedValue({ ok: true, data: { pricing } });
    mockedApi.updatePricing.mockImplementation((input) =>
      Promise.resolve({
        ok: true,
        data: {
          pricing: { ...pricing, ...input },
          message: "Pricing saved.",
        },
      }),
    );
    const user = userEvent.setup();
    render(<App />);

    const input = await screen.findByLabelText(
      "A4 Black & White Single-sided price",
    );
    await user.clear(input);
    await user.type(input, "3.25");
    await user.click(screen.getByRole("button", { name: "Save Pricing" }));
    await waitFor(() =>
      expect(mockedApi.updatePricing).toHaveBeenCalledTimes(1),
    );
    expect(
      mockedApi.updatePricing.mock.calls[0]?.[0].printRates[0]
        ?.pricePerPagePaise,
    ).toBe(325);
    expect(await screen.findByText("Pricing saved.")).toBeTruthy();
  });

  it("rejects invalid rupee input before calling the API", async () => {
    window.history.replaceState({}, "", "/admin/pricing");
    mockedApi.me.mockResolvedValue({ ok: true, data: { admin } });
    mockedApi.getPricing.mockResolvedValue({ ok: true, data: { pricing } });
    const user = userEvent.setup();
    render(<App />);

    const input = await screen.findByLabelText(
      "A4 Black & White Single-sided price",
    );
    await user.clear(input);
    await user.type(input, "1.234");
    await user.click(screen.getByRole("button", { name: "Save Pricing" }));
    expect(
      await screen.findByText(
        "Enter prices in rupees with no more than two decimal places.",
      ),
    ).toBeTruthy();
    expect(mockedApi.updatePricing).not.toHaveBeenCalled();
  });

  it("shows a useful retry state when settings cannot be loaded", async () => {
    window.history.replaceState({}, "", "/admin/shop-settings");
    mockedApi.me.mockResolvedValue({ ok: true, data: { admin } });
    mockedApi.getSettings.mockRejectedValue(
      new AdminApiError(
        "NETWORK_ERROR",
        0,
        "We couldn't connect to PrintGo. Check your internet connection and try again.",
      ),
    );
    render(<App />);

    expect(
      await screen.findByText(
        "We couldn't connect to PrintGo. Check your internet connection and try again.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});
