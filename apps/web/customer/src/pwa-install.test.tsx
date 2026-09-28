// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { customerApi } from "./api";
import { PwaInstallBanner } from "./PwaInstallBanner";
import type { BeforeInstallPromptEvent } from "./usePwaInstall";

vi.mock("./api", () => ({
  customerApi: {
    config: vi.fn(),
    createDraft: vi.fn(),
  },
  uploadDirectly: vi.fn(),
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
  Object.defineProperty(event, "platforms", { value: ["web", "android"] });
  Object.defineProperty(event, "prompt", { value: promptMock });
  Object.defineProperty(event, "userChoice", { value: userChoicePromise });

  return { event, promptMock, userChoiceResolve };
}

describe("Customer PWA Installation Banner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    // Default to browser standard desktop, non-standalone
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
    Object.defineProperty(window.navigator, "standalone", {
      writable: true,
      value: false,
    });
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("does not render when browser has not fired beforeinstallprompt and is not iOS", () => {
    const { container } = render(<PwaInstallBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("captures beforeinstallprompt and displays desktop installation banner", () => {
    const { event } = createMockInstallPrompt();
    render(<PwaInstallBanner />);

    fireEvent(window, event);

    expect(screen.getByText("Install PrintGo")).toBeTruthy();
    expect(screen.getByText("Install for faster printing")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Install App" })).toBeTruthy();
  });

  it("captures beforeinstallprompt on Android and displays phone installation banner", () => {
    Object.defineProperty(window.navigator, "userAgent", {
      writable: true,
      value:
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36",
    });

    const { event } = createMockInstallPrompt();
    render(<PwaInstallBanner />);

    fireEvent(window, event);

    expect(screen.getByText("Get PrintGo on your phone")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Install App" })).toBeTruthy();
  });

  it("executes install flow when user accepts installation", async () => {
    const user = userEvent.setup();
    const { event, promptMock, userChoiceResolve } = createMockInstallPrompt();

    render(<PwaInstallBanner />);
    fireEvent(window, event);

    const installBtn = screen.getByRole("button", { name: "Install App" });
    await user.click(installBtn);

    expect(promptMock).toHaveBeenCalledTimes(1);

    userChoiceResolve({ outcome: "accepted", platform: "web" });

    // When accepted, appinstalled or success hides banner
    fireEvent(window, new Event("appinstalled"));
    expect(
      screen.queryByRole("region", { name: "App installation notice" }),
    ).toBeNull();
  });

  it("handles dismissal during native prompt and persists dismissal locally", async () => {
    const user = userEvent.setup();
    const { event, promptMock, userChoiceResolve } = createMockInstallPrompt();

    render(<PwaInstallBanner />);
    fireEvent(window, event);

    const installBtn = screen.getByRole("button", { name: "Install App" });
    await user.click(installBtn);

    expect(promptMock).toHaveBeenCalledTimes(1);

    userChoiceResolve({ outcome: "dismissed", platform: "web" });

    await vi.waitFor(() => {
      expect(localStorage.getItem("printgo.pwa.customer_dismissed")).toBe(
        "true",
      );
    });
  });

  it("persists dismissal locally when user clicks the close button with zero network calls", async () => {
    const user = userEvent.setup();
    const { event } = createMockInstallPrompt();

    render(<PwaInstallBanner />);
    fireEvent(window, event);

    const dismissBtn = screen.getByRole("button", {
      name: "Dismiss app installation banner",
    });
    await user.click(dismissBtn);

    expect(localStorage.getItem("printgo.pwa.customer_dismissed")).toBe("true");
    expect(
      screen.queryByRole("region", { name: "App installation notice" }),
    ).toBeNull();

    // Verify ZERO network requests were generated
    expect(customerApi.config).not.toHaveBeenCalled();
    expect(customerApi.createDraft).not.toHaveBeenCalled();
  });

  it("does not show banner if previously dismissed in localStorage", () => {
    localStorage.setItem("printgo.pwa.customer_dismissed", "true");

    const { event } = createMockInstallPrompt();
    const { container } = render(<PwaInstallBanner />);

    fireEvent(window, event);
    expect(container.firstChild).toBeNull();
  });

  it("does not show banner if already running in standalone display mode", () => {
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

    const { event } = createMockInstallPrompt();
    const { container } = render(<PwaInstallBanner />);

    fireEvent(window, event);
    expect(container.firstChild).toBeNull();
  });

  it("detects iOS devices and displays Add to Home Screen instructions without a fake download button", async () => {
    const user = userEvent.setup();
    Object.defineProperty(window.navigator, "userAgent", {
      writable: true,
      value:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
    });

    render(<PwaInstallBanner />);

    expect(screen.getByText("Add PrintGo to your Home Screen")).toBeTruthy();
    // Does NOT show fake download
    expect(screen.queryByText(/download/i)).toBeNull();

    const guideBtn = screen.getByRole("button", { name: "How to Add" });
    await user.click(guideBtn);

    expect(screen.getByText(/Tap the/i)).toBeTruthy();
    expect(screen.getByText(/Share/i)).toBeTruthy();
    expect(screen.getByText(/Add to Home Screen/i)).toBeTruthy();
  });
});
