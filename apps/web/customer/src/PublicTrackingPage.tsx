import { useEffect, useRef, useState } from "react";
import type { PublicOrderTrackingData } from "@printgo/api-contract";
import { customerApi } from "./api";
import TrackJourney from "./track-journey/TrackJourney";
import { getFigmaStageIndexPublic } from "./track-journey/TrackViewModel";

export function PublicTrackingPage({
  pickupCode,
  onBack,
}: {
  pickupCode: string;
  onBack?: (() => void) | undefined;
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
      }, 20_000);
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
          <p style={{ margin: "1rem 0", color: "#5E6A63" }}>{error}</p>
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

  const stageIndex = getFigmaStageIndexPublic(data.status);

  if (stageIndex < 0) {
    return (
      <main className="page-shell tracking-shell">
        <section className="tracking-card" role="status">
          <h1>{data.statusLabel}</h1>
          <p>{data.statusMessage}</p>
          <p>Pickup code {data.pickupCode}</p>
        </section>
      </main>
    );
  }

  return (
    <TrackJourney
      currentStageIndex={stageIndex}
      orderDetails={{
        pickupCode: data.pickupCode,
      }}
      onBack={handleBack}
    >
      <h2>{data.statusLabel}</h2>
      <p>{data.statusMessage}</p>
      <p>Pickup code {data.pickupCode}</p>
      {data.totalFiles > 1 && (
        <p>
          {data.completedFiles} of {data.totalFiles} files printed
        </p>
      )}
      {error && (
        <p role="alert">
          Status could not be refreshed. Showing the last known update.
        </p>
      )}
    </TrackJourney>
  );
}
