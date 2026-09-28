import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkSumatraPdfInstalled, runCli } from "./index.js";

describe("checkSumatraPdfInstalled", () => {
  const originalPlatform = process.platform;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    process.env = originalEnv;
  });

  it("returns true on non-Windows platforms", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    expect(checkSumatraPdfInstalled()).toBe(true);

    Object.defineProperty(process, "platform", { value: "linux" });
    expect(checkSumatraPdfInstalled()).toBe(true);
  });

  it("returns true when PRINTGO_SUMATRA_PATH points to an existing file", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    // Use package.json as an existing file to test truthy existence check
    process.env.PRINTGO_SUMATRA_PATH = process.cwd() + "/package.json";
    expect(checkSumatraPdfInstalled()).toBe(true);
  });

  it("returns false on Windows when SumatraPDF is not found anywhere", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    delete process.env.PRINTGO_SUMATRA_PATH;
    process.env.ProgramFiles = "/non/existent/path";
    delete process.env["ProgramFiles(x86)"];
    delete process.env.LOCALAPPDATA;
    expect(checkSumatraPdfInstalled()).toBe(false);
  });
});

describe("runCli CLI flags", () => {
  const originalArgv = [...process.argv];

  afterEach(() => {
    process.argv = [...originalArgv];
    vi.restoreAllMocks();
  });

  it("prints version and exits without error on --version or -v", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    process.argv = ["node", "index.js", "--version"];
    await runCli();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("PrintGo Windows Agent v2.0.0"),
    );

    logSpy.mockClear();
    process.argv = ["node", "index.js", "-v"];
    await runCli();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("PrintGo Windows Agent v2.0.0"),
    );
  });

  it("prints help text and exits without error on --help or -h", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    process.argv = ["node", "index.js", "--help"];
    await runCli();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("PrintGo Windows Agent (v2.0.0)"),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Usage:\n  PrintGo-Agent.exe [options]"),
    );

    logSpy.mockClear();
    process.argv = ["node", "index.js", "-h"];
    await runCli();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("PrintGo Windows Agent (v2.0.0)"),
    );
  });
});
