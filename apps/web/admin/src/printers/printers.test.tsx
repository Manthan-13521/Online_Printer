// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AdminAgentDetails,
  AdminPrinterDetails,
} from "@printgo/api-contract";
import {
  AddPrinterModal,
  AgentPairingBanner,
  PrinterCard,
  PrinterSettingsModal,
  PrinterVerificationModal,
  TestPrintModal,
  formatSimpleCapabilities,
  friendlyPrinterMessage,
  isVirtualPrinter,
} from "./index";

describe("Printer Helpers & Components", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  describe("printer-helpers", () => {
    it("formatSimpleCapabilities formats color, paper, and duplex", () => {
      expect(
        formatSimpleCapabilities({
          colour: true,
          duplex: true,
          paperSizes: ["A4", "A3"],
        }),
      ).toBe("Color • A4 • Duplex (Driver Detected)");

      expect(
        formatSimpleCapabilities({
          colour: false,
          duplex: false,
          paperSizes: ["Letter"],
        }),
      ).toBe("B&W • Letter • 1-sided (Driver Detected)");

      expect(formatSimpleCapabilities(null)).toBe("B&W • A4 (Unverified)");
    });

    it("friendlyPrinterMessage returns user-friendly explanations", () => {
      expect(friendlyPrinterMessage("PAPER_OUT", null)).toBe(
        "Printer is out of paper. Please add paper.",
      );
      expect(friendlyPrinterMessage("PAPER_JAM", null)).toBe(
        "Paper jam detected. Please check the paper path.",
      );
      expect(
        friendlyPrinterMessage(null, "Paper tray is empty on Tray 1"),
      ).toBe("Paper tray is empty. Please load paper.");
      expect(friendlyPrinterMessage(null, "Custom driver warning")).toBe(
        "Custom driver warning",
      );
      expect(friendlyPrinterMessage("UNKNOWN_CODE", null)).toBe(
        "Printer reported an issue.",
      );
    });

    it("isVirtualPrinter detects software and virtual print queues", () => {
      expect(
        isVirtualPrinter({
          id: "p-virt",
          displayName: "Microsoft Print to PDF",
          windowsPrinterName: "Microsoft Print to PDF",
          isVirtual: false,
        } as AdminPrinterDetails),
      ).toBe(true);

      expect(
        isVirtualPrinter({
          id: "p-flagged",
          displayName: "Virtual Queue",
          windowsPrinterName: "Queue",
          isVirtual: true,
        } as AdminPrinterDetails),
      ).toBe(true);

      expect(
        isVirtualPrinter({
          id: "p-real",
          displayName: "Brother HL-L2321D",
          windowsPrinterName: "Brother HL-L2321D series",
          isVirtual: false,
        } as AdminPrinterDetails),
      ).toBe(false);
    });
  });

  describe("AgentPairingBanner", () => {
    it("renders pairing code and triggers copy actions", () => {
      const handleCopyCode = vi.fn();
      const handleCopyLink = vi.fn();
      const handleDismiss = vi.fn();

      render(
        <AgentPairingBanner
          pairCode="ABCD-1234"
          pairExpiresAt={new Date().toISOString()}
          connectionLink="printgo://connect?code=ABCD-1234"
          copiedCode={false}
          copiedLink={false}
          onDismiss={handleDismiss}
          onCopyPairCode={handleCopyCode}
          onCopyConnectionLink={handleCopyLink}
        />,
      );

      expect(screen.getByText("ABCD-1234")).toBeTruthy();
      expect(screen.getByText("Agent Pairing Code")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: /copy code/i }));
      expect(handleCopyCode).toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: /copy full link/i }));
      expect(handleCopyLink).toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
      expect(handleDismiss).toHaveBeenCalled();
    });
  });

  describe("AddPrinterModal", () => {
    const unconfigured: AdminPrinterDetails = {
      id: "unconf-1",
      displayName: "HP DeskJet 2300",
      windowsPrinterName: "HP DeskJet 2300 series",
      enabled: false,
      capabilities: { colour: true, duplex: false, paperSizes: ["A4"] },
    } as unknown as AdminPrinterDetails;

    it("renders detected printers and scan action", async () => {
      const handleToggle = vi.fn();
      const handleScan = vi.fn();
      const handleClose = vi.fn();
      const user = userEvent.setup();

      render(
        <AddPrinterModal
          isOpen={true}
          unconfiguredPrinters={[unconfigured]}
          togglingPrinterId={null}
          refreshing={false}
          onClose={handleClose}
          onTogglePrinter={handleToggle}
          onScanPrinters={handleScan}
        />,
      );

      expect(screen.getByText("Connect & Add Printer")).toBeTruthy();
      expect(screen.getByText("HP DeskJet 2300")).toBeTruthy();

      await user.click(screen.getByRole("button", { name: /\+ add printer/i }));
      expect(handleToggle).toHaveBeenCalledWith(unconfigured);

      await user.click(
        screen.getByRole("button", { name: /scan for new printers/i }),
      );
      expect(handleScan).toHaveBeenCalled();

      await user.click(screen.getByRole("button", { name: /done/i }));
      expect(handleClose).toHaveBeenCalled();
    });
  });

  describe("TestPrintModal", () => {
    const printer: AdminPrinterDetails = {
      id: "pr-1",
      displayName: "Canon ImageRunner",
    } as AdminPrinterDetails;

    it("renders options and triggers test print callback", async () => {
      const handleRequest = vi.fn();
      const user = userEvent.setup();

      render(
        <TestPrintModal
          printer={printer}
          testPrinterFeatures={{
            color: true,
            duplex: true,
            a4: true,
            a3: false,
          }}
          onClose={vi.fn()}
          onRequestTestPrint={handleRequest}
        />,
      );

      expect(
        screen.getByText(/Select Test Print for Canon ImageRunner/i),
      ).toBeTruthy();

      await user.click(screen.getByText(/Standard Test/i));
      expect(handleRequest).toHaveBeenCalledWith(printer, "STANDARD");

      await user.click(screen.getByText(/Color Calibration Test/i));
      expect(handleRequest).toHaveBeenCalledWith(printer, "COLOR");
    });
  });

  describe("PrinterCard", () => {
    const samplePrinter: AdminPrinterDetails = {
      id: "pr-card-1",
      displayName: "Epson EcoTank L3150",
      windowsPrinterName: "EPSON L3150 Series",
      enabled: true,
      status: "ONLINE",
      capabilities: { colour: true, duplex: false, paperSizes: ["A4"] },
      isProductionDefault: true,
    } as unknown as AdminPrinterDetails;

    it("renders printer card information and delegates action callbacks", () => {
      const handleOpenSettings = vi.fn();
      const handleOpenTestPrint = vi.fn();
      const handleToggle = vi.fn();

      render(
        <PrinterCard
          printer={samplePrinter}
          isDefault={true}
          isAgentOnline={true}
          activeAgent={
            { id: "ag-1", isOnline: true } as unknown as AdminAgentDetails
          }
          testPrint={null}
          isTesting={false}
          togglingPrinterId={null}
          settingDefaultId={null}
          checkingHealthId={null}
          requestingTestPrintId={null}
          displayedPrinters={[samplePrinter]}
          onOpenTestPrintMenu={vi.fn()}
          onOpenSettings={handleOpenSettings}
          onOpenVerification={vi.fn()}
          onRequestTestPrint={handleOpenTestPrint}
          onTogglePrinter={handleToggle}
          onSetDefault={vi.fn()}
          onCheckHealth={vi.fn()}
        />,
      );

      expect(screen.getByText("Epson EcoTank L3150")).toBeTruthy();
      expect(screen.getByText("Default")).toBeTruthy();
      expect(screen.getByText("Ready")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Settings" }));
      expect(handleOpenSettings).toHaveBeenCalledWith(samplePrinter);

      fireEvent.click(screen.getByRole("button", { name: "Test Print" }));
      expect(handleOpenTestPrint).toHaveBeenCalledWith(
        samplePrinter,
        "STANDARD",
      );

      fireEvent.click(screen.getByRole("button", { name: "Disable" }));
      expect(handleToggle).toHaveBeenCalledWith(samplePrinter);
    });

    it("displays Problem alert box and Check Again button when printer status is UNKNOWN", () => {
      const handleCheckHealth = vi.fn();
      const unknownPrinter: AdminPrinterDetails = {
        ...samplePrinter,
        status: "UNKNOWN",
        statusReason: "Printer readiness is not reported by Windows",
      };

      render(
        <PrinterCard
          printer={unknownPrinter}
          isDefault={true}
          isAgentOnline={true}
          activeAgent={
            { id: "ag-1", isOnline: true } as unknown as AdminAgentDetails
          }
          testPrint={null}
          isTesting={false}
          togglingPrinterId={null}
          settingDefaultId={null}
          checkingHealthId={null}
          requestingTestPrintId={null}
          displayedPrinters={[unknownPrinter]}
          onOpenTestPrintMenu={vi.fn()}
          onOpenSettings={vi.fn()}
          onOpenVerification={vi.fn()}
          onRequestTestPrint={vi.fn()}
          onTogglePrinter={vi.fn()}
          onSetDefault={vi.fn()}
          onCheckHealth={handleCheckHealth}
        />,
      );

      expect(screen.getByText("Problem:")).toBeTruthy();
      expect(
        screen.getByText(/Windows has not reported printer readiness/i),
      ).toBeTruthy();

      const checkAgainBtn = screen.getByRole("button", { name: "Check Again" });
      expect(checkAgainBtn).toBeTruthy();
      fireEvent.click(checkAgainBtn);
      expect(handleCheckHealth).toHaveBeenCalledWith(unknownPrinter.id);
    });
  });

  describe("PrinterSettingsModal", () => {
    const testPrinter = {
      id: "pr-sett-1",
      displayName: "HP LaserJet Pro",
      windowsPrinterName: "HP LaserJet Pro MFP",
      enabled: true,
      capabilities: { colour: false, duplex: true, paperSizes: ["A4"] },
    } as unknown as AdminPrinterDetails;

    it("renders when printer is provided and handles actions", () => {
      const handleClose = vi.fn();
      const handleSave = vi.fn();

      render(
        <PrinterSettingsModal
          printer={testPrinter}
          defaultProductionPrinterId={null}
          displayedPrinters={[testPrinter]}
          formDisplayName="HP LaserJet Pro"
          setFormDisplayName={vi.fn()}
          formPriority={0}
          setFormPriority={vi.fn()}
          formEnabled={true}
          setFormEnabled={vi.fn()}
          formFallbackId=""
          setFormFallbackId={vi.fn()}
          formAutoFallback={false}
          setFormAutoFallback={vi.fn()}
          formEnabledServices={null}
          setFormEnabledServices={vi.fn()}
          formPhysicalDeviceId=""
          setFormPhysicalDeviceId={vi.fn()}
          settingDefaultId={null}
          savingSettings={false}
          onClose={handleClose}
          onSetDefault={vi.fn()}
          onSaveSettings={handleSave}
        />,
      );

      expect(
        screen.getByRole("dialog", { name: /printer settings/i }),
      ).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: /save settings/i }));
      expect(handleSave).toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
      expect(handleClose).toHaveBeenCalled();
    });
  });

  describe("PrinterVerificationModal", () => {
    const testPrinter = {
      id: "pr-ver-1",
      displayName: "Canon ImageRunner",
      windowsPrinterName: "Canon iR2006",
      enabled: true,
      capabilities: { colour: false, duplex: false, paperSizes: ["A4", "A3"] },
    } as unknown as AdminPrinterDetails;

    it("renders verification modal and handles actions", () => {
      const handleClose = vi.fn();
      const handleSave = vi.fn();

      render(
        <PrinterVerificationModal
          printer={testPrinter}
          verifyingFeatures={{
            bw: true,
            color: false,
            duplex: false,
            a4: true,
            a3: false,
          }}
          setVerifyingFeatures={vi.fn()}
          verifyingEnabled={{
            bw: true,
            color: false,
            duplex: false,
            a4: true,
            a3: false,
          }}
          setVerifyingEnabled={vi.fn()}
          verificationNotes=""
          setVerificationNotes={vi.fn()}
          savingVerification={false}
          onClose={handleClose}
          onSaveVerification={handleSave}
        />,
      );

      expect(
        screen.getByRole("dialog", { name: /certify hardware capabilities/i }),
      ).toBeTruthy();
      fireEvent.click(
        screen.getByRole("button", { name: /certify & save capabilities/i }),
      );
      expect(handleSave).toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
      expect(handleClose).toHaveBeenCalled();
    });
  });
});
