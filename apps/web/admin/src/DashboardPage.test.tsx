// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { DashboardPage } from "./DashboardPage";
const { getDashboard, updateSettings, getManualOrders, getCashOrders } =
  vi.hoisted(() => ({
    getDashboard: vi.fn(),
    updateSettings: vi.fn(),
    getManualOrders: vi.fn(),
    getCashOrders: vi.fn(),
  }));
vi.mock("./api", () => ({
  adminApi: { getDashboard, updateSettings, getManualOrders, getCashOrders },
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
  expect(screen.getByText("4")).toBeTruthy();
  expect(screen.getByText("2")).toBeTruthy();
  expect(getDashboard).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(35_000);
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
  expect(screen.getByText(/Identification sheet/i)).toBeTruthy();
  expect(
    screen.getByRole("switch", { name: "Toggle Online Printing" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("switch", { name: "Toggle Identification Sheet" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("switch", { name: "Toggle Accept Cash Orders" }),
  ).toBeTruthy();
});

it("renders compact Shop Controls with all 3 toggles and correct ON/OFF states", async () => {
  getDashboard.mockResolvedValue({
    ok: true,
    data: {
      settings: {
        shopName: "Controls Shop",
        identificationSheetEnabled: true,
        onlinePrintingEnabled: true,
        cashOrdersEnabled: false,
      },
      agents: [],
      defaultProductionPrinterId: null,
      todaysEarningsPaise: 0,
      todaysOrders: 0,
      inQueue: 0,
      printingNow: 0,
      statusCounts: {
        waiting: 0,
        printing: 0,
        readyForPickup: 0,
        needsAttention: 0,
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
    await screen.findByRole("heading", { name: "Shop Controls" }),
  ).toBeTruthy();

  const idSheetToggle = screen.getByRole<HTMLInputElement>("switch", {
    name: "Toggle Identification Sheet",
  });
  const onlineToggle = screen.getByRole<HTMLInputElement>("switch", {
    name: "Toggle Online Printing",
  });
  const cashToggle = screen.getByRole<HTMLInputElement>("switch", {
    name: "Toggle Accept Cash Orders",
  });

  expect(idSheetToggle.checked).toBe(true);
  expect(onlineToggle.checked).toBe(true);
  expect(cashToggle.checked).toBe(false);

  expect(screen.getByText("Identification Sheet")).toBeTruthy();
  expect(screen.getByText("Accept Online Orders")).toBeTruthy();
  expect(screen.getByText("Accept Cash Orders")).toBeTruthy();
});

it("toggles Identification Sheet and persists setting via adminApi.updateSettings", async () => {
  const initialSettings = {
    shopName: "Test Shop",
    identificationSheetEnabled: true,
    onlinePrintingEnabled: true,
    cashOrdersEnabled: true,
  };

  getDashboard.mockResolvedValue({
    ok: true,
    data: {
      settings: initialSettings,
      agents: [],
      defaultProductionPrinterId: null,
      todaysEarningsPaise: 0,
      todaysOrders: 0,
      inQueue: 0,
      printingNow: 0,
      statusCounts: {
        waiting: 0,
        printing: 0,
        readyForPickup: 0,
        needsAttention: 0,
      },
    },
  });

  updateSettings.mockResolvedValue({
    ok: true,
    data: {
      settings: {
        ...initialSettings,
        identificationSheetEnabled: false,
      },
    },
  });

  const user = userEvent.setup();
  render(
    <DashboardPage
      onSessionExpired={() => undefined}
      onNavigate={() => undefined}
    />,
  );

  const idSheetToggle = await screen.findByRole<HTMLInputElement>("switch", {
    name: "Toggle Identification Sheet",
  });
  expect(idSheetToggle.checked).toBe(true);

  await user.click(idSheetToggle);

  expect(updateSettings).toHaveBeenCalledWith(
    expect.objectContaining({
      identificationSheetEnabled: false,
    }),
  );
});

it("toggles Accept Cash Orders and persists setting via adminApi.updateSettings", async () => {
  const initialSettings = {
    shopName: "Test Shop",
    identificationSheetEnabled: true,
    onlinePrintingEnabled: true,
    cashOrdersEnabled: false,
  };

  getDashboard.mockResolvedValue({
    ok: true,
    data: {
      settings: initialSettings,
      agents: [],
      defaultProductionPrinterId: null,
      todaysEarningsPaise: 0,
      todaysOrders: 0,
      inQueue: 0,
      printingNow: 0,
      statusCounts: {
        waiting: 0,
        printing: 0,
        readyForPickup: 0,
        needsAttention: 0,
      },
    },
  });

  updateSettings.mockResolvedValue({
    ok: true,
    data: {
      settings: {
        ...initialSettings,
        cashOrdersEnabled: true,
      },
    },
  });

  const user = userEvent.setup();
  render(
    <DashboardPage
      onSessionExpired={() => undefined}
      onNavigate={() => undefined}
    />,
  );

  const cashToggle = await screen.findByRole<HTMLInputElement>("switch", {
    name: "Toggle Accept Cash Orders",
  });
  expect(cashToggle.checked).toBe(false);

  await user.click(cashToggle);

  expect(updateSettings).toHaveBeenCalledWith(
    expect.objectContaining({
      cashOrdersEnabled: true,
    }),
  );
});

it("confirms before pausing Online Printing and persists setting", async () => {
  const initialSettings = {
    shopName: "Test Shop",
    identificationSheetEnabled: true,
    onlinePrintingEnabled: true,
    cashOrdersEnabled: true,
  };

  getDashboard.mockResolvedValue({
    ok: true,
    data: {
      settings: initialSettings,
      agents: [],
      defaultProductionPrinterId: null,
      todaysEarningsPaise: 0,
      todaysOrders: 0,
      inQueue: 0,
      printingNow: 0,
      statusCounts: {
        waiting: 0,
        printing: 0,
        readyForPickup: 0,
        needsAttention: 0,
      },
    },
  });

  updateSettings.mockResolvedValue({
    ok: true,
    data: {
      settings: {
        ...initialSettings,
        onlinePrintingEnabled: false,
      },
    },
  });

  const user = userEvent.setup();
  render(
    <DashboardPage
      onSessionExpired={() => undefined}
      onNavigate={() => undefined}
    />,
  );

  const onlineToggle = await screen.findByRole<HTMLInputElement>("switch", {
    name: "Toggle Online Printing",
  });
  expect(onlineToggle.checked).toBe(true);

  // Clicking when online printing is on opens the confirm modal
  await user.click(onlineToggle);
  expect(
    await screen.findByRole("heading", {
      name: "Pause new online print orders?",
    }),
  ).toBeTruthy();

  // Click Pause Printing button in modal
  const pauseButton = screen.getByRole("button", { name: "Pause Printing" });
  await user.click(pauseButton);

  expect(updateSettings).toHaveBeenCalledWith(
    expect.objectContaining({
      onlinePrintingEnabled: false,
    }),
  );
});

it("renders Manual / Finishing Orders and Pending Cash Orders compact counters beside shop name and navigates on click", async () => {
  const onNavigate = vi.fn();
  getDashboard.mockResolvedValue({
    ok: true,
    data: {
      settings: {
        shopName: "PrintGo Central",
        identificationSheetEnabled: true,
        onlinePrintingEnabled: true,
      },
      agents: [],
      defaultProductionPrinterId: null,
      todaysEarningsPaise: 5100,
      todaysOrders: 5,
      inQueue: 1,
      printingNow: 0,
      statusCounts: {
        waiting: 1,
        printing: 0,
        readyForPickup: 3,
        needsAttention: 0,
      },
    },
  });

  getManualOrders.mockResolvedValue({
    ok: true,
    data: {
      orders: [
        { orderId: "man-1" },
        { orderId: "man-2" },
        { orderId: "man-3" },
      ],
      nextCursor: null,
    },
  });

  getCashOrders.mockResolvedValue({
    ok: true,
    data: {
      orders: [
        { orderId: "cash-1", cashGraceUntilMs: Date.now() + 60000 },
        { orderId: "cash-2", cashGraceUntilMs: Date.now() + 60000 },
      ],
    },
  });

  const user = userEvent.setup();
  render(
    <DashboardPage
      onSessionExpired={() => undefined}
      onNavigate={onNavigate}
    />,
  );

  const manualCounter = await screen.findByRole("button", {
    name: /manual or finishing orders: 3/i,
  });
  expect(manualCounter).toBeTruthy();
  expect(screen.getByText("Manual / Finishing Orders")).toBeTruthy();
  expect(screen.getByText("3")).toBeTruthy();

  const cashCounter = screen.getByRole("button", {
    name: /pending cash orders: 2/i,
  });
  expect(cashCounter).toBeTruthy();
  expect(screen.getByText("Pending Cash Orders")).toBeTruthy();
  expect(screen.getByText("2")).toBeTruthy();

  // Clicking counter navigates to /admin/manual-orders
  await user.click(manualCounter);
  expect(onNavigate).toHaveBeenCalledWith("/admin/manual-orders");

  await user.click(cashCounter);
  expect(onNavigate).toHaveBeenCalledWith("/admin/manual-orders");
});
