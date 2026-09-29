import { describe, expect, it } from "vitest";
import { buildZipArchive } from "./zip-builder.js";

describe("buildZipArchive", () => {
  it("creates a valid zip buffer with PK headers", () => {
    const archive = buildZipArchive([
      { path: "test.txt", data: "Hello PrintGo!" },
      { path: "data/config.json", data: JSON.stringify({ version: "2.1.0" }) },
    ]);

    expect(Buffer.isBuffer(archive)).toBe(true);
    expect(archive.length).toBeGreaterThan(50);
    // Starts with PK zip local header signature 0x04034b50
    expect(archive.readUInt32LE(0)).toBe(0x04034b50);
  });
});
