import { describe, expect, it } from "vitest";
import { classifyPrinter, isVirtualPrinter } from "./printer-classification.js";

describe("printer classification", () => {
  it("classifies real physical HP printer as eligible", () => {
    const hp = classifyPrinter({
      name: "HPF80DACE6151A(HP Laser MFP 131 133 135-138)",
      portName: "WSD-f80dace6-151a-42c2-8495-a496f80dace6",
      driverName: "HP Laser MFP 131 133 135-138",
    });
    expect(hp.isVirtual).toBe(false);
    expect(hp.isEligibleForProductionPrint).toBe(true);
    expect(isVirtualPrinter("HP Laser MFP 135a", "USB001")).toBe(false);
  });

  it("classifies thermal label printer as physical", () => {
    const xprinter = classifyPrinter({
      name: "Xprinter XP-TT426B",
      portName: "USB002",
      driverName: "Xprinter XP-TT426B",
    });
    expect(xprinter.isVirtual).toBe(false);
    expect(xprinter.isEligibleForProductionPrint).toBe(true);
  });

  it("classifies OneNote variants as virtual and ineligible", () => {
    const oneNoteDesktop = classifyPrinter({
      name: "OneNote (Desktop)",
      portName: "nul:",
      driverName: "Send to Microsoft OneNote 16 Driver",
    });
    expect(oneNoteDesktop.isVirtual).toBe(true);
    expect(oneNoteDesktop.isEligibleForProductionPrint).toBe(false);

    expect(isVirtualPrinter("OneNote for Windows 10")).toBe(true);
    expect(isVirtualPrinter("Send to OneNote")).toBe(true);
  });

  it("classifies Microsoft Print to PDF as virtual", () => {
    const pdf = classifyPrinter({
      name: "Microsoft Print to PDF",
      portName: "PORTPROMPT:",
      driverName: "Microsoft Print To PDF",
    });
    expect(pdf.isVirtual).toBe(true);
    expect(pdf.isEligibleForProductionPrint).toBe(false);
    expect(isVirtualPrinter("Microsoft Print to PDF")).toBe(true);
  });

  it("classifies XPS Document Writer as virtual", () => {
    const xps = classifyPrinter({
      name: "Microsoft XPS Document Writer",
      portName: "PORTPROMPT:",
      driverName: "Microsoft XPS Document Writer v4",
    });
    expect(xps.isVirtual).toBe(true);
    expect(xps.isEligibleForProductionPrint).toBe(false);
  });

  it("classifies Fax as virtual", () => {
    const fax = classifyPrinter({
      name: "Fax",
      portName: "SHRFAX:",
      driverName: "Microsoft Shared Fax Driver",
    });
    expect(fax.isVirtual).toBe(true);
    expect(fax.isEligibleForProductionPrint).toBe(false);
  });

  it("classifies third-party virtual PDF printers as virtual", () => {
    expect(isVirtualPrinter("Adobe PDF")).toBe(true);
    expect(isVirtualPrinter("CutePDF Writer")).toBe(true);
    expect(isVirtualPrinter("Foxit PDF Printer")).toBe(true);
    expect(isVirtualPrinter("Bullzip PDF Printer")).toBe(true);
    expect(isVirtualPrinter("PDFCreator")).toBe(true);
  });

  it("detects virtual printer based on port even if name is disguised", () => {
    const disguised = classifyPrinter({
      name: "Office Printer 1",
      portName: "PORTPROMPT:",
      driverName: "HP Universal Printing",
    });
    expect(disguised.isVirtual).toBe(true);
    expect(disguised.isEligibleForProductionPrint).toBe(false);
  });
});
