import { useEffect, useRef, useState } from "react";

import type { CustomerTrackingData } from "@printgo/api-contract";
import { formatInr } from "@printgo/pricing";

import { customerApi } from "./api";
import { privateTrackingUrl, trackingStorageKey } from "./tracking-token";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

function printSummary(data: CustomerTrackingData): string {
  const { printSummary: summary } = data;
  const colour = summary.colorMode === "BW" ? "B&W" : "Colour";
  const sides = summary.sides === "SINGLE" ? "Single-sided" : "Double-sided";
  return `${summary.paperSize} • ${colour} • ${sides}`;
}

function retentionMessage(data: CustomerTrackingData): string {
  if (data.fileRetentionStatus === "DELETED") {
    return "Your uploaded PDF has been deleted.";
  }
  if (data.fileRetentionStatus === "DELETION_PENDING") {
    return "Your uploaded PDF is no longer available and is being deleted.";
  }
  return "Your document is temporarily retained for print recovery.";
}

function isTerminalStatus(status: string): boolean {
  return (
    status === "PRINTED" ||
    status === "COMPLETED" ||
    status === "CANCELLED" ||
    status === "PAYMENT_NOT_RECEIVED"
  );
}

export function TrackingPage({ jobCode }: { jobCode: string }) {
  const [token, setToken] = useState<string | null>(null);
  const [data, setData] = useState<CustomerTrackingData | null>(null);
  const [state, setState] = useState<"loading" | "invalid" | "network">(
    "loading",
  );
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const terminalReachedRef = useRef(false);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const mountTime = Date.now();

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
    setToken(stored);
    setState("loading");

    const fetchStatus = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      if (terminalReachedRef.current) return;
      customerApi
        .tracking(jobCode, stored)
        .then((tracking) => {
          if (!active) return;
          setData(tracking);
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
          scheduleNextPoll();
        });
    };

    const scheduleNextPoll = () => {
      if (!active || terminalReachedRef.current) return;
      if (timer) clearTimeout(timer);
      const delayMs = Date.now() - mountTime < 120_000 ? 15_000 : 30_000;
      timer = setTimeout(fetchStatus, delayMs);
    };

    // Initial fetch
    fetchStatus();

    const handleVisibilityChange = () => {
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

  async function copyLink() {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(privateTrackingUrl(jobCode, token));
      setCopyMessage("Private tracking link copied.");
    } catch {
      setCopyMessage("The link could not be copied on this device.");
    }
  }

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

  return (
    <main className="page-shell tracking-shell">
      <header className="tracking-header">
        <p className="eyebrow">PrintGo</p>
        <h1>{data.jobCode}</h1>
        <p>Hi {data.customerName}, here is your print-job status.</p>
      </header>
      <section className="tracking-card current-status" aria-live="polite">
        <span className="status-dot" aria-hidden="true" />
        <div>
          <p className="status-kicker">Payment received</p>
          <h2>{data.statusLabel}</h2>
          <p>{data.statusMessage}</p>
        </div>
      </section>
      <section className="tracking-card">
        <h2>Print summary</h2>
        <p className="summary-line">{printSummary(data)}</p>
        <dl className="tracking-details">
          <div>
            <dt>Pages</dt>
            <dd>{data.printSummary.selectedPages}</dd>
          </div>
          <div>
            <dt>Copies</dt>
            <dd>{data.printSummary.copies}</dd>
          </div>
          <div>
            <dt>Amount paid</dt>
            <dd>{formatInr(data.amountPaidPaise)}</dd>
          </div>
          {data.instructions && (
            <div>
              <dt>Instructions</dt>
              <dd>{data.instructions}</dd>
            </div>
          )}
        </dl>
      </section>
      <section className="tracking-card">
        <h2>Updates</h2>
        <ol className="timeline">
          {data.timeline.map((event) => (
            <li key={`${event.status}-${event.occurredAt}`}>
              <strong>{event.label}</strong>
              <time dateTime={event.occurredAt}>
                {new Date(event.occurredAt).toLocaleString()}
              </time>
            </li>
          ))}
        </ol>
      </section>
      <section className="tracking-card retention-card">
        <h2>Document privacy</h2>
        <p>{retentionMessage(data)}</p>
      </section>
      <section className="tracking-card private-link-card">
        <h2>Keep this private link</h2>
        <p>Anyone with this link can view this print-job status.</p>
        <button type="button" onClick={() => void copyLink()}>
          Copy private tracking link
        </button>
        {copyMessage && <p role="status">{copyMessage}</p>}
      </section>
    </main>
  );
}
