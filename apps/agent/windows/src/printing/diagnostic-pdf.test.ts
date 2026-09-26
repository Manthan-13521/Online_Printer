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
      agentDisplayName: "Front Desk PC",
      commandId: "cmd-12345",
      shopName: "Central Xerox Shop",
      timestamp: new Date("2026-09-26T12:00:00Z"),
    });

    expect(buffer.length).toBeGreaterThan(500);

    const text = buffer.toString("utf8");
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain("%%EOF");
    expect(text).toContain("PRINTGO TEST PAGE");
    expect(text).toContain("NOT A CUSTOMER ORDER");
    expect(text).toContain("Front Desk Canon");
    expect(text).toContain("Front Desk PC");
    expect(text).toContain("Central Xerox Shop");
    expect(text).toContain("cmd-12345");
  });

  it("creates and cleans up a temporary PDF file", async () => {
    const filePath = await createDiagnosticPdfFile({
      printerDisplayName: "Test Printer",
      agentDisplayName: "Test PC",
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
