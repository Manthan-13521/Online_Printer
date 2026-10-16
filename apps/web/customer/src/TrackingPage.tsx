import { useEffect, useRef, useState } from "react";

import type { CustomerTrackingData } from "@printgo/api-contract";

import { customerApi } from "./api";
import { trackingStorageKey } from "./tracking-token";

import TrackJourney from "./track-journey/TrackJourney";
import { getFigmaStageIndex } from "./track-journey/TrackViewModel";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

function isTerminalStatus(status: string): boolean {
  return (
    status === "COMPLETED" ||
    status === "CANCELLED" ||
    status === "FAILED" ||
    status === "EXPIRED" ||
    status === "PAYMENT_NOT_RECEIVED"
  );
}

export function TrackingPage({
  jobCode,
  onBack,
}: {
  jobCode: string;
  onBack?: (() => void) | undefined;
}) {
  const [data, setData] = useState<CustomerTrackingData | null>(null);
  const [state, setState] = useState<"loading" | "invalid" | "network">(
    "loading",
  );
  const [retryTick, setRetryTick] = useState(0);
  const terminalReachedRef = useRef(false);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const mountTime = Date.now();
    terminalReachedRef.current = false;
    let busy = false;

    const fragment = window.location.hash.slice(1);
    const fragmentToken = TOKEN_PATTERN.test(fragment) ? fragment : null;
    if (fragmentToken) {
      sessionStorage.setItem(trackingStorageKey(jobCode), fragmentToken);
      window.history.replaceState(null, "", window.location.pathname);
    }
    const stored =
      fragmentToken ?? sessionStorage.getItem(trackingStorageKey(jobCode));
    if (!stored || !TOKEN_PATTERN.test(stored)) {
      setState("invalid");
      return;
    }
    setState("loading");

    const fetchStatus = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      if (terminalReachedRef.current || busy || !active) return;
      if (timer) clearTimeout(timer);
      busy = true;
      customerApi
        .tracking(jobCode, stored)
        .then((tracking) => {
          if (!active) return;
          setData(tracking);
          setState("loading");
          if (isTerminalStatus(tracking.orderStatus)) {
            terminalReachedRef.current = true;
            // Stop polling permanently once terminal status is reached
            if (timer) {
              clearTimeout(timer);
              timer = null;
            }
            return;
          }
          // Schedule next poll: 10s for first minute, 30s thereafter
          scheduleNextPoll();
        })
        .catch((caught: unknown) => {
          if (!active) return;
          setState(
            caught instanceof Error && caught.message === "TRACKING_NOT_FOUND"
              ? "invalid"
              : "network",
          );
          if (
            caught instanceof Error &&
            caught.message === "TRACKING_NOT_FOUND"
          )
            terminalReachedRef.current = true;
          scheduleNextPoll();
        })
        .finally(() => {
          busy = false;
        });
    };

    const scheduleNextPoll = () => {
      if (!active || terminalReachedRef.current) return;
      if (timer) clearTimeout(timer);
      const delayMs = Date.now() - mountTime < 60_000 ? 10_000 : 30_000;
      timer = setTimeout(fetchStatus, delayMs);
    };

    // Initial fetch
    fetchStatus();

    const handleVisibilityChange = () => {
      if (timer) clearTimeout(timer);
      if (typeof document !== "undefined" && !document.hidden && active) {
        if (!terminalReachedRef.current) {
          fetchStatus();
        }
      }
    };

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      if (typeof document !== "undefined") {
        document.removeEventListener(
          "visibilitychange",
          handleVisibilityChange,
        );
      }
    };
  }, [jobCode, retryTick]);

  if (!data && state === "loading") {
    return (
      <main className="page-shell tracking-shell">
        <p className="eyebrow">PrintGo</p>
        <section className="tracking-card" aria-live="polite">
          <h1>Loading print status…</h1>
          <p>Please wait while the shop checks your private tracking link.</p>
        </section>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="page-shell tracking-shell">
        <p className="eyebrow">PrintGo</p>
        <section
          className="tracking-card"
          role="alert"
          style={{ textAlign: "center", padding: "2.5rem 1.5rem" }}
        >
          <h1>
            {state === "network"
              ? "Could not refresh status"
              : "Tracking link unavailable"}
          </h1>
          <p style={{ margin: "0.75rem 0 1.5rem" }}>
            {state === "network"
              ? "Check your connection and retry loading status."
              : "This private tracking link is invalid or has expired."}
          </p>
          <div
            style={{
              display: "flex",
              gap: "0.75rem",
              justifyContent: "center",
              flexWrap: "wrap",
            }}
          >
            {state === "network" ? (
              <button
                type="button"
                className="primary-button fit"
                onClick={() => setRetryTick((t) => t + 1)}
              >
                Retry Status
              </button>
            ) : null}
            {onBack ? (
              <button
                type="button"
                className={
                  state === "network"
                    ? "secondary-button fit"
                    : "primary-button fit"
                }
                onClick={onBack}
              >
                Print Another Document
              </button>
            ) : (
              <a
                href="/"
                className={
                  state === "network"
                    ? "secondary-button fit"
                    : "primary-button fit"
                }
                style={{ textDecoration: "none" }}
              >
                Print Another Document
              </a>
            )}
          </div>
        </section>
      </main>
    );
  }

  const stageIndex = getFigmaStageIndex(data.orderStatus);

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
          <p>Order {data.pickupCode ?? data.jobCode}</p>
          <div style={{ marginTop: "1.5rem" }}>
            {onBack ? (
              <button
                type="button"
                className="primary-button fit"
                onClick={onBack}
              >
                Print Another Document
              </button>
            ) : (
              <a
                href="/"
                className="primary-button fit"
                style={{ textDecoration: "none" }}
              >
                Print Another Document
              </a>
            )}
          </div>
        </section>
      </main>
    );
  }

  return (
    <TrackJourney
      currentStageIndex={stageIndex}
      orderDetails={{
        orderNumber: data.pickupCode ?? data.jobCode,
        ...(data.pickupCode ? { pickupCode: data.pickupCode } : {}),
        pages: data.printSummary.selectedPages,
        colorMode: data.printSummary.colorMode === "BW" ? "B&W" : "Color",
        paperSize: data.printSummary.paperSize,
      }}
      onBack={onBack}
    >
      <h2>{data.statusLabel}</h2>
      <p>{data.statusMessage}</p>
      {state === "network" && (
        <p role="alert">
          Status could not be refreshed. Showing the last known update.
        </p>
      )}
    </TrackJourney>
  );
}
