// @vitest-environment jsdom

/* eslint-disable @typescript-eslint/unbound-method -- Vitest inspects method mocks without invoking them. */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
      expect(screen.getAllByText("ONLINE").length).toBeGreaterThanOrEqual(1);
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
});
