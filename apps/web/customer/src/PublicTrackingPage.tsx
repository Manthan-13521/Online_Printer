import { useEffect, useRef, useState } from "react";
import type { PublicOrderTrackingData } from "@printgo/api-contract";
import { customerApi } from "./api";
import TrackJourney from "./track-journey/TrackJourney";
import { getFigmaStageIndexPublic } from "./track-journey/TrackViewModel";
import { TrackOrderStatusSection } from "./components";

export interface PublicTrackingPageProps {
  pickupCode: string;
  onBack?: (() => void) | undefined;
  shopPhone?: string | undefined;
  shopOpeningTime?: string | undefined;
  shopName?: string | undefined;
  onOpenPricing?: (() => void) | undefined;
  trackBoxCode?: string | undefined;
  onTrackBoxCodeChange?: ((code: string) => void) | undefined;
  onTrackSubmit?: ((e: React.FormEvent) => void) | undefined;
}

export function PublicTrackingPage({
  pickupCode,
  onBack,
  shopPhone,
  shopOpeningTime,
  shopName,
  onOpenPricing,
  trackBoxCode,
  onTrackBoxCodeChange,
  onTrackSubmit,
}: PublicTrackingPageProps) {
  const [data, setData] = useState<PublicOrderTrackingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const terminalReachedRef = useRef(false);
  const [contactPhone, setContactPhone] = useState<string | null>(
    shopPhone ?? null,
  );

  useEffect(() => {
    if (!contactPhone && typeof customerApi.config === "function") {
      customerApi
        .config()
        .then((cfg) => {
          if (cfg?.contactPhone) {
            setContactPhone(cfg.contactPhone);
          }
        })
        .catch(() => {});
    }
  }, [contactPhone]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let busy = false;
    terminalReachedRef.current = false;

    async function fetchTracking() {
      if (terminalReachedRef.current || busy || !active) return;
      busy = true;
      try {
        const result = await customerApi.trackPublic(pickupCode);
        if (!active) return;
        setData(result);
        setError(null);
        if (result.status === "READY_FOR_PICKUP") {
          terminalReachedRef.current = true;
          if (timer) clearTimeout(timer);
          return;
        }
        scheduleNext();
      } catch (caught: unknown) {
        if (!active) return;
        const msg = caught instanceof Error ? caught.message : "";
        if (msg === "TRACKING_NOT_FOUND") {
          setError(
            `No active print order found for pickup code "${pickupCode.toUpperCase()}". Orders expire and are deleted 2 hours after completion.`,
          );
          terminalReachedRef.current = true;
        } else if (msg === "RATE_LIMITED") {
          setError(
            "Too many tracking requests. Please wait a minute and try again.",
          );
        } else {
          setError(
            "Could not load tracking information. Please check your connection.",
          );
        }
        scheduleNext();
      } finally {
        busy = false;
        if (active) setLoading(false);
      }
    }

    function scheduleNext() {
      if (!active || terminalReachedRef.current) return;
      if (timer) clearTimeout(timer);
      // Suspend periodic background polling when page is hidden to save D1 reads
      if (typeof document !== "undefined" && document.hidden) return;
      timer = setTimeout(() => {
        void fetchTracking();
      }, 20_000);
    }

    // Initial fetch always executes on mount (even if tab is momentarily hidden during app switch)
    void fetchTracking();

    const handleWakeup = () => {
      if (typeof document !== "undefined" && !document.hidden && active) {
        if (!terminalReachedRef.current && !busy) {
          void fetchTracking();
        }
      }
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleWakeup);
    }
    if (typeof window !== "undefined") {
      window.addEventListener("pageshow", handleWakeup);
      window.addEventListener("focus", handleWakeup);
    }

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleWakeup);
      }
      if (typeof window !== "undefined") {
        window.removeEventListener("pageshow", handleWakeup);
        window.removeEventListener("focus", handleWakeup);
      }
    };
  }, [pickupCode, retryTick]);

  function handleBack() {
    try {
      if (typeof sessionStorage !== "undefined") {
        sessionStorage.removeItem("printgo.customerDraftToken");
        for (let i = sessionStorage.length - 1; i >= 0; i--) {
          const key = sessionStorage.key(i);
          if (
            key &&
            (key.startsWith("printgo.pendingTracking.") ||
              key === "printgo.customerDraftToken")
          ) {
            sessionStorage.removeItem(key);
          }
        }
      }
    } catch {
      // ignore
    }
    if (onBack) {
      onBack();
    } else {
      window.history.pushState(null, "", "/");
      window.location.href = "/";
    }
  }

  if (loading && !data) {
    return (
      <main className="page-shell tracking-shell">
        <section
          className="step"
          style={{ textAlign: "center", padding: "3rem 1.5rem" }}
        >
          <h2>Checking order status…</h2>
          <p className="muted">
            Looking up pickup code <strong>{pickupCode.toUpperCase()}</strong>
          </p>
        </section>
      </main>
    );
  }

  if (error && !data) {
    return (
      <main className="page-shell tracking-shell">
        <section
          className="step"
          style={{ textAlign: "center", padding: "2.5rem 1.5rem" }}
        >
          <h2>Order Not Found</h2>
          <p style={{ margin: "1rem 0", color: "#5E6A63" }}>{error}</p>
          <div
            style={{
              display: "flex",
              gap: "0.75rem",
              justifyContent: "center",
              flexWrap: "wrap",
              marginTop: "1rem",
            }}
          >
            <button
              type="button"
              className="primary-button fit"
              onClick={() => {
                setLoading(true);
                setError(null);
                setRetryTick((t) => t + 1);
              }}
            >
              Retry
            </button>
            <button
              type="button"
              className="secondary-button fit"
              onClick={handleBack}
            >
              Track Another Order
            </button>
          </div>
        </section>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="page-shell tracking-shell">
        <section
          className="step"
          style={{ textAlign: "center", padding: "3rem 1.5rem" }}
        >
          <h2>Loading order details…</h2>
          <p className="muted" style={{ margin: "1rem 0" }}>
            Checking status for pickup code{" "}
            <strong>{pickupCode.toUpperCase()}</strong>…
          </p>
          <div
            style={{
              display: "flex",
              gap: "0.75rem",
              justifyContent: "center",
              flexWrap: "wrap",
              marginTop: "1.25rem",
            }}
          >
            <button
              type="button"
              className="primary-button fit"
              onClick={() => {
                setLoading(true);
                setError(null);
                setRetryTick((t) => t + 1);
              }}
            >
              Retry Status
            </button>
            <button
              type="button"
              className="secondary-button fit"
              onClick={handleBack}
            >
              Back to Home
            </button>
          </div>
        </section>
      </main>
    );
  }

  const pickupTimeDisplay = data?.pickupFormatted
    ? data.pickupFormatted.replace(", from ", " at ")
    : shopOpeningTime
      ? `tomorrow after ${shopOpeningTime}`
      : "tomorrow";

  const renderPickupCallout = () => {
    if (!data?.isPickup) return null;
    return (
      <div
        className="pickup-callout-card"
        style={{
          position: "relative",
          margin: "0.5rem auto",
          padding: "0.65rem 0.95rem",
          background: "#fffdf5",
          border: "1.5px solid #fde68a",
          borderRadius: "12px",
          color: "#78350f",
          boxShadow: "0 2px 8px rgba(180, 83, 9, 0.08)",
          textAlign: "left",
          maxWidth: "480px",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: "0.6rem",
          }}
        >
          <span style={{ fontSize: "1.25rem", lineHeight: 1 }}>🌅</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontWeight: 700,
                fontSize: "0.95rem",
                color: "#78350f",
                lineHeight: 1.35,
              }}
            >
              <span>Pickup: </span>Your order will be ready till{" "}
              <span style={{ fontWeight: 800, color: "#451a03" }}>
                {pickupTimeDisplay}
              </span>
            </div>
            <div
              style={{
                fontSize: "0.825rem",
                color: "#92400e",
                marginTop: "0.35rem",
                lineHeight: 1.4,
                display: "flex",
                alignItems: "center",
                flexWrap: "wrap",
                gap: "0.4rem",
              }}
            >
              <span>If you want to receive today, contact the shop:</span>
              {contactPhone ? (
                <a
                  href={`tel:${contactPhone}`}
                  className="phone-call-btn"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "0.3rem",
                    fontWeight: 700,
                    color: "#166534",
                    background: "#dcfce7",
                    padding: "0.2rem 0.55rem",
                    borderRadius: "6px",
                    textDecoration: "none",
                    fontSize: "0.8rem",
                    border: "1px solid #86efac",
                  }}
                >
                  <span>📞</span> Call {contactPhone}
                </a>
              ) : (
                <span style={{ fontWeight: 600 }}>at the counter</span>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderPickupCodeBadge = (code: string) => {
    return (
      <div
        className="pickup-code-badge-card"
        style={{
          position: "relative",
          margin: "0.45rem auto 0.65rem",
          padding: "0.45rem 0.85rem",
          background: "linear-gradient(135deg, #f0fdf4 0%, #ecfdf5 100%)",
          border: "1.5px solid #86efac",
          borderRadius: "12px",
          boxShadow: "0 2px 8px rgba(22, 101, 52, 0.08)",
          maxWidth: "260px",
          textAlign: "center",
        }}
      >
        <span className="sr-only">Pickup code {code}</span>
        <div
          aria-hidden="true"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            className="pickup-code-display-value"
            style={{
              fontSize: "1.75rem",
              lineHeight: 1.15,
              fontWeight: 800,
              letterSpacing: "0.06em",
              fontFamily:
                'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
              color: "#0f172a",
              margin: "0.1rem 0",
            }}
          >
            {code}
          </div>
          <div
            style={{
              fontSize: "0.75rem",
              fontWeight: 600,
              color: "#15803d",
              textAlign: "center",
              marginTop: "0.15rem",
            }}
          >
            Show this code at the shop counter
          </div>
        </div>
      </div>
    );
  };

  const stageIndex = getFigmaStageIndexPublic(data.status);

  if (stageIndex < 0) {
    return (
      <main className="page-shell tracking-shell">
        <section
          className="tracking-card"
          role="status"
          style={{ textAlign: "center", padding: "2.5rem 1.5rem" }}
        >
          <h1>{data.statusLabel}</h1>
          <p>{data.statusMessage}</p>
          {data.pickupCode && renderPickupCodeBadge(data.pickupCode)}
          {renderPickupCallout()}
          <div
            style={{
              marginTop: "1.5rem",
              display: "flex",
              gap: "0.75rem",
              justifyContent: "center",
              flexWrap: "wrap",
            }}
          >
            <button
              type="button"
              className="secondary-button fit"
              onClick={handleBack}
            >
              Track Another Order
            </button>
            <a
              href="/"
              className="primary-button fit"
              style={{ textDecoration: "none" }}
              onClick={(e) => {
                try {
                  if (typeof sessionStorage !== "undefined") {
                    sessionStorage.removeItem("printgo.customerDraftToken");
                    for (let i = sessionStorage.length - 1; i >= 0; i--) {
                      const key = sessionStorage.key(i);
                      if (
                        key &&
                        (key.startsWith("printgo.pendingTracking.") ||
                          key === "printgo.customerDraftToken")
                      ) {
                        sessionStorage.removeItem(key);
                      }
                    }
                  }
                } catch {
                  // ignore
                }
                if (onBack) {
                  e.preventDefault();
                  onBack();
                }
              }}
            >
              Print a Document
            </a>
          </div>
        </section>
      </main>
    );
  }

  return (
    <TrackJourney
      currentStageIndex={stageIndex}
      orderDetails={{
        pickupCode: data.pickupCode,
        isPickup: Boolean(data.isPickup),
        isPriority: Boolean(
          data.isPriority ||
          data.statusLabel?.toLowerCase().includes("priority"),
        ),
        statusLabel: data.statusLabel,
        statusMessage: data.statusMessage,
      }}
      onBack={handleBack}
    >
      <TrackOrderStatusSection
        orderNumber={data.pickupCode}
        pickupCode={data.pickupCode}
        statusLabel={data.statusLabel}
        statusMessage={data.statusMessage}
        isPriority={Boolean(
          data.isPriority ||
          data.statusLabel?.toLowerCase().includes("priority"),
        )}
        status={data.status}
        shopName={shopName}
        onOpenPricing={onOpenPricing}
        trackBoxCode={trackBoxCode}
        onTrackBoxCodeChange={onTrackBoxCodeChange}
        onTrackSubmit={onTrackSubmit}
        renderPickupCallout={renderPickupCallout}
      />
      {data.totalFiles > 1 && (
        <p className="mt-2 text-center text-xs text-slate-500 font-medium">
          {data.completedFiles} of {data.totalFiles} files printed
        </p>
      )}
      {error && (
        <p
          role="alert"
          style={{
            textAlign: "center",
            marginTop: "0.5rem",
            color: "#b45309",
            fontSize: "0.875rem",
            fontWeight: 500,
          }}
        >
          Status could not be refreshed. Showing the last known update.
        </p>
      )}
    </TrackJourney>
  );
}
