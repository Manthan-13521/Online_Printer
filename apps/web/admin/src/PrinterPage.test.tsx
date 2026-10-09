// @vitest-environment jsdom

/* eslint-disable @typescript-eslint/unbound-method -- Vitest inspects method mocks without invoking them. */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { adminApi } from "./api";
import type * as ApiModule from "./api";
import { PrinterPage } from "./PrinterPage";
import type { AdminAgentDetails } from "@printgo/api-contract";

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return {
    ...actual,
    adminApi: {
      getPrinters: vi.fn(),
      createPairCode: vi.fn(),
      revokeAgent: vi.fn(),
      togglePrinter: vi.fn(),
      updatePrinter: vi.fn(),
      setDefaultPrinter: vi.fn(),
      checkPrinterHealth: vi.fn(),
      requestTestPrint: vi.fn(),
      getTestPrintStatus: vi.fn(),
    },
  };
});

const mockedApi = vi.mocked(adminApi);

const mockAgents: AdminAgentDetails[] = [
  {
    id: "agent_test_1",
    displayName: "Front Desk PC",
    isActive: true,
    isOnline: true,
    pairedAt: "2026-09-26T10:00:00.000Z",
    lastHeartbeatAt: new Date().toISOString(),
    printers: [
      {
        id: "printer_test_1",
        agentId: "agent_test_1",
        displayName: "HP LaserJet 400",
        windowsPrinterName: "HP_LaserJet_400",
        enabled: true,
        status: "ONLINE",
        statusReason: null,
        capabilities: {
          colour: false,
          duplex: true,
          paperSizes: ["A4", "LETTER"],
        },
        lastStatusAt: new Date().toISOString(),
        isProductionEligible: true,
        isVirtual: false,
        isProductionDefault: true,
      },
    ],
  },
];

