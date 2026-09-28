// @vitest-environment jsdom

/* eslint-disable @typescript-eslint/unbound-method -- Vitest inspects method mocks without invoking them. */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { adminApi } from "./api";
import { AdminPwaInstall } from "./AdminPwaInstall";
import { getWindowsAgentReleaseConfig } from "./agent-download";
import { PrinterPage } from "./PrinterPage";
import type { BeforeInstallPromptEvent } from "./usePwaInstall";

vi.mock("./api", () => ({
  adminApi: {
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    getPrinters: vi.fn(),
    createPairCode: vi.fn(),
    togglePrinter: vi.fn(),
    requestTestPrint: vi.fn(),
  },
  AdminApiError: class AdminApiError extends Error {
    constructor(
      public status: number,
      public code: string,
      message: string,
    ) {
      super(message);
    }
  },
  friendlyAdminError: (err: unknown) =>
    err instanceof Error ? err.message : String(err),
}));

function createMockInstallPrompt(): {
  event: BeforeInstallPromptEvent;
  promptMock: ReturnType<typeof vi.fn>;
  userChoiceResolve: (choice: {
    outcome: "accepted" | "dismissed";
    platform: string;
  }) => void;
} {
  const promptMock = vi.fn().mockResolvedValue(undefined);
  let userChoiceResolve: (choice: {
    outcome: "accepted" | "dismissed";
    platform: string;
  }) => void = () => {};

  const userChoicePromise = new Promise<{
    outcome: "accepted" | "dismissed";
    platform: string;
  }>((resolve) => {
    userChoiceResolve = resolve;
  });

  const event = new Event("beforeinstallprompt") as BeforeInstallPromptEvent;
  Object.defineProperty(event, "platforms", { value: ["web"] });
  Object.defineProperty(event, "prompt", { value: promptMock });
  Object.defineProperty(event, "userChoice", { value: userChoicePromise });

  return { event, promptMock, userChoiceResolve };
}

describe("Admin PWA Installation & Windows Agent Download", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    Object.defineProperty(window.navigator, "userAgent", {
      writable: true,
      value:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("does not render Admin PWA install control when browser is unsupported and not iOS", () => {
    const { container } = render(<AdminPwaInstall />);
    expect(container.firstChild).toBeNull();
  });

  it("renders Admin PWA install button when beforeinstallprompt is captured", async () => {
    const user = userEvent.setup();
    const { event, promptMock, userChoiceResolve } = createMockInstallPrompt();

    render(<AdminPwaInstall />);
    fireEvent(window, event);

    expect(screen.getByText("Install PrintGo Admin")).toBeTruthy();
    const installBtn = screen.getByRole("button", { name: "Install App" });
    expect(installBtn).toBeTruthy();

    await user.click(installBtn);
    expect(promptMock).toHaveBeenCalledTimes(1);

    userChoiceResolve({ outcome: "accepted", platform: "web" });
    fireEvent(window, new Event("appinstalled"));

    expect(screen.getByText("✓ Installed")).toBeTruthy();
  });

  it("displays installed badge when running in standalone mode", () => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes("display-mode: standalone"),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

    render(<AdminPwaInstall />);
    expect(screen.getByText("✓ Installed")).toBeTruthy();
    expect(
      screen.getByText("PrintGo Admin is installed on this device."),
    ).toBeTruthy();
  });

  it("renders iOS instructions on iOS devices for Admin app", async () => {
    const user = userEvent.setup();
    Object.defineProperty(window.navigator, "userAgent", {
      writable: true,
      value:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
    });

    render(<AdminPwaInstall />);

    expect(screen.getByText("Install PrintGo Admin")).toBeTruthy();
    const guideBtn = screen.getByRole("button", { name: "How to Install" });
    expect(guideBtn).toBeTruthy();

    await user.click(guideBtn);
    expect(screen.getByText(/Tap the/i)).toBeTruthy();
    expect(screen.getByText(/Add to Home Screen/i)).toBeTruthy();
  });

  it("returns safe unconfigured state from getWindowsAgentReleaseConfig when no URL is set", () => {
    const config = getWindowsAgentReleaseConfig();
    expect(config.fileName).toBe("PrintGo-Agent.exe");
    expect(config.isLive).toBe(false);
    expect(config.downloadUrl).toBeNull();
  });

  it("renders Windows Agent section with build pending state and all 6 setup steps when artifact URL is unconfigured", async () => {
    vi.mocked(adminApi.getPrinters).mockResolvedValueOnce({
      ok: true,
      data: { agents: [] },
    });

    render(<PrinterPage onSessionExpired={vi.fn()} />);

    await vi.waitFor(() => {
      expect(screen.getByText("PrintGo Agent for Windows")).toBeTruthy();
      expect(
        screen.getByText("Connect this computer to your shop printer."),
      ).toBeTruthy();
    });

    // Verify disabled Download button with truthful message
    const downloadBtn = screen.getByRole("button", {
      name: /Download for Windows \(Build Pending\)/i,
    });
    expect((downloadBtn as HTMLButtonElement).disabled).toBe(true);

    // Verify setup steps
    expect(screen.getByText(/Download PrintGo Agent/i)).toBeTruthy();
    expect(screen.getByText(/Install on Windows/i)).toBeTruthy();
    expect(screen.getByText(/Generate & copy pairing code/i)).toBeTruthy();
    expect(screen.getByText(/Enter pairing code in Agent/i)).toBeTruthy();
    expect(screen.getByText(/Select & enable detected printer/i)).toBeTruthy();
    expect(screen.getByText(/Run test print/i)).toBeTruthy();
  });

  it("renders live download link when release URL is configured", async () => {
    vi.mocked(adminApi.getPrinters).mockResolvedValueOnce({
      ok: true,
      data: { agents: [] },
    });

    const envRecord = import.meta.env as Record<string, string>;
    const originalEnv = envRecord.VITE_WINDOWS_AGENT_DOWNLOAD_URL ?? "";
    envRecord.VITE_WINDOWS_AGENT_DOWNLOAD_URL =
      "https://github.com/Manthan-13521/Online_Printer/releases/download/v2.0.0/PrintGo-Agent.exe";

    try {
      render(<PrinterPage onSessionExpired={vi.fn()} />);

      await vi.waitFor(() => {
        const link = screen.getByRole("button", {
          name: /Download for Windows/i,
        });
        expect(link.getAttribute("href")).toBe(
          "https://github.com/Manthan-13521/Online_Printer/releases/download/v2.0.0/PrintGo-Agent.exe",
        );
        expect(link.getAttribute("download")).toBe("PrintGo-Agent.exe");
      });
    } finally {
      envRecord.VITE_WINDOWS_AGENT_DOWNLOAD_URL = originalEnv;
    }
  });
});
