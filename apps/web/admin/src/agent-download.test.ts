import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentConnectionUrl,
  getWindowsAgentReleaseConfig,
} from "./agent-download";
afterEach(() => vi.unstubAllEnvs());
describe("approved installer configuration", () => {
  it("does not fabricate a production release", () => {
    vi.stubEnv("PROD", true);
    vi.stubEnv("VITE_WINDOWS_AGENT_DOWNLOAD_URL", "");
    expect(getWindowsAgentReleaseConfig().isLive).toBe(false);
  });
  it("requires the matching checksum and version", () => {
    vi.stubEnv(
      "VITE_WINDOWS_AGENT_DOWNLOAD_URL",
      "https://example.test/PrintGo-Setup.exe",
    );
    vi.stubEnv("VITE_WINDOWS_AGENT_SHA256", "");
    expect(getWindowsAgentReleaseConfig().downloadUrl).toBeNull();
    vi.stubEnv("VITE_WINDOWS_AGENT_SHA256", "a".repeat(64));
    vi.stubEnv("VITE_WINDOWS_AGENT_VERSION", "2.1.0");
    expect(getWindowsAgentReleaseConfig()).toMatchObject({
      isLive: true,
      sha256: "a".repeat(64),
      fileName: "PrintGo-Setup.exe",
      version: "2.1.0",
    });
  });
  it.each([
    "http://example.test/setup.exe",
    "https://secret@example.test/setup.exe",
    "disabled",
  ])("rejects unsafe or disabled URL %s", (url) => {
    vi.stubEnv("VITE_WINDOWS_AGENT_DOWNLOAD_URL", url);
    vi.stubEnv("VITE_WINDOWS_AGENT_SHA256", "a".repeat(64));
    vi.stubEnv("VITE_WINDOWS_AGENT_VERSION", "2.1.0");
    expect(getWindowsAgentReleaseConfig().isLive).toBe(false);
  });
});

it("connection link carries the exact shop origin without credentials", () => {
  const link = buildAgentConnectionUrl(
    "ABCD-EFGH",
    "https://shop-api.example.test",
  );
  expect(new URL(link!).searchParams.get("server")).toBe(
    "https://shop-api.example.test",
  );
  expect(new URL(link!).searchParams.get("code")).toBe("ABCD-EFGH");
  expect(
    buildAgentConnectionUrl("ABCD-EFGH", "https://secret@example.test"),
  ).toBeNull();
  expect(
    buildAgentConnectionUrl("ABCD-EFGH", "http://example.test"),
  ).toBeNull();
});
