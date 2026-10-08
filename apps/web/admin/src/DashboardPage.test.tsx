// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DashboardPage } from "./DashboardPage";
const { getDashboard } = vi.hoisted(() => ({ getDashboard: vi.fn() }));
vi.mock("./api", () => ({
  adminApi: { getDashboard },
  brandingUrl: (x: string) => x,
  friendlyAdminError: () => "Unavailable",
  AdminApiError: class extends Error {
    status = 401;
  },
}));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});
it("uses one aggregate request, stops while hidden, and refreshes on focus", async () => {
  vi.useFakeTimers();
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: false,
  });
  getDashboard.mockResolvedValue({
    ok: true,
    data: {
      settings: {
        shopName: "Synthetic Shop",
        identificationSheetEnabled: true,
        onlinePrintingEnabled: false,
      },
      agents: [],
      defaultProductionPrinterId: null,
      todaysEarningsPaise: 155000,
      todaysOrders: 17,
      inQueue: 4,
      printingNow: 2,
      statusCounts: {
        waiting: 4,
        printing: 2,
        readyForPickup: 8,
        needsAttention: 1,
      },
    },
  });
  const view = render(
    <DashboardPage
      onSessionExpired={() => undefined}
      onNavigate={() => undefined}
    />,
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.getAllByText("Synthetic Shop").length).toBeGreaterThan(0);
  expect(screen.getByText("17")).toBeTruthy();
  expect(screen.getByText("₹1550.00")).toBeTruthy();
  expect(screen.getAllByText("4").length).toBe(2);
  expect(screen.getAllByText("2").length).toBe(2);
  expect(screen.getByText("8")).toBeTruthy();
  expect(screen.getByText("1")).toBeTruthy();
  expect(getDashboard).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(getDashboard).toHaveBeenCalledTimes(2);
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: true,
  });
  document.dispatchEvent(new Event("visibilitychange"));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15 * 3600_000);
  });
  expect(getDashboard).toHaveBeenCalledTimes(2);
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: false,
  });
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(getDashboard).toHaveBeenCalledTimes(3);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("renders red readiness banner when agent or printer is offline and only shop name as heading", async () => {
  getDashboard.mockResolvedValue({
    ok: true,
    data: {
      settings: {
        shopName: "My Shop",
        identificationSheetEnabled: true,
        onlinePrintingEnabled: true,
      },
      agents: [],
      defaultProductionPrinterId: null,
      todaysEarningsPaise: 155000,
      todaysOrders: 17,
      inQueue: 4,
      printingNow: 2,
      statusCounts: {
        waiting: 4,
        printing: 2,
        readyForPickup: 8,
        needsAttention: 1,
      },
    },
  });
  render(
    <DashboardPage
      onSessionExpired={() => undefined}
      onNavigate={() => undefined}
    />,
  );
  expect(await screen.findByRole("heading", { name: "My Shop" })).toBeTruthy();
  expect(screen.queryByText(/WORKSPACE READY/i)).toBeNull();
  expect(screen.queryByText(/Real-time shop operational overview/i)).toBeNull();
  expect(screen.queryByAltText("Shop logo")).toBeNull();

  expect(
    screen.getByRole("heading", {
      name: "⚠️ Online Printing Cannot Accept Payments Yet",
    }),
  ).toBeTruthy();
  expect(
    screen.getByText("The PrintGo Windows Agent is running on the shop PC."),
  ).toBeTruthy();
  expect(
    screen.getByText("The production printer is connected and working."),
  ).toBeTruthy();
});

it("renders green readiness banner when agent, printer, and online printing are active", async () => {
  getDashboard.mockResolvedValue({
    ok: true,
    data: {
      settings: {
        shopName: "Ready Shop",
        identificationSheetEnabled: true,
        onlinePrintingEnabled: true,
      },
      agents: [
        {
          id: "agent-1",
          displayName: "Shop PC",
          isOnline: true,
          isActive: true,
          lastHeartbeatAt: new Date().toISOString(),
          printers: [
            {
              id: "printer-1",
              displayName: "HP LaserJet",
              enabled: true,
              status: "ONLINE",
            },
          ],
        },
      ],
      defaultProductionPrinterId: "printer-1",
      todaysEarningsPaise: 155000,
      todaysOrders: 17,
      inQueue: 4,
      printingNow: 2,
      statusCounts: {
        waiting: 4,
        printing: 2,
        readyForPickup: 8,
        needsAttention: 1,
      },
    },
  });
  render(
    <DashboardPage
      onSessionExpired={() => undefined}
      onNavigate={() => undefined}
    />,
  );
  expect(
    await screen.findByRole("heading", {
      name: "✅ Your Website is Accepting Online Orders",
    }),
  ).toBeTruthy();
  expect(
    screen.getByText(
      "All systems ready! The PrintGo Windows Agent is running on the shop PC and your printer is connected and working.",
    ),
  ).toBeTruthy();
  expect(
    screen.queryByText("⚠️ Online Printing Cannot Accept Payments Yet"),
  ).toBeNull();
  expect(screen.getByText("TODAY'S ORDERS")).toBeTruthy();
  expect(screen.queryByText(/Shop Profile & Contact/i)).toBeNull();
  expect(screen.queryByText(/Print Rates & Surcharges/i)).toBeNull();
  expect(screen.getByText(/Connect Windows Counter PC/i)).toBeTruthy();
  expect(screen.getByText(/Choose Default Production Printer/i)).toBeTruthy();
  expect(screen.getByText(/Online Customer Orders/i)).toBeTruthy();
  expect(screen.getByText(/Identification sheet:/i)).toBeTruthy();
  expect(
    screen.getByRole("switch", { name: "Toggle Online Printing" }),
  ).toBeTruthy();
});
