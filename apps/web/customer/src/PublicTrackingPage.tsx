import { useEffect, useRef, useState } from "react";
import type { PublicOrderTrackingData } from "@printgo/api-contract";
import { customerApi } from "./api";

export function PublicTrackingPage({
  pickupCode,
  onBack,
}: {
  pickupCode: string;
  onBack?: () => void;
}) {
  const [data, setData] = useState<PublicOrderTrackingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const terminalReachedRef = useRef(false);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let busy = false;
    terminalReachedRef.current = false;

    async function fetchTracking() {
      if (typeof document !== "undefined" && document.hidden) return;
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
      timer = setTimeout(() => {
        void fetchTracking();
      }, 15_000);
    }

    void fetchTracking();

    const handleVisibility = () => {
      if (typeof document !== "undefined" && !document.hidden && active) {
        if (!terminalReachedRef.current) {
          void fetchTracking();
        }
      }
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibility);
    }

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibility);
      }
    };
  }, [pickupCode]);

  function handleBack() {
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
          <p style={{ margin: "1rem 0", color: "#64748b" }}>{error}</p>
          <button
            type="button"
            className="primary-button"
            onClick={handleBack}
            style={{ marginTop: "1rem" }}
          >
            Track Another Order
          </button>
        </section>
      </main>
    );
  }

  if (!data) return null;

  return (
    <main className="page-shell tracking-shell">
      <header
        className="hero"
        style={{ textAlign: "center", paddingBottom: "0.5rem" }}
      >
        <p className="eyebrow" style={{ letterSpacing: "1.5px" }}>
          Live Order Tracking
        </p>
        <div style={{ margin: "0.5rem 0 1rem" }}>
          <span
            style={{
              fontSize: "0.9rem",
              color: "#64748b",
              textTransform: "uppercase",
              letterSpacing: "1px",
            }}
          >
            Pickup Code
          </span>
          <h1
            style={{
              fontSize: "3rem",
              letterSpacing: "3px",
              color: "#0e7490",
              margin: "0.2rem 0",
            }}
          >
            {data.pickupCode}
          </h1>
        </div>
      </header>

      <section
        className="step"
        style={{
          borderLeft: "6px solid #0e7490",
          backgroundColor: "#f8fafc",
          marginBottom: "1rem",
        }}
        aria-live="polite"
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "0.5rem",
          }}
        >
          <div>
            <span
              className="muted"
              style={{
                fontSize: "0.85rem",
                textTransform: "uppercase",
                fontWeight: 700,
              }}
            >
              Current Status
            </span>
            <h2
              style={{
                display: "block",
                fontSize: "1.75rem",
                margin: "0.25rem 0",
                color: "#0f172a",
              }}
            >
              {data.statusLabel}
            </h2>
            <p
              style={{
                margin: "0.25rem 0 0",
                color: "#475569",
                fontSize: "0.95rem",
              }}
            >
              {data.statusMessage}
            </p>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            {data.isPriority ? (
              <span
                style={{
                  padding: "0.25rem 0.65rem",
                  borderRadius: "999px",
                  backgroundColor: "#fef3c7",
                  color: "#92400e",
                  fontWeight: 700,
                  fontSize: "0.85rem",
                }}
              >
                ⚡ Priority Queue
              </span>
            ) : null}
            <span
              style={{
                padding: "0.25rem 0.65rem",
                borderRadius: "999px",
                backgroundColor: "#e2e8f0",
                color: "#334155",
                fontWeight: 600,
                fontSize: "0.85rem",
              }}
            >
              {data.status === "READY_FOR_PICKUP" ? "Ready" : "In Progress"}
            </span>
          </div>
        </div>

        {data.totalFiles > 1 ? (
          <div
            style={{
              marginTop: "1rem",
              padding: "0.75rem",
              backgroundColor: "#ffffff",
              borderRadius: "8px",
              border: "1px solid #e2e8f0",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: "0.9rem",
                marginBottom: "0.35rem",
              }}
            >
              <span>Multi-File Progress</span>
              <strong>
                {data.completedFiles} of {data.totalFiles} files completed
              </strong>
            </div>
            <div
              style={{
                width: "100%",
                height: "8px",
                backgroundColor: "#e2e8f0",
                borderRadius: "4px",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${Math.round((data.completedFiles / data.totalFiles) * 100)}%`,
                  height: "100%",
                  backgroundColor: "#0e7490",
                  transition: "width 0.3s ease",
                }}
              />
            </div>
          </div>
        ) : null}

        {data.identificationRequired ? (
          <div
            style={{
              marginTop: "1rem",
              padding: "0.85rem 1rem",
              backgroundColor: "#fef2f2",
              border: "1px solid #fecaca",
              borderRadius: "8px",
              color: "#991b1b",
            }}
          >
            <div
              style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
            >
              <span style={{ fontSize: "1.25rem" }}>🪪</span>
              <strong>Identification Required at Pickup</strong>
            </div>
            <p
              style={{
                margin: "0.35rem 0 0 1.75rem",
                fontSize: "0.85rem",
                color: "#7f1d1d",
              }}
            >
              Please present a valid photo ID (e.g. college ID, driver&apos;s
              license, government ID) when collecting your prints.
            </p>
          </div>
        ) : null}
      </section>

      <section
        className="step"
        style={{ textAlign: "center", padding: "1.5rem" }}
      >
        <p
          className="muted"
          style={{ fontSize: "0.85rem", margin: "0 0 1rem" }}
        >
          🔒 Privacy Notice: For customer privacy, names, uploaded files, and
          pricing amounts are not shown on public tracking. Completed print
          records are permanently deleted 2 hours after finishing.
        </p>
        <button type="button" className="secondary-button" onClick={handleBack}>
          Track Another Order or Upload New
        </button>
      </section>
    </main>
  );
}
