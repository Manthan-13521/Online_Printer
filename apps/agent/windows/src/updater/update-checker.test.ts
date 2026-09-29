import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkReleaseUpdate,
  compareSemver,
  verifyFileChecksum,
  verifyInstallerForExecution,
  type ReleaseManifest,
} from "./update-checker.js";

describe("compareSemver", () => {
  it("correctly identifies higher, lower, and equal versions", () => {
    expect(compareSemver("2.1.0", "2.0.0")).toBeGreaterThan(0);
    expect(compareSemver("2.0.0", "2.1.0")).toBeLessThan(0);
    expect(compareSemver("2.1.0", "2.1.0")).toBe(0);
    expect(compareSemver("v2.1.1", "2.1.0")).toBeGreaterThan(0);
  });
});

describe("checkReleaseUpdate", () => {
  it.each([
    { sha256: "" },
    { downloadUrl: "" },
    { downloadUrl: "https://secret@example.test/setup.exe" },
    { version: "2.1x.0" },
    { fileSizeBytes: 0 },
  ])("rejects incomplete or unsafe release metadata %j", async (invalid) => {
    await expect(
      checkReleaseUpdate("2.0.0", () =>
        Promise.resolve({
          version: "2.1.0",
          releaseDate: "2026-09-29",
          downloadUrl: "https://example.test/setup.exe",
          fileName: "PrintGo-Setup.exe",
          sha256: "a".repeat(64),
          fileSizeBytes: 100,
          ...invalid,
        }),
      ),
    ).rejects.toThrow();
  });

  it("reports update available when manifest version is higher", async () => {
    const validSha = "a".repeat(64);
    const mockManifest: ReleaseManifest = {
      version: "2.1.0",
      releaseDate: new Date().toISOString(),
      downloadUrl:
        "https://downloads.printgo.dev/windows/PrintGo-Setup-2.1.0.exe",
      fileName: "PrintGo-Setup-2.1.0.exe",
      sha256: validSha,
      fileSizeBytes: 1024,
      minSupportedVersion: "2.0.0",
      changelog: ["Bug fixes"],
    };

    const res = await checkReleaseUpdate("2.0.0", async () => {
      await Promise.resolve();
      return mockManifest;
    });
    expect(res.updateAvailable).toBe(true);
    expect(res.latestVersion).toBe("2.1.0");
    expect(res.isCritical).toBe(false);
    expect(res.downloadUrl).toBe(mockManifest.downloadUrl);
  });

  it("rejects insecure HTTP download URLs", async () => {
    const mockManifest: ReleaseManifest = {
      version: "2.1.0",
      releaseDate: new Date().toISOString(),
      downloadUrl: "http://downloads.printgo.dev/windows/PrintGo-Setup.exe",
      fileName: "PrintGo-Setup.exe",
      sha256: "b".repeat(64),
      fileSizeBytes: 1024,
    };

    await expect(
      checkReleaseUpdate("2.0.0", async () => {
        await Promise.resolve();
        return mockManifest;
      }),
    ).rejects.toThrow("Insecure download URL rejected");
  });

  it("rejects invalid SHA-256 checksum formats", async () => {
    const mockManifest: ReleaseManifest = {
      version: "2.1.0",
      releaseDate: new Date().toISOString(),
      downloadUrl: "https://downloads.printgo.dev/windows/PrintGo-Setup.exe",
      fileName: "PrintGo-Setup.exe",
      sha256: "invalid-hash-too-short",
      fileSizeBytes: 1024,
    };

    await expect(
      checkReleaseUpdate("2.0.0", async () => {
        await Promise.resolve();
        return mockManifest;
      }),
    ).rejects.toThrow("Invalid SHA-256 checksum format");
  });

  it("marks as critical when current version is below minSupportedVersion", async () => {
    const mockManifest: ReleaseManifest = {
      version: "2.5.0",
      releaseDate: new Date().toISOString(),
      downloadUrl:
        "https://downloads.printgo.dev/windows/PrintGo-Setup-2.5.0.exe",
      fileName: "PrintGo-Setup-2.5.0.exe",
      sha256: "c".repeat(64),
      fileSizeBytes: 2048,
      minSupportedVersion: "2.2.0",
    };

    const res = await checkReleaseUpdate("2.1.0", async () => {
      await Promise.resolve();
      return mockManifest;
    });
    expect(res.updateAvailable).toBe(true);
    expect(res.isCritical).toBe(true);
  });

  it("reports no update when current version is equal or newer", async () => {
    const mockManifest: ReleaseManifest = {
      version: "2.1.0",
      releaseDate: new Date().toISOString(),
      downloadUrl:
        "https://downloads.printgo.dev/windows/PrintGo-Setup-2.1.0.exe",
      fileName: "PrintGo-Setup-2.1.0.exe",
      sha256: "d".repeat(64),
      fileSizeBytes: 1024,
    };

    const res = await checkReleaseUpdate("2.1.0", async () => {
      await Promise.resolve();
      return mockManifest;
    });
    expect(res.updateAvailable).toBe(false);
    expect(res.downloadUrl).toBeUndefined();
  });
});

describe("verifyFileChecksum and verifyInstallerForExecution", () => {
  it("verifies SHA-256 hash correctly", async () => {
    const tempFile = path.join(os.tmpdir(), `checksum-test-${Date.now()}.txt`);
    const content = "PrintGo Authenticode Integrity Check";
    await fs.writeFile(tempFile, content);

    const actualHash = crypto
      .createHash("sha256")
      .update(content)
      .digest("hex");
    const valid = await verifyFileChecksum(tempFile, actualHash);
    const invalid = await verifyFileChecksum(tempFile, "badhash123");

    expect(valid).toBe(true);
    expect(invalid).toBe(false);

    // Test verifyInstallerForExecution
    const execValid = await verifyInstallerForExecution(tempFile, actualHash);
    expect(execValid.valid).toBe(true);

    const execMismatch = await verifyInstallerForExecution(
      tempFile,
      "0".repeat(64),
    );
    expect(execMismatch.valid).toBe(false);
    expect(execMismatch.reason).toContain("checksum mismatch");

    await fs.unlink(tempFile);
  });

  it("rejects non-existent or empty installer files", async () => {
    const missing = await verifyInstallerForExecution(
      path.join(os.tmpdir(), "nonexistent.exe"),
      "0".repeat(64),
    );
    expect(missing.valid).toBe(false);

    const emptyFile = path.join(os.tmpdir(), `empty-${Date.now()}.exe`);
    await fs.writeFile(emptyFile, Buffer.alloc(0));

    const emptyRes = await verifyInstallerForExecution(
      emptyFile,
      "0".repeat(64),
    );
    expect(emptyRes.valid).toBe(false);
    expect(emptyRes.reason).toContain("empty");

    await fs.unlink(emptyFile);
  });
});
