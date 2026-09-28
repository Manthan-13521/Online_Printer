import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WINDOWS_AGENT_DOWNLOAD_URL,
  DEFAULT_WINDOWS_AGENT_SHA256,
  DEFAULT_WINDOWS_AGENT_ZIP_DOWNLOAD_URL,
  getWindowsAgentReleaseConfig,
} from "./agent-download";

describe("agent-download release config", () => {
  const originalEnv = String(
    import.meta.env.VITE_WINDOWS_AGENT_DOWNLOAD_URL ?? "",
  );

  afterEach(() => {
    import.meta.env.VITE_WINDOWS_AGENT_DOWNLOAD_URL = originalEnv;
    vi.restoreAllMocks();
  });

  it("returns build pending when env variable is unset", () => {
    delete import.meta.env.VITE_WINDOWS_AGENT_DOWNLOAD_URL;
    const config = getWindowsAgentReleaseConfig();

    expect(config.isLive).toBe(false);
    expect(config.downloadUrl).toBeNull();
    expect(config.fileName).toBe("PrintGo-Agent.exe");
    expect(config.version).toBe("v2.0.0");
    expect(config.sha256).toBe(DEFAULT_WINDOWS_AGENT_SHA256);
  });

  it("returns live release configuration when valid download URL is configured", () => {
    import.meta.env.VITE_WINDOWS_AGENT_DOWNLOAD_URL =
      DEFAULT_WINDOWS_AGENT_DOWNLOAD_URL;
    const config = getWindowsAgentReleaseConfig();

    expect(config.isLive).toBe(true);
    expect(config.downloadUrl).toBe(DEFAULT_WINDOWS_AGENT_DOWNLOAD_URL);
    expect(config.fileName).toBe("PrintGo-Agent.exe");
    expect(config.version).toBe("v2.0.0");
    expect(config.sha256).toBe(DEFAULT_WINDOWS_AGENT_SHA256);
    expect(config.zipDownloadUrl).toBe(DEFAULT_WINDOWS_AGENT_ZIP_DOWNLOAD_URL);
  });

  it("uses custom valid URL if specified in env", () => {
    import.meta.env.VITE_WINDOWS_AGENT_DOWNLOAD_URL =
      "https://custom-cdn.printgo.store/PrintGo-Agent.exe";
    const config = getWindowsAgentReleaseConfig();

    expect(config.isLive).toBe(true);
    expect(config.downloadUrl).toBe(
      "https://custom-cdn.printgo.store/PrintGo-Agent.exe",
    );
  });

  it("marks as disabled if env specifies false or disabled", () => {
    import.meta.env.VITE_WINDOWS_AGENT_DOWNLOAD_URL = "disabled";
    const configDisabled = getWindowsAgentReleaseConfig();
    expect(configDisabled.isLive).toBe(false);
    expect(configDisabled.downloadUrl).toBeNull();

    import.meta.env.VITE_WINDOWS_AGENT_DOWNLOAD_URL = "false";
    const configFalse = getWindowsAgentReleaseConfig();
    expect(configFalse.isLive).toBe(false);
    expect(configFalse.downloadUrl).toBeNull();
  });
});
