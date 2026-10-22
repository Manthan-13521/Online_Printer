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

export interface TrackingPageProps {
  jobCode: string;
  onBack?: (() => void) | undefined;
  shopPhone?: string | undefined;
  shopOpeningTime?: string | undefined;
}

export function TrackingPage({
  jobCode,
  onBack,
  shopPhone,
  shopOpeningTime,
}: TrackingPageProps) {
  const [data, setData] = useState<CustomerTrackingData | null>(null);
  const [state, setState] = useState<"loading" | "invalid" | "network">(
    "loading",
  );
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
          margin: "0.75rem auto 1rem",
          padding: "0.85rem 1.15rem",
          background: "#fffdf5",
          border: "1.5px solid #fde68a",
          borderRadius: "12px",
          color: "#78350f",
          boxShadow: "0 2px 8px rgba(180, 83, 9, 0.08)",
          textAlign: "left",
          maxWidth: "500px",
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
        <div
          className="callout-pointer-tail"
          style={{
            position: "absolute",
            bottom: "-8px",
            left: "50%",
            transform: "translateX(-50%)",
            width: 0,
            height: 0,
            borderLeft: "8px solid transparent",
            borderRight: "8px solid transparent",
            borderTop: "8px solid #fde68a",
          }}
        />
      </div>
    );
  };

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
          {renderPickupCallout()}
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
      {renderPickupCallout()}
      {state === "network" && (
        <p role="alert">
          Status could not be refreshed. Showing the last known update.
        </p>
      )}
    </TrackJourney>
  );
}
