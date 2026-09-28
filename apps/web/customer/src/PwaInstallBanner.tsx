import { useState } from "react";
import { usePwaInstall } from "./usePwaInstall";

export function PwaInstallBanner() {
  const {
    canInstall,
    isIos,
    isMobile,
    showBanner,
    dismissBanner,
    promptInstall,
  } = usePwaInstall();

  const [showIosGuide, setShowIosGuide] = useState(false);
  const [installing, setInstalling] = useState(false);

  if (!showBanner) return null;

  const handleInstallClick = async () => {
    if (isIos) {
      setShowIosGuide((prev) => !prev);
      return;
    }
    if (!canInstall) return;
    setInstalling(true);
    try {
      await promptInstall();
    } finally {
      setInstalling(false);
    }
  };

  const title = isIos
    ? "Add PrintGo to your Home Screen"
    : isMobile
      ? "Get PrintGo on your phone"
      : "Install PrintGo";

  return (
    <aside
      className="pwa-install-banner"
      role="region"
      aria-label="App installation notice"
    >
      <div className="pwa-banner-content">
        <div className="pwa-banner-icon" aria-hidden="true">
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect width="14" height="20" x="5" y="2" rx="2" ry="2" />
            <path d="M12 18h.01" />
          </svg>
        </div>
        <div className="pwa-banner-text">
          <strong className="pwa-banner-title">{title}</strong>
          <span className="pwa-banner-subtitle">
            Install for faster printing
          </span>
        </div>
        <div className="pwa-banner-actions">
          {canInstall && !isIos && (
            <button
              type="button"
              className="pwa-install-btn"
              onClick={() => void handleInstallClick()}
              disabled={installing}
            >
              {installing ? "Installing…" : "Install App"}
            </button>
          )}

          {isIos && (
            <button
              type="button"
              className="pwa-install-btn pwa-ios-btn"
              onClick={() => void handleInstallClick()}
              aria-expanded={showIosGuide}
            >
              {showIosGuide ? "Hide Guide" : "How to Add"}
            </button>
          )}

          <button
            type="button"
            className="pwa-dismiss-btn"
            onClick={dismissBanner}
            aria-label="Dismiss app installation banner"
            title="Dismiss"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {isIos && showIosGuide && (
        <div className="pwa-ios-guide" role="status">
          <p className="pwa-ios-step">
            1. Tap the <strong>Share</strong> button{" "}
            <span aria-hidden="true">⎋</span> in your browser bar.
          </p>
          <p className="pwa-ios-step">
            2. Scroll down and select <strong>Add to Home Screen</strong>{" "}
            <span aria-hidden="true">⊞</span>.
          </p>
        </div>
      )}
    </aside>
  );
}
