import { useEffect, useState } from "react";

export interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{
    outcome: "accepted" | "dismissed";
    platform: string;
  }>;
  prompt(): Promise<void>;
}

const DISMISSAL_STORAGE_KEY = "printgo.pwa.customer_dismissed";

export function checkIsStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const isStandaloneMedia = window.matchMedia?.(
    "(display-mode: standalone)",
  ).matches;
  const isNavigatorStandalone = (
    window.navigator as unknown as { standalone?: boolean }
  )?.standalone;
  const isAndroidReferrer =
    typeof document !== "undefined" &&
    document.referrer?.includes("android-app://");
  return Boolean(
    isStandaloneMedia || isNavigatorStandalone || isAndroidReferrer,
  );
}

export function checkIsIos(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return false;
  }
  const ua = navigator.userAgent || "";
  const isIosDevice = /iphone|ipad|ipod/i.test(ua);
  const isIpadOs =
    navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  return isIosDevice || isIpadOs;
}

export function checkIsMobile(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return false;
  }
  const ua = navigator.userAgent || "";
  return (
    /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(ua) ||
    checkIsIos()
  );
}

export function usePwaInstall() {
  const [installPrompt, setInstallPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [isStandalone, setIsStandalone] = useState(checkIsStandalone);
  const [isDismissed, setIsDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISSAL_STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [isIos] = useState(checkIsIos);
  const [isMobile] = useState(checkIsMobile);
  const [isInstalled, setIsInstalled] = useState(checkIsStandalone);

  useEffect(() => {
    if (typeof window === "undefined") return;

    // Check display mode changes (e.g. user installs or launches from home screen)
    const mediaQuery = window.matchMedia?.("(display-mode: standalone)");
    const handleMediaChange = (e: MediaQueryListEvent) => {
      setIsStandalone(e.matches);
      if (e.matches) setIsInstalled(true);
    };

    if (mediaQuery?.addEventListener) {
      mediaQuery.addEventListener("change", handleMediaChange);
    }

    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e as BeforeInstallPromptEvent);
    };

    const handleAppInstalled = () => {
      setIsInstalled(true);
      setInstallPrompt(null);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);

    return () => {
      if (mediaQuery?.removeEventListener) {
        mediaQuery.removeEventListener("change", handleMediaChange);
      }
      window.removeEventListener(
        "beforeinstallprompt",
        handleBeforeInstallPrompt,
      );
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, []);

  const dismissBanner = () => {
    setIsDismissed(true);
    try {
      localStorage.setItem(DISMISSAL_STORAGE_KEY, "true");
    } catch {
      // Gracefully handle storage errors
    }
  };

  const promptInstall = async (): Promise<
    "accepted" | "dismissed" | "unsupported"
  > => {
    if (!installPrompt) return "unsupported";
    try {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      setInstallPrompt(null);
      if (choice.outcome === "accepted") {
        setIsInstalled(true);
      } else {
        dismissBanner();
      }
      return choice.outcome;
    } catch {
      return "unsupported";
    }
  };

  const canInstall = Boolean(installPrompt);
  const showBanner =
    !isStandalone && !isInstalled && !isDismissed && (canInstall || isIos);

  return {
    canInstall,
    isStandalone,
    isInstalled,
    isDismissed,
    isIos,
    isMobile,
    showBanner,
    dismissBanner,
    promptInstall,
  };
}
