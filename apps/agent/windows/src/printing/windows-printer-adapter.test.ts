import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DevelopmentPrinterAdapter,
  WindowsPrinterAdapter,
  createDefaultPrinterAdapter,
} from "./windows-printer-adapter.js";

function createScriptCapturingExecutor(spoolJobId = "42", capsJson?: string) {
  const scripts: string[] = [];
  const executor = vi.fn((script: string) => {
    scripts.push(script);
    if (script.includes("CapabilityDescriptions")) {
      return Promise.resolve(
        capsJson ??
          JSON.stringify({
            Name: "Test Printer",
            CapabilityDescriptions: ["Color", "Duplex", "A4"],
          }),
      );
    }
    return Promise.resolve(
      JSON.stringify({ spoolJobId, engineUsed: "sumatrapdf" }),
    );
  });
  return { executor, scripts };
}

afterEach(() => vi.useRealTimers());

describe("WindowsPrinterAdapter with mock executor", () => {
  it("reuses slow inventory and shares capability collection while keeping health fresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let driver = "Driver A";
    const scripts: string[] = [];
    const adapter = new WindowsPrinterAdapter((script) => {
      scripts.push(script);
      return Promise.resolve(
        JSON.stringify({
          Name: "Printer",
          DriverName: driver,
          PortName: "USB001",
          WorkOffline: false,
          PrinterStatus: 3,
          Color: false,
          CapabilityDescriptions: ["Simplex"],
          PrinterPaperNames: ["A4"],
        }),
      );
    });
    await adapter.listPrinters();
    await adapter.getCapabilities("Printer");
    expect(scripts).toHaveLength(1);
    vi.setSystemTime(60_000);
    await adapter.listPrinters();
    expect((await adapter.getStatus("Printer")).availability).toBe("ONLINE");
    expect(scripts[1]).not.toContain("CapabilityDescriptions");
    vi.setSystemTime(120_000);
    driver = "Driver B";
    await adapter.listPrinters();
    expect(scripts).toHaveLength(4); // Changed driver triggers an immediate full reconciliation.
    expect(scripts[3]).toContain("CapabilityDescriptions");
    vi.setSystemTime(420_000);
    await adapter.listPrinters();
    expect(scripts[4]).toContain("CapabilityDescriptions");
    await adapter.listPrinters(true);
    expect(scripts[5]).toContain("CapabilityDescriptions");
  });

  it.each([
    [3, "ONLINE"],
    [5, "ONLINE"],
    [9, "OFFLINE"],
    [10, "BLOCKED"],
  ] as const)(
    "interprets CIM error state %s without treating low-supply warnings as failures",
    async (errorState, expected) => {
      const adapter = new WindowsPrinterAdapter(() =>
        Promise.resolve(
          JSON.stringify({
            Name: "Printer",
            PrinterStatus: 3,
            DetectedErrorState: errorState,
          }),
        ),
      );
      await adapter.listPrinters();
      expect((await adapter.getStatus("Printer")).availability).toBe(expected);
    },
  );

  it("reports a printer ONLINE when Windows CIM output has no error or offline flags", async () => {
    const adapter = new WindowsPrinterAdapter(() =>
      Promise.resolve(JSON.stringify({ Name: "Printer" })),
    );
    await adapter.listPrinters();
    expect((await adapter.getStatus("Printer")).availability).toBe("ONLINE");
  });

  it("drops stale ONLINE snapshots when discovery fails or the printer disappears", async () => {
    let response = JSON.stringify({ Name: "Printer", PrinterStatus: 3 });
    const adapter = new WindowsPrinterAdapter(() => Promise.resolve(response));
    expect(await adapter.listPrinters()).toHaveLength(1);
    response = "";
    expect(await adapter.listPrinters()).toHaveLength(0);
    expect((await adapter.getStatus("Printer")).availability).toBe("OFFLINE");
  });

  it("checks real printer readiness inside the submission process before Sumatra starts", async () => {
    const { executor, scripts } = createScriptCapturingExecutor("42");
    const adapter = new WindowsPrinterAdapter(executor);
    await adapter.submitPdfJob({
      printerId: "Test Printer",
      localPdfPath: "C:/synthetic.pdf",
    });
    const submit = scripts.find((script) =>
      script.includes("ProcessStartInfo"),
    )!;
    expect(submit).toContain(
      "Printer readiness could not be confirmed before submission.",
    );
    expect(submit).toContain(
      "$ready.DetectedErrorState -in @(4,6,7,8,9,10,11)",
    );
    expect(submit.indexOf("$ready = Get-CimInstance")).toBeLessThan(
      submit.indexOf("ProcessStartInfo"),
    );
  });

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
      portName: null,
      driverName: null,
      isVirtual: false,
      isEligibleForProductionPrint: true,
    });
    expect(printers[1]).toEqual({
      id: "HP LaserJet 1020",
      displayName: "HP LaserJet 1020",
      isDefault: false,
      portName: null,
      driverName: null,
      isVirtual: false,
      isEligibleForProductionPrint: true,
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

  it("caches capabilities for 10 minutes to avoid redundant PowerShell invocations", async () => {
    const mockExecutor = vi.fn(() =>
      Promise.resolve(
        JSON.stringify({
          Name: "Color Duplex Printer",
          CapabilityDescriptions: ["Color Printing", "Duplex", "Two-Sided"],
        }),
      ),
    );

    const adapter = new WindowsPrinterAdapter(mockExecutor);
    const caps1 = await adapter.getCapabilities("Color Duplex Printer");
    expect(mockExecutor).toHaveBeenCalledTimes(1);
    expect(caps1.colour).toBe(true);

    // Second call within 10 minutes should use cache without invoking PowerShell
    const caps2 = await adapter.getCapabilities("Color Duplex Printer");
    expect(mockExecutor).toHaveBeenCalledTimes(1);
    expect(caps2).toEqual(caps1);
  });

  it("submits a PDF job and returns captured spool job ID", async () => {
    const { executor, scripts } = createScriptCapturingExecutor("42");
    const adapter = new WindowsPrinterAdapter(executor);

    const result = await adapter.submitPdfJob({
      printerId: "Canon MF4700",
      localPdfPath: "C:\\temp\\test.pdf",
      copies: 1,
    });

    expect(result.spoolJobId).toBe("42");
    const submitScript = scripts.find((s) => s.includes("$sumatra"))!;
    expect(submitScript).toContain("Canon MF4700");
    expect(submitScript).toContain("C:\\temp\\test.pdf");
    expect(submitScript).toContain("-print-to");
    expect(submitScript).toContain("-print-settings");
    expect(submitScript).toContain("-silent");
  });

  it("propagates exact named printer to -print-to switch without default fallback", async () => {
    const { executor, scripts } = createScriptCapturingExecutor("101");
    const adapter = new WindowsPrinterAdapter(executor);

    await adapter.submitPdfJob({
      printerId: "HP LaserJet Pro MFP M428fdw",
      localPdfPath: "C:\\jobs\\doc.pdf",
    });

    const submitScript = scripts.find((s) => s.includes("-print-to"))!;
    expect(submitScript).toContain("$printer = 'HP LaserJet Pro MFP M428fdw'");
    expect(submitScript).toContain('-print-to `"$printer`"');
    expect(submitScript).not.toContain("-print-to-default");
  });

  it("propagates A4 and A3 paper size in -print-settings", async () => {
    const capsWithA3 = JSON.stringify({
      Name: "Plotter",
      CapabilityDescriptions: ["A4", "A3"],
    });
    const { executor, scripts } = createScriptCapturingExecutor(
      "102",
      capsWithA3,
    );
    const adapter = new WindowsPrinterAdapter(executor);

    await adapter.submitPdfJob({
      printerId: "Plotter",
      localPdfPath: "C:\\jobs\\drawing.pdf",
      settings: {
        paperSize: "A3",
        copies: 1,
        colorMode: "BLACK_AND_WHITE",
        sides: "ONE_SIDED",
      },
    });

    const submitScript = scripts.find((s) => s.includes("-print-settings"))!;
    expect(submitScript).toContain("paper=A3");
  });

  it("propagates color vs monochrome setting in -print-settings", async () => {
    const { executor, scripts } = createScriptCapturingExecutor("103");
    const adapter = new WindowsPrinterAdapter(executor);

    await adapter.submitPdfJob({
      printerId: "Color Printer",
      localPdfPath: "C:\\jobs\\flyer.pdf",
      settings: {
        colorMode: "COLOUR",
        copies: 1,
        paperSize: "A4",
        sides: "ONE_SIDED",
      },
    });

    const submitScript = scripts.find((s) => s.includes("-print-settings"))!;
    expect(submitScript).toContain("color");
    expect(submitScript).not.toContain("monochrome");
  });

  it("propagates duplexlong and simplex in -print-settings", async () => {
    const { executor, scripts } = createScriptCapturingExecutor("104");
    const adapter = new WindowsPrinterAdapter(executor);

    await adapter.submitPdfJob({
      printerId: "Office Duplex Printer",
      localPdfPath: "C:\\jobs\\report.pdf",
      settings: {
        sides: "TWO_SIDED_LONG",
        copies: 1,
        paperSize: "A4",
        colorMode: "BLACK_AND_WHITE",
      },
    });

    const submitScript = scripts.find((s) => s.includes("-print-settings"))!;
    expect(submitScript).toContain("duplexlong");
  });

  it("propagates copy count in -print-settings", async () => {
    const { executor, scripts } = createScriptCapturingExecutor("105");
    const adapter = new WindowsPrinterAdapter(executor);

    await adapter.submitPdfJob({
      printerId: "Fast Printer",
      localPdfPath: "C:\\jobs\\handout.pdf",
      settings: {
        copies: 5,
        paperSize: "A4",
        colorMode: "BLACK_AND_WHITE",
        sides: "ONE_SIDED",
      },
    });

    const submitScript = scripts.find((s) => s.includes("-print-settings"))!;
    expect(submitScript).toContain("5x");
  });

  it("propagates normalized page range in -print-settings", async () => {
    const { executor, scripts } = createScriptCapturingExecutor("106");
    const adapter = new WindowsPrinterAdapter(executor);

    await adapter.submitPdfJob({
      printerId: "Standard Printer",
      localPdfPath: "C:\\jobs\\thesis.pdf",
      settings: {
        pageRange: "2-7, 10",
        copies: 1,
        paperSize: "A4",
        colorMode: "BLACK_AND_WHITE",
        sides: "ONE_SIDED",
      },
    });

    const submitScript = scripts.find((s) => s.includes("-print-settings"))!;
    expect(submitScript).toContain("2-7,10");
  });

  it("fails closed when A3 requested on printer without A3 (no silent downgrade)", async () => {
    const capsA4Only = JSON.stringify({
      Name: "Small Printer",
      CapabilityDescriptions: ["A4"],
    });
    const { executor } = createScriptCapturingExecutor("107", capsA4Only);
    const adapter = new WindowsPrinterAdapter(executor);

    await expect(
      adapter.submitPdfJob({
        printerId: "Small Printer",
        localPdfPath: "C:\\jobs\\big.pdf",
        settings: {
          paperSize: "A3",
          copies: 1,
          colorMode: "BLACK_AND_WHITE",
          sides: "ONE_SIDED",
        },
      }),
    ).rejects.toThrow(/does not support paper size 'A3'/i);
  });

  it("fails closed when COLOUR requested on monochrome printer (no silent downgrade)", async () => {
    const capsMono = JSON.stringify({
      Name: "Mono Laser",
      CapabilityDescriptions: ["Monochrome"],
    });
    const { executor } = createScriptCapturingExecutor("108", capsMono);
    const adapter = new WindowsPrinterAdapter(executor);

    await expect(
      adapter.submitPdfJob({
        printerId: "Mono Laser",
        localPdfPath: "C:\\jobs\\photo.pdf",
        settings: {
          colorMode: "COLOUR",
          copies: 1,
          paperSize: "A4",
          sides: "ONE_SIDED",
        },
      }),
    ).rejects.toThrow(/does not support colour printing/i);
  });

  it("fails closed when DUPLEX requested on simplex printer (no silent downgrade)", async () => {
    const capsSimplex = JSON.stringify({
      Name: "Simple Laser",
      CapabilityDescriptions: ["Simplex"],
    });
    const { executor } = createScriptCapturingExecutor("109", capsSimplex);
    const adapter = new WindowsPrinterAdapter(executor);

    await expect(
      adapter.submitPdfJob({
        printerId: "Simple Laser",
        localPdfPath: "C:\\jobs\\book.pdf",
        settings: {
          sides: "TWO_SIDED_LONG",
          copies: 1,
          paperSize: "A4",
          colorMode: "BLACK_AND_WHITE",
        },
      }),
    ).rejects.toThrow(/does not support double-sided/i);
  });

  it("fails closed on non-positive copies", async () => {
    const { executor } = createScriptCapturingExecutor("110");
    const adapter = new WindowsPrinterAdapter(executor);

    await expect(
      adapter.submitPdfJob({
        printerId: "Test Printer",
        localPdfPath: "C:\\jobs\\doc.pdf",
        settings: {
          copies: 0,
          paperSize: "A4",
          colorMode: "BLACK_AND_WHITE",
          sides: "ONE_SIDED",
        },
      }),
    ).rejects.toThrow(/Copies must be a positive integer/i);
  });

  it("fails closed on invalid page range", async () => {
    const { executor } = createScriptCapturingExecutor("111");
    const adapter = new WindowsPrinterAdapter(executor);

    await expect(
      adapter.submitPdfJob({
        printerId: "Test Printer",
        localPdfPath: "C:\\jobs\\doc.pdf",
        settings: {
          pageRange: "10-2",
          copies: 1,
          paperSize: "A4",
          colorMode: "BLACK_AND_WHITE",
          sides: "ONE_SIDED",
        },
      }),
    ).rejects.toThrow(/Invalid page range/i);
  });

  it("correlates spooler job strictly using document identifier and pre-submission exclusion", async () => {
    const { executor, scripts } = createScriptCapturingExecutor("112");
    const adapter = new WindowsPrinterAdapter(executor);

    await adapter.submitPdfJob({
      printerId: "Shared Deskjet",
      localPdfPath: "C:\\jobs\\printgo_test_unique123.pdf",
      documentTitle: "printgo_test_unique123",
    });

    const submitScript = scripts.find((s) => s.includes("$beforeIds"))!;
    expect(submitScript).toContain("$beforeIds -notcontains [int]$_.JobId");
    expect(submitScript).toContain("$_.Document.Contains($docIdentifier)");
    expect(submitScript).not.toContain("$fallbackJob");
  });

  it("never falls back to the nondeterministic Windows PrintTo verb", async () => {
    const { executor, scripts } = createScriptCapturingExecutor("113");
    const adapter = new WindowsPrinterAdapter(executor);

    await adapter.submitPdfJob({
      printerId: "Exact Queue",
      localPdfPath: "C:\\jobs\\one-page.pdf",
    });

    const submitScript = scripts.find((script) => script.includes("$sumatra"))!;
    expect(submitScript).not.toContain('$psi.Verb = "PrintTo"');
    expect(submitScript).toContain(
      "No unverified Windows PrintTo fallback is permitted",
    );
  });

  it("rejects a settings printer name that differs from the submitted printer", async () => {
    const { executor } = createScriptCapturingExecutor("114");
    const adapter = new WindowsPrinterAdapter(executor);

    await expect(
      adapter.submitPdfJob({
        printerId: "Validated Queue",
        localPdfPath: "C:\\jobs\\doc.pdf",
        settings: { printerName: "Different Queue" },
      }),
    ).rejects.toThrow(/match the exact submitted printer ID/i);
  });

  it("observes COMPLETED_OR_REMOVED when spooler removes job", async () => {
    const mockExecutor = vi.fn(() => Promise.resolve("REMOVED"));
    const adapter = new WindowsPrinterAdapter(mockExecutor);

    const status = await adapter.getJobStatus("Canon MF4700", "42");
    expect(status.state).toBe("COMPLETED_OR_REMOVED");
    expect(status.spoolJobId).toBe("42");
  });

  it("does not treat a retained but unfinished spool job as completed", async () => {
    const mockExecutor = vi.fn(() =>
      Promise.resolve(
        JSON.stringify({
          JobId: "42",
          JobStatus: "Retained",
          Status: "OK",
          StatusMask: 0x2000,
          TotalPages: 2,
          PagesPrinted: 0,
        }),
      ),
    );
    const adapter = new WindowsPrinterAdapter(mockExecutor);

    const status = await adapter.getJobStatus("Canon MF4700", "42");
    expect(status.state).toBe("QUEUED");
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

  it("DevelopmentPrinterAdapter enforces the same fail-closed setting validations", async () => {
    const adapter = new DevelopmentPrinterAdapter();

    // Shop LaserJet Pro M404dn is monochrome only
    await expect(
      adapter.submitPdfJob({
        printerId: "Shop LaserJet Pro M404dn",
        localPdfPath: "/tmp/doc.pdf",
        settings: {
          colorMode: "COLOUR",
          copies: 1,
          paperSize: "A4",
          sides: "ONE_SIDED",
        },
      }),
    ).rejects.toThrow(/does not support colour printing/i);

    // A3 on A4-only printer
    await expect(
      adapter.submitPdfJob({
        printerId: "Shop LaserJet Pro M404dn",
        localPdfPath: "/tmp/doc.pdf",
        settings: {
          paperSize: "A3",
          copies: 1,
          colorMode: "BLACK_AND_WHITE",
          sides: "ONE_SIDED",
        },
      }),
    ).rejects.toThrow(/does not support paper size 'A3'/i);
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
