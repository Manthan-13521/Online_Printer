import { useEffect, useState } from "react";
import { formatInr } from "@printgo/pricing";
import { startVisiblePolling } from "../../polling";
import { customerApi } from "./api";

export interface CashWaitingPageProps {
  draftToken: string;
  orderId: string;
  publicJobCode: string | null;
  payableAmountPaise: number;
  cashExpiresAtMs: number;
  cashGraceUntilMs: number;
  onPayOnlineInstead: () => void;
  onOrderConfirmed: (trackingCode: string) => void;
  onExpired: () => void;
}

export function CashWaitingPage({
  draftToken,
  orderId,
  publicJobCode,
  payableAmountPaise,
  cashExpiresAtMs,
  cashGraceUntilMs,
  onPayOnlineInstead,
  onOrderConfirmed,
  onExpired,
}: CashWaitingPageProps) {
  const [nowMs, setNowMs] = useState(Date.now());
  const [expired, setExpired] = useState(false);

  // 1-second ticker for smooth countdown display
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      setNowMs(now);
      if (now >= cashGraceUntilMs) {
        setExpired(true);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [cashGraceUntilMs]);

  // Visibility-aware, backoff polling to detect counter confirmation or online capture
  useEffect(() => {
    const stop = startVisiblePolling(async () => {
      try {
        const draftStatus = await customerApi.getDraftStatus(draftToken);
        if (
          draftStatus.status !== "PAYMENT_PENDING" &&
          draftStatus.status !== "UPLOADED"
        ) {
          const trackingCode =
            draftStatus.pickupCode ||
            draftStatus.publicJobCode ||
            draftStatus.orderId;
          onOrderConfirmed(trackingCode);
          return true;
        }
        if (Date.now() >= cashGraceUntilMs) {
          setExpired(true);
          onExpired();
          return true;
        }
        return false;
      } catch {
        return false;
      }
    }, 8_000);

    return stop;
  }, [draftToken, cashGraceUntilMs, onOrderConfirmed, onExpired]);

  const orderReference = publicJobCode || orderId.slice(0, 8).toUpperCase();
  const isGrace = nowMs >= cashExpiresAtMs && nowMs < cashGraceUntilMs;
  const isFullyExpired = expired || nowMs >= cashGraceUntilMs;

  let countdownText = "";
  if (!isFullyExpired) {
    const targetMs = isGrace ? cashGraceUntilMs : cashExpiresAtMs;
    const diffSec = Math.max(0, Math.floor((targetMs - nowMs) / 1000));
    const mins = Math.floor(diffSec / 60);
    const secs = diffSec % 60;
    countdownText = `${mins}:${secs.toString().padStart(2, "0")}`;
  }

  return (
    <div
      className="cash-waiting-container"
      style={{
        maxWidth: "480px",
        margin: "1.5rem auto",
        padding: "1.5rem",
        backgroundColor: "#FFFFFF",
        borderRadius: "12px",
        boxShadow: "0 2px 12px rgba(0, 0, 0, 0.08)",
        border: "1px solid #E1E5E2",
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: "2.5rem", marginBottom: "0.5rem" }}>💵</div>

      <h2
        style={{ margin: "0 0 0.25rem", color: "#166534", fontSize: "1.4rem" }}
      >
        Pay Cash at Counter
      </h2>
      <p
        className="muted"
        style={{ margin: "0 0 1.25rem", fontSize: "0.9rem" }}
      >
        Your documents are ready. Please visit the shop counter to pay.
      </p>

      {/* Order Summary Box */}
      <div
        style={{
          backgroundColor: "#F9FAF9",
          borderRadius: "8px",
          padding: "1rem",
          marginBottom: "1.25rem",
          border: "1px solid #E5E7EB",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginBottom: "0.5rem",
            fontSize: "0.9rem",
          }}
        >
          <span className="muted">Order Reference:</span>
          <span style={{ fontWeight: 700, letterSpacing: "0.05em" }}>
            {orderReference}
          </span>
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: "1.1rem",
            fontWeight: 700,
          }}
        >
          <span>Amount Due:</span>
          <span style={{ color: "#166534" }}>
            {formatInr(payableAmountPaise)}
          </span>
        </div>
      </div>

      {/* Countdown Timer */}
      {isFullyExpired ? (
        <div
          style={{
            backgroundColor: "#FEE2E2",
            color: "#991B1B",
            padding: "0.75rem",
            borderRadius: "8px",
            marginBottom: "1.25rem",
            fontSize: "0.9rem",
            fontWeight: 600,
          }}
        >
          Order Expired. The waiting window has passed.
        </div>
      ) : isGrace ? (
        <div
          style={{
            backgroundColor: "#FEF3C7",
            color: "#92400E",
            padding: "0.75rem",
            borderRadius: "8px",
            marginBottom: "1.25rem",
            fontSize: "0.9rem",
            fontWeight: 600,
          }}
        >
          ⚠️ 10-minute counter window ended.
          <br />
          Staff grace period active: <strong>{countdownText}</strong>
        </div>
      ) : (
        <div
          style={{
            backgroundColor: "#ECFDF5",
            color: "#065F46",
            padding: "0.75rem",
            borderRadius: "8px",
            marginBottom: "1.25rem",
          }}
        >
          <div style={{ fontSize: "0.85rem", marginBottom: "0.2rem" }}>
            Time remaining to pay at counter:
          </div>
          <div
            style={{
              fontSize: "1.75rem",
              fontWeight: 700,
              fontFamily: "monospace",
              letterSpacing: "0.05em",
            }}
          >
            ⏱️ {countdownText}
          </div>
        </div>
      )}

      <p
        style={{
          fontSize: "0.85rem",
          color: "#4B5563",
          lineHeight: "1.5",
          marginBottom: "1.5rem",
        }}
      >
        Printing starts automatically on the shop printer once the shopkeeper
        confirms your payment.
      </p>

      {/* Pay Online Instead Option */}
      {!isFullyExpired && (
        <div
          style={{
            borderTop: "1px solid #E5E7EB",
            paddingTop: "1.25rem",
          }}
        >
          <div
            style={{
              fontSize: "0.85rem",
              color: "#6B7280",
              marginBottom: "0.5rem",
            }}
          >
            Don&apos;t want to wait at the counter?
          </div>
          <button
            type="button"
            className="secondary-button"
            onClick={onPayOnlineInstead}
            style={{
              width: "100%",
              padding: "0.6rem",
              fontSize: "0.9rem",
              fontWeight: 600,
            }}
          >
            🔒 Pay Online Instead ({formatInr(payableAmountPaise)})
          </button>
        </div>
      )}
    </div>
  );
}
