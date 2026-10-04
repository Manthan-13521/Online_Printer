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
          // Schedule next poll: 15s for first 2 minutes, 30s thereafter
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
      const delayMs = Date.now() - mountTime < 120_000 ? 3_000 : 15_000;
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
  }, [jobCode]);

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
        <section className="tracking-card" role="alert">
          <h1>
            {state === "network"
              ? "Could not refresh status"
              : "Tracking link unavailable"}
          </h1>
          <p>
            {state === "network"
              ? "Check your connection and refresh this page."
              : "This private tracking link is invalid or has expired."}
          </p>
        </section>
      </main>
    );
  }

  const stageIndex = getFigmaStageIndex(data.orderStatus);

  if (stageIndex < 0) {
    return (
      <main className="page-shell tracking-shell">
        <section className="tracking-card" role="status">
          <h1>{data.statusLabel}</h1>
          <p>{data.statusMessage}</p>
          <p>Order {data.pickupCode ?? data.jobCode}</p>
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
