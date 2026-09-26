import { describe, expect, it, vi } from "vitest";

import {
  DevelopmentPrinterAdapter,
  WindowsPrinterAdapter,
  createDefaultPrinterAdapter,
} from "./windows-printer-adapter";

describe("WindowsPrinterAdapter with mock executor", () => {
  it("parses Win32_Printer output into PrinterSummary list", async () => {
    const mockExecutor = vi.fn(() =>
      Promise.resolve(
        JSON.stringify([
          {
            Name: "Canon LBP2900",
            Default: true,
            WorkOffline: false,
            PrinterStatus: 3,
          },
          {
            Name: "HP LaserJet 1020",
            Default: false,
            WorkOffline: true,
            PrinterStatus: 7,
          },
        ]),
      ),
    );

    const adapter = new WindowsPrinterAdapter(mockExecutor);
    const printers = await adapter.listPrinters();

    expect(printers).toHaveLength(2);
    expect(printers[0]).toEqual({
      id: "Canon LBP2900",
      displayName: "Canon LBP2900",
      isDefault: true,
    });
    expect(printers[1]).toEqual({
      id: "HP LaserJet 1020",
      displayName: "HP LaserJet 1020",
      isDefault: false,
    });
  });

  it("detects OFFLINE and BLOCKED printer statuses accurately", async () => {
    // Test Offline
    const offlineExecutor = vi.fn(() =>
      Promise.resolve(
        JSON.stringify({
          Name: "Offline Printer",
          WorkOffline: true,
          PrinterStatus: 7,
        }),
      ),
    );
    const offlineAdapter = new WindowsPrinterAdapter(offlineExecutor);
    const offlineStatus = await offlineAdapter.getStatus("Offline Printer");
    expect(offlineStatus.availability).toBe("OFFLINE");

    // Test Paper Jam (DetectedErrorState = 8)
    const jamExecutor = vi.fn(() =>
      Promise.resolve(
        JSON.stringify({
          Name: "Jammed Printer",
          WorkOffline: false,
          DetectedErrorState: 8,
        }),
      ),
    );
    const jamAdapter = new WindowsPrinterAdapter(jamExecutor);
    const jamStatus = await jamAdapter.getStatus("Jammed Printer");
    expect(jamStatus.availability).toBe("BLOCKED");
    expect(jamStatus.message).toBe("Paper Jam");

    // Test Door Open (DetectedErrorState = 7)
    const doorExecutor = vi.fn(() =>
      Promise.resolve(
        JSON.stringify({
          Name: "Open Door Printer",
          WorkOffline: false,
          DetectedErrorState: 7,
        }),
      ),
    );
    const doorAdapter = new WindowsPrinterAdapter(doorExecutor);
    const doorStatus = await doorAdapter.getStatus("Open Door Printer");
    expect(doorStatus.availability).toBe("BLOCKED");
    expect(doorStatus.message).toBe("Door or Cover Open");

    // Test Idle/Ready Online (PrinterStatus = 3)
    const onlineExecutor = vi.fn(() =>
      Promise.resolve(
        JSON.stringify({
          Name: "Ready Printer",
          WorkOffline: false,
          PrinterStatus: 3,
          DetectedErrorState: 2,
        }),
      ),
    );
    const onlineAdapter = new WindowsPrinterAdapter(onlineExecutor);
    const onlineStatus = await onlineAdapter.getStatus("Ready Printer");
    expect(onlineStatus.availability).toBe("ONLINE");
  });

  it("parses capabilities from Win32_Printer descriptions", async () => {
    const mockExecutor = vi.fn(() =>
      Promise.resolve(
        JSON.stringify({
          Name: "Color Duplex Printer",
          CapabilityDescriptions: ["Color Printing", "Duplex", "Two-Sided"],
        }),
      ),
    );

    const adapter = new WindowsPrinterAdapter(mockExecutor);
    const caps = await adapter.getCapabilities("Color Duplex Printer");

    expect(caps.colour).toBe(true);
    expect(caps.duplex).toBe(true);
    expect(caps.paperSizes).toContain("A4");
  });

  it("submits a PDF job and returns captured spool job ID", async () => {
    let capturedScript = "";
    const mockExecutor = vi.fn((script: string) => {
      capturedScript = script;
      return Promise.resolve("42");
    });
    const adapter = new WindowsPrinterAdapter(mockExecutor);

    const result = await adapter.submitPdfJob({
      printerId: "Canon MF4700",
      localPdfPath: "C:\\temp\\test.pdf",
      copies: 1,
    });

    expect(result.spoolJobId).toBe("42");
    expect(mockExecutor).toHaveBeenCalledTimes(1);
    expect(capturedScript).toContain("Canon MF4700");
    expect(capturedScript).toContain("C:\\temp\\test.pdf");
    expect(capturedScript).toContain("PrintTo");
  });

  it("observes COMPLETED_OR_REMOVED when spooler removes job", async () => {
    const mockExecutor = vi.fn(() => Promise.resolve("REMOVED"));
    const adapter = new WindowsPrinterAdapter(mockExecutor);

    const status = await adapter.getJobStatus("Canon MF4700", "42");
    expect(status.state).toBe("COMPLETED_OR_REMOVED");
    expect(status.spoolJobId).toBe("42");
  });

  it("CRITICAL RULE: distinguishes BLOCKED status (paper out) from FAILED", async () => {
    const mockExecutor = vi.fn(() =>
      Promise.resolve(
        JSON.stringify({
          JobId: "42",
          JobStatus: "PaperOut",
          Status: "Error",
          StatusMask: 0x0040, // PaperOut bit
        }),
      ),
    );
    const adapter = new WindowsPrinterAdapter(mockExecutor);

    const status = await adapter.getJobStatus("Canon MF4700", "42");
    expect(status.state).toBe("BLOCKED");
    expect(status.failureCode).toBe("PAPER_OUT");
  });

  it("distinguishes FAILED status for fatal spool errors", async () => {
    const mockExecutor = vi.fn(() =>
      Promise.resolve(
        JSON.stringify({
          JobId: "42",
          JobStatus: "Error",
          Status: "Error",
          StatusMask: 0x0002, // Error bit
        }),
      ),
    );
    const adapter = new WindowsPrinterAdapter(mockExecutor);

    const status = await adapter.getJobStatus("Canon MF4700", "42");
    expect(status.state).toBe("FAILED");
    expect(status.failureCode).toBe("PRINTER_ERROR");
  });
});

