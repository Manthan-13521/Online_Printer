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
      queue: 4,
      attention: 2,
      completedToday: 17,
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
      queue: 0,
      attention: 0,
      completedToday: 0,
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
      queue: 0,
      attention: 0,
      completedToday: 0,
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
});
