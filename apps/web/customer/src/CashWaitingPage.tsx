import { useEffect, useState } from "react";
import { formatInr } from "@printgo/pricing";
import { startVisiblePolling } from "./utils/polling";
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
        style={{
          margin: "0 0 0.35rem",
          color: "#14532D",
          fontSize: "1.6rem",
          fontWeight: 800,
        }}
      >
        Pay Cash at Counter
      </h2>
      <p
        style={{
          margin: "0 0 1.25rem",
          fontSize: "0.95rem",
          color: "#374151",
          fontWeight: 500,
        }}
      >
        Your document has been prepared for printing.
      </p>

      {/* Soft Light-Green Rectangular Box */}
      <div
        style={{
          backgroundColor: "#F0FDF4",
          border: "1.5px solid #86EFAC",
          borderRadius: "10px",
          padding: "1.25rem",
          marginBottom: "1.25rem",
          textAlign: "center",
        }}
      >
        <div style={{ marginBottom: "1rem" }}>
          <span
            style={{
              fontSize: "0.85rem",
              color: "#166534",
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            Order Reference
          </span>
          <div
            style={{
              fontSize: "1.85rem",
              fontWeight: 800,
              color: "#14532D",
              letterSpacing: "0.06em",
              fontFamily: "monospace",
              marginTop: "0.2rem",
            }}
          >
            {orderReference}
          </div>
        </div>

        <div style={{ marginBottom: "1.25rem" }}>
          <span
            style={{
              fontSize: "0.85rem",
              color: "#166534",
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            Amount Due
          </span>
          <div
            style={{
              fontSize: "2.1rem",
              fontWeight: 800,
              color: "#15803D",
              marginTop: "0.15rem",
            }}
          >
            {formatInr(payableAmountPaise)}
          </div>
        </div>

        {/* Countdown */}
        {isFullyExpired ? (
          <div
            style={{
              backgroundColor: "#FEE2E2",
              border: "1px solid #FCA5A5",
              color: "#991B1B",
              padding: "0.85rem 1rem",
              borderRadius: "8px",
              fontSize: "0.95rem",
              textAlign: "left",
            }}
            role="alert"
          >
            <div
              style={{
                fontWeight: 800,
                fontSize: "1rem",
                marginBottom: "0.3rem",
              }}
            >
              ⏳ Cash Payment Window Expired
            </div>
            <div
              style={{
                fontSize: "0.88rem",
                lineHeight: "1.4",
                color: "#7F1D1D",
              }}
            >
              The 10-minute waiting window and 2-minute staff grace period have
              passed. Unconfirmed cash slots are automatically released to
              prevent queue buildup.
            </div>
            <div
              style={{
                fontSize: "0.85rem",
                marginTop: "0.4rem",
                color: "#991B1B",
              }}
            >
              Your uploaded document and print settings are saved so you can
              review and try again or pay online.
            </div>
          </div>
        ) : isGrace ? (
          <div
            style={{
              backgroundColor: "#FEF3C7",
              color: "#92400E",
              padding: "0.6rem 0.75rem",
              borderRadius: "6px",
              fontSize: "0.95rem",
              fontWeight: 700,
            }}
          >
            ⚠️ Staff grace period: <strong>{countdownText}</strong>
          </div>
        ) : (
          <div
            style={{
              backgroundColor: "#DCFCE7",
              border: "1px solid #BBF7D0",
              color: "#14532D",
              padding: "0.6rem 0.75rem",
              borderRadius: "6px",
            }}
          >
            <div
              style={{
                fontSize: "0.8rem",
                fontWeight: 600,
                marginBottom: "0.15rem",
                textTransform: "uppercase",
                letterSpacing: "0.04em",
              }}
            >
              Time Remaining at Counter
            </div>
            <div
              style={{
                fontSize: "1.85rem",
                fontWeight: 800,
                fontFamily: "monospace",
                letterSpacing: "0.05em",
              }}
            >
              ⏱️ {countdownText}
            </div>
          </div>
        )}

        <div
          style={{
            marginTop: "1rem",
            paddingTop: "0.75rem",
            borderTop: "1px dashed #86EFAC",
            fontSize: "0.9rem",
            color: "#166534",
            fontWeight: 700,
            lineHeight: "1.4",
          }}
        >
          Please show this reference code at the shop counter. Printing starts
          automatically once the shopkeeper confirms cash payment.
        </div>
      </div>

      {/* Pay Online Instead or Review & Retry Option */}
      {isFullyExpired ? (
        <div
          style={{
            borderTop: "1px solid #E5E7EB",
            paddingTop: "1.25rem",
            display: "flex",
            flexDirection: "column",
            gap: "0.65rem",
          }}
        >
          <button
            type="button"
            className="primary-button"
            onClick={onExpired}
            style={{
              width: "100%",
              padding: "0.75rem",
              fontSize: "0.95rem",
              fontWeight: 700,
            }}
          >
            Review &amp; Re-submit Order
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={onPayOnlineInstead}
            style={{
              width: "100%",
              padding: "0.65rem",
              fontSize: "0.9rem",
              fontWeight: 600,
            }}
          >
            🔒 Pay Online Instead ({formatInr(payableAmountPaise)})
          </button>
        </div>
      ) : (
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