describe("DevelopmentPrinterAdapter", () => {
  it("provides simulated printers for local non-Windows environments", async () => {
    const adapter = new DevelopmentPrinterAdapter();
    const list = await adapter.listPrinters();

    expect(list.length).toBeGreaterThan(0);
    const first = list[0]!;
    const status = await adapter.getStatus(first.id);
    expect(status.availability).toBe("ONLINE");

    const caps = await adapter.getCapabilities(first.id);
    expect(caps.paperSizes).toContain("A4");
  });

  it("simulates job submission and status lifecycle", async () => {
    const adapter = new DevelopmentPrinterAdapter();
    const submission = await adapter.submitPdfJob({
      printerId: "Shop LaserJet Pro M404dn",
      localPdfPath: "/tmp/test.pdf",
    });

    expect(submission.spoolJobId).toContain("dev-spool-");

    const status = await adapter.getJobStatus(
      "Shop LaserJet Pro M404dn",
      submission.spoolJobId,
    );
    expect(["SPOOLING", "PRINTING", "COMPLETED_OR_REMOVED"]).toContain(
      status.state,
    );
  });
});

describe("createDefaultPrinterAdapter Production Guard", () => {
  it("fails closed on non-Windows host when running in production", () => {
    const originalEnv = process.env.NODE_ENV;

    try {
      // Simulate production environment
      process.env.NODE_ENV = "production";

      if (process.platform !== "win32") {
        expect(() => createDefaultPrinterAdapter()).toThrow(
          /Production PrintGo Agent requires a Windows host/i,
        );
      }
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });
});