describe("PrinterPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders empty state when no agents are connected", async () => {
    mockedApi.getPrinters.mockResolvedValueOnce({
      ok: true,
      data: { agents: [] },
    });

    render(<PrinterPage onSessionExpired={vi.fn()} />);

    expect(screen.getByText(/Loading printer configuration…/i)).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByText(/No PrintGo Agents Connected/i)).toBeTruthy();
    });
  });

  it("generates and displays pairing code", async () => {
    mockedApi.getPrinters.mockResolvedValueOnce({
      ok: true,
      data: { agents: [] },
    });
    mockedApi.createPairCode.mockResolvedValueOnce({
      ok: true,
      data: {
        pairCode: "7777-8888",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    });

    const user = userEvent.setup();
    render(<PrinterPage onSessionExpired={vi.fn()} />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Generate Pairing Code/i }),
      ).toBeTruthy();
    });

    await user.click(
      screen.getByRole("button", { name: /Generate Pairing Code/i }),
    );

    await waitFor(() => {
      expect(screen.getByText("7777-8888")).toBeTruthy();
      expect(screen.getByText(/Agent Pairing Code/i)).toBeTruthy();
    });
  });

  it("renders connected agents and printers", async () => {
    mockedApi.getPrinters.mockResolvedValueOnce({
      ok: true,
      data: { agents: mockAgents },
    });

    render(<PrinterPage onSessionExpired={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Front Desk PC")).toBeTruthy();
      expect(screen.getByText("HP LaserJet 400")).toBeTruthy();
      expect(screen.getAllByText(/Ready/i).length).toBeGreaterThanOrEqual(1);
      expect(screen.getByRole("button", { name: "Disable" })).toBeTruthy();
    });
  });

  it("toggles printer enabled status", async () => {
    mockedApi.getPrinters.mockResolvedValueOnce({
      ok: true,
      data: { agents: mockAgents },
    });
    mockedApi.togglePrinter.mockResolvedValueOnce({
      ok: true,
      data: { id: "printer_test_1", enabled: false },
    });

    const user = userEvent.setup();
    render(<PrinterPage onSessionExpired={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Disable" })).toBeTruthy();
    });

    await user.click(screen.getByRole("button", { name: "Disable" }));

    await waitFor(() => {
      expect(mockedApi.togglePrinter).toHaveBeenCalledWith(
        "printer_test_1",
        false,
      );
      expect(screen.getByRole("button", { name: "Enable" })).toBeTruthy();
    });
  });

  it("requires confirmation and revokes agent", async () => {
    mockedApi.getPrinters.mockResolvedValueOnce({
      ok: true,
      data: { agents: mockAgents },
    });
    mockedApi.revokeAgent.mockResolvedValueOnce({
      ok: true,
      data: { revoked: true },
    });
    mockedApi.getPrinters.mockResolvedValueOnce({
      ok: true,
      data: { agents: [] },
    });

    const user = userEvent.setup();
    render(<PrinterPage onSessionExpired={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Revoke Agent" })).toBeTruthy();
    });

    await user.click(screen.getByRole("button", { name: "Revoke Agent" }));

    expect(screen.getByText(/Confirm revoke\?/i)).toBeTruthy();
    const confirmButton = screen.getByRole("button", { name: "Yes, Revoke" });
    await user.click(confirmButton);

    await waitFor(() => {
      expect(mockedApi.revokeAgent).toHaveBeenCalledWith("agent_test_1");
    });
  });

  it("triggers test print and displays progression states", async () => {
    mockedApi.getPrinters.mockResolvedValueOnce({
      ok: true,
      data: { agents: mockAgents },
    });
    mockedApi.requestTestPrint.mockResolvedValueOnce({
      ok: true,
      data: {
        testPrint: {
          commandId: "cmd-test-1",
          printerId: "printer_test_1",
          agentId: "agent_test_1",
          status: "PENDING",
          spoolerJobId: null,
          failureCode: null,
          failureDetail: null,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
          claimedAt: null,
          finishedAt: null,
        },
      },
    });

    const user = userEvent.setup();
    render(<PrinterPage onSessionExpired={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Test Print" })).toBeTruthy();
    });

    await user.click(screen.getByRole("button", { name: "Test Print" }));

    await waitFor(() => {
      expect(mockedApi.requestTestPrint).toHaveBeenCalledWith("printer_test_1");
      expect(screen.getByText("Waiting for Agent…")).toBeTruthy();
    });
  });

  it("displays blocked state with reason and never claims failure", async () => {
    const agentsWithBlocked = [
      {
        ...mockAgents[0]!,
        printers: [
          {
            ...mockAgents[0]!.printers[0]!,
            latestTestPrint: {
              commandId: "cmd-test-2",
              printerId: "printer_test_1",
              agentId: "agent_test_1",
              status: "BLOCKED" as const,
              spoolerJobId: "spool-1",
              failureCode: "PAPER_OUT",
              failureDetail: "Paper tray is empty",
              createdAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 300_000).toISOString(),
              claimedAt: new Date().toISOString(),
              finishedAt: new Date().toISOString(),
            },
          },
        ],
      },
    ];

    mockedApi.getPrinters.mockResolvedValueOnce({
      ok: true,
      data: { agents: agentsWithBlocked },
    });

    render(<PrinterPage onSessionExpired={vi.fn()} />);

    await waitFor(() => {
      expect(
        screen.getByText(/Printer needs attention: Paper tray is empty/i),
      ).toBeTruthy();
      expect(
        screen.getByRole("button", { name: "Try Test Print Again" }),
      ).toBeTruthy();
    });
  });

  it("displays succeeded state when test print completed", async () => {
    const agentsWithSuccess = [
      {
        ...mockAgents[0]!,
        printers: [
          {
            ...mockAgents[0]!.printers[0]!,
            latestTestPrint: {
              commandId: "cmd-test-3",
              printerId: "printer_test_1",
              agentId: "agent_test_1",
              status: "SUCCEEDED" as const,
              spoolerJobId: "spool-2",
              failureCode: null,
              failureDetail: null,
              createdAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 300_000).toISOString(),
              claimedAt: new Date().toISOString(),
              finishedAt: new Date().toISOString(),
            },
          },
        ],
      },
    ];

    mockedApi.getPrinters.mockResolvedValueOnce({
      ok: true,
      data: { agents: agentsWithSuccess },
    });

    render(<PrinterPage onSessionExpired={vi.fn()} />);

    await waitFor(() => {
      expect(
        screen.getByText("Test page submitted successfully."),
      ).toBeTruthy();
      expect(
        screen.getByRole("button", { name: "Try Test Print Again" }),
      ).toBeTruthy();
    });
  });

  it("discovers and represents multiple physical printers (1, 2, 4, 8) with summary counts", async () => {
    const multiPrinters = [
      {
        id: "p1",
        agentId: "agent_test_1",
        displayName: "HP LaserJet Pro",
        windowsPrinterName: "HP_LaserJet_Pro",
        enabled: true,
        status: "ONLINE" as const,
        statusReason: null,
        capabilities: { colour: false, duplex: true, paperSizes: ["A4"] },
        lastStatusAt: new Date().toISOString(),
        isProductionEligible: true,
        isVirtual: false,
        isProductionDefault: true,
        priority: 10,
      },
      {
        id: "p2",
        agentId: "agent_test_1",
        displayName: "Canon LBP2900",
        windowsPrinterName: "Canon_LBP2900",
        enabled: true,
        status: "ONLINE" as const,
        statusReason: null,
        capabilities: { colour: false, duplex: false, paperSizes: ["A4"] },
        lastStatusAt: new Date().toISOString(),
        isProductionEligible: true,
        isVirtual: false,
        isProductionDefault: false,
        priority: 5,
      },
      {
        id: "p3",
        agentId: "agent_test_1",
        displayName: "Epson EcoTank Color",
        windowsPrinterName: "Epson_L3150",
        enabled: true,
        status: "ONLINE" as const,
        statusReason: null,
        capabilities: { colour: true, duplex: false, paperSizes: ["A4"] },
        lastStatusAt: new Date().toISOString(),
        isProductionEligible: true,
        isVirtual: false,
        isProductionDefault: false,
        priority: 0,
      },
      {
        id: "p4",
        agentId: "agent_test_1",
        displayName: "Brother HL-L2321D",
        windowsPrinterName: "Brother_HLL2321D",
        enabled: true,
        status: "BLOCKED" as const,
        statusReason: "Paper tray is empty",
        capabilities: { colour: false, duplex: true, paperSizes: ["A4"] },
        lastStatusAt: new Date().toISOString(),
        isProductionEligible: true,
        isVirtual: false,
        isProductionDefault: false,
        priority: 0,
      },
    ];

    mockedApi.getPrinters.mockResolvedValueOnce({
      ok: true,
      data: {
        agents: [
          {
            ...mockAgents[0]!,
            printers: multiPrinters,
          },
        ],
        defaultProductionPrinterId: "p1",
      },
    });

    render(<PrinterPage onSessionExpired={vi.fn()} />);

    await waitFor(() => {
      // Summary count: 3 ready · 1 needs attention · 4 printers
      expect(screen.getByText(/3 ready/i)).toBeTruthy();
      expect(screen.getByText(/1 needs attention/i)).toBeTruthy();
      expect(screen.getByText(/4 printers/i)).toBeTruthy();

      // All 4 printers displayed on their cards
      expect(screen.getByText("HP LaserJet Pro")).toBeTruthy();
      expect(screen.getByText("Canon LBP2900")).toBeTruthy();
      expect(screen.getByText("Epson EcoTank Color")).toBeTruthy();
      expect(screen.getByText("Brother HL-L2321D")).toBeTruthy();

      // Badges
      expect(screen.getByText("Default")).toBeTruthy();
      expect(screen.getByText("Priority 10")).toBeTruthy();
      expect(screen.getByText("Priority 5")).toBeTruthy();
    });
  });

  it("opens Add Printer modal and allows adding discovered unconfigured printers", async () => {
    const unconfiguredPrinter = {
      id: "p_new",
      agentId: "agent_test_1",
      displayName: "Newly Plugged Xerox",
      windowsPrinterName: "Xerox_B210",
      enabled: false,
      status: "ONLINE" as const,
      statusReason: null,
      capabilities: { colour: false, duplex: true, paperSizes: ["A4"] },
      lastStatusAt: new Date().toISOString(),
      isProductionEligible: true,
      isVirtual: false,
      isProductionDefault: false,
    };

    mockedApi.getPrinters.mockResolvedValueOnce({
      ok: true,
      data: {
        agents: [
          {
            ...mockAgents[0]!,
            printers: [mockAgents[0]!.printers[0]!, unconfiguredPrinter],
          },
        ],
      },
    });
    mockedApi.togglePrinter.mockResolvedValueOnce({
      ok: true,
      data: { id: "p_new", enabled: true },
    });

    const user = userEvent.setup();
    render(<PrinterPage onSessionExpired={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("HP LaserJet 400")).toBeTruthy();
    });

    // Click "+ Add Printer" in header
    const addPrinterBtn = screen.getByRole("button", {
      name: /\+ Add Printer/i,
    });
    fireEvent.click(addPrinterBtn);

    await waitFor(() => {
      expect(screen.getByText("Connect & Add Printer")).toBeTruthy();
    });

    // Check detected printer inside modal
    const modal = screen.getByRole("dialog");
    expect(within(modal).getByText("Newly Plugged Xerox")).toBeTruthy();

    // Click "+ Add Printer" inside modal
    const modalAddBtn = within(modal).getByRole("button", {
      name: "+ Add Printer",
    });
    await user.click(modalAddBtn);

    await waitFor(() => {
      expect(mockedApi.togglePrinter).toHaveBeenCalledWith("p_new", true);
    });
  });

  it("opens Settings modal and updates printer configuration including priority and name", async () => {
    mockedApi.getPrinters.mockResolvedValueOnce({
      ok: true,
      data: { agents: mockAgents },
    });
    mockedApi.updatePrinter.mockResolvedValueOnce({
      ok: true,
      data: {
        id: "printer_test_1",
        enabled: true,
        displayName: "Counter Main LaserJet",
        priority: 15,
        fallbackPrinterId: null,
        autoFallbackEnabled: false,
      },
    });
    mockedApi.getPrinters.mockResolvedValueOnce({
      ok: true,
      data: {
        agents: [
          {
            ...mockAgents[0]!,
            printers: [
              {
                ...mockAgents[0]!.printers[0]!,
                displayName: "Counter Main LaserJet",
                priority: 15,
              },
            ],
          },
        ],
      },
    });

    const user = userEvent.setup();
    render(<PrinterPage onSessionExpired={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Settings" })).toBeTruthy();
    });

    // Open settings modal
    await user.click(screen.getByRole("button", { name: "Settings" }));

    await waitFor(() => {
      expect(screen.getByText("Printer Settings")).toBeTruthy();
      expect(screen.getByLabelText(/Printer Name \(Friendly\):/i)).toBeTruthy();
      expect(screen.getByLabelText(/Routing Priority/i)).toBeTruthy();
    });

    // Edit friendly name and priority
    const nameInput = screen.getByLabelText(/Printer Name \(Friendly\):/i);
    await user.clear(nameInput);
    await user.type(nameInput, "Counter Main LaserJet");

    const priorityInput = screen.getByLabelText(/Routing Priority/i);
    await user.clear(priorityInput);
    await user.type(priorityInput, "15");

    // Click Save Settings
    await user.click(screen.getByRole("button", { name: "Save Settings" }));

    await waitFor(() => {
      expect(mockedApi.updatePrinter).toHaveBeenCalledWith("printer_test_1", {
        displayName: "Counter Main LaserJet",
        priority: 15,
        enabled: true,
        fallbackPrinterId: null,
        autoFallbackEnabled: false,
      });
    });
  });

  it("sets a printer as default production printer", async () => {
    const nonDefaultPrinter = {
      ...mockAgents[0]!.printers[0]!,
      id: "printer_non_default",
      displayName: "Secondary Canon",
      isProductionDefault: false,
    };

    mockedApi.getPrinters.mockResolvedValueOnce({
      ok: true,
      data: {
        agents: [
          {
            ...mockAgents[0]!,
            printers: [nonDefaultPrinter],
          },
        ],
        defaultProductionPrinterId: "other_printer",
      },
    });
    mockedApi.setDefaultPrinter.mockResolvedValueOnce({
      ok: true,
      data: {
        defaultPrinterId: "printer_non_default",
        windowsPrinterName: "Canon_MF4700",
      },
    });
    mockedApi.getPrinters.mockResolvedValueOnce({
      ok: true,
      data: {
        agents: [
          {
            ...mockAgents[0]!,
            printers: [{ ...nonDefaultPrinter, isProductionDefault: true }],
          },
        ],
        defaultProductionPrinterId: "printer_non_default",
      },
    });

    const user = userEvent.setup();
    render(<PrinterPage onSessionExpired={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Set Default" })).toBeTruthy();
    });

    await user.click(screen.getByRole("button", { name: "Set Default" }));

    await waitFor(() => {
      expect(mockedApi.setDefaultPrinter).toHaveBeenCalledWith(
        "printer_non_default",
      );
    });
  });
});
