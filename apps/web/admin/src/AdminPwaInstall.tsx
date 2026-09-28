import { useState } from "react";
import { usePwaInstall } from "./usePwaInstall";

export function AdminPwaInstall() {
  const { canInstall, isStandalone, isInstalled, isIos, promptInstall } =
    usePwaInstall();
  const [showIosGuide, setShowIosGuide] = useState(false);
  const [installing, setInstalling] = useState(false);

  // If already installed/standalone, show a quiet installed status badge
  if (isStandalone || isInstalled) {
    return (
      <section className="panel" aria-labelledby="admin-pwa-title">
        <div className="action-row">
          <div>
            <h2 id="admin-pwa-title">PrintGo Admin App</h2>
            <p className="muted">PrintGo Admin is installed on this device.</p>
          </div>
          <span
            style={{
              padding: "0.35rem 0.75rem",
              borderRadius: "999px",
              background: "#dcfce7",
              color: "#166534",
              fontWeight: 600,
              fontSize: "0.85rem",
            }}
          >
            ✓ Installed
          </span>
        </div>
      </section>
    );
  }

  // If not installable and not on iOS, nothing to show
  if (!canInstall && !isIos) {
    return null;
  }

  const handleInstall = async () => {
    if (isIos) {
      setShowIosGuide((prev) => !prev);
      return;
    }
    setInstalling(true);
    try {
      await promptInstall();
    } finally {
      setInstalling(false);
    }
  };

  return (
    <section className="panel" aria-labelledby="admin-pwa-title">
      <div className="action-row">
        <div>
          <h2 id="admin-pwa-title">Install PrintGo Admin</h2>
          <p className="muted">Use PrintGo like an app on this device.</p>
        </div>
        <div>
          {canInstall && !isIos && (
            <button
              type="button"
              className="primary-button fit"
              onClick={() => void handleInstall()}
              disabled={installing}
            >
              {installing ? "Installing…" : "Install App"}
            </button>
          )}
          {isIos && (
            <button
              type="button"
              className="secondary-button fit"
              onClick={() => setShowIosGuide((prev) => !prev)}
              aria-expanded={showIosGuide}
            >
              {showIosGuide ? "Hide Guide" : "How to Install"}
            </button>
          )}
        </div>
      </div>

      {isIos && showIosGuide && (
        <div
          style={{
            marginTop: "1rem",
            padding: "0.75rem 1rem",
            borderRadius: "0.5rem",
            background: "var(--bg-subtle, #f5f5f5)",
            fontSize: "0.9rem",
          }}
          role="status"
        >
          <p style={{ margin: "0.25rem 0" }}>
            1. Tap the <strong>Share</strong> button{" "}
            <span aria-hidden="true">⎋</span> in Safari.
          </p>
          <p style={{ margin: "0.25rem 0" }}>
            2. Scroll down and tap <strong>Add to Home Screen</strong>{" "}
            <span aria-hidden="true">⊞</span>.
          </p>
        </div>
      )}
    </section>
  );
}
