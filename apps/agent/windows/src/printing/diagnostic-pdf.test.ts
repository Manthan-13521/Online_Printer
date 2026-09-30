import * as fs from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  createDiagnosticPdfFile,
  generateDiagnosticPdfBuffer,
} from "./diagnostic-pdf";

describe("Diagnostic PDF Generator", () => {
  it("generates a valid PDF buffer with required markers and text", () => {
    const buffer = generateDiagnosticPdfBuffer({
      printerDisplayName: "Front Desk Canon",
      shopName: "Central Xerox Shop",
    });

    expect(buffer.length).toBeGreaterThan(400);

    const text = buffer.toString("utf8");
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain("%%EOF");
    expect(text).toContain("Central Xerox Shop");
    expect(text).toContain("Printer: Front Desk Canon");
    expect(text).toContain("TEST PRINT CONFIRMED");
    expect(text).not.toContain("Customer");
    expect(text).not.toContain("Command ID");
    expect(text).not.toContain("Date / Time");
    expect(text).toContain("Front Desk Canon");
  });

  it("creates and cleans up a temporary PDF file", async () => {
    const filePath = await createDiagnosticPdfFile({
      printerDisplayName: "Test Printer",
      shopName: "Test Shop",
    });

    expect(filePath).toContain("test-print-");
    expect(filePath.endsWith(".pdf")).toBe(true);

    const exists = await fs
      .stat(filePath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);

    // Clean up
    await fs.unlink(filePath);

    const existsAfter = await fs
      .stat(filePath)
      .then(() => true)
      .catch(() => false);
    expect(existsAfter).toBe(false);
  });
});
