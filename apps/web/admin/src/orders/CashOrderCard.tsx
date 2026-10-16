import type { AdminCashOrder } from "@printgo/api-contract";
import { memo, useEffect, useRef, useState } from "react";
import { formatPaise, getInitials } from "../utils/formatters";

export interface CashOrderCardProps {
  order: AdminCashOrder;
  nowMs?: number;
  onConfirm: (order: AdminCashOrder) => void;
  onExpired?: () => void;
}

export const CashOrderCard = memo(function CashOrderCard({
  order,
  nowMs: externalNowMs,
  onConfirm,
  onExpired,
}: CashOrderCardProps) {
  const [internalNowMs, setInternalNowMs] = useState(() => Date.now());
  const nowMs = externalNowMs ?? internalNowMs;
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (externalNowMs !== undefined) return;
    const timer = setInterval(() => {
      const current = Date.now();
      setInternalNowMs(current);
      if (current >= order.cashGraceUntilMs) {
        onExpired?.();
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [externalNowMs, order.cashGraceUntilMs, onExpired]);

  useEffect(() => {
    function handleClickOutside(event: globalThis.MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    if (menuOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () =>
        document.removeEventListener("mousedown", handleClickOutside);
    }
    return undefined;
  }, [menuOpen]);

  const isGrace =
    nowMs >= order.cashExpiresAtMs && nowMs < order.cashGraceUntilMs;

  const targetMs = isGrace ? order.cashGraceUntilMs : order.cashExpiresAtMs;
  const diffSec = Math.max(0, Math.floor((targetMs - nowMs) / 1000));
  const mins = Math.floor(diffSec / 60);
  const secs = diffSec % 60;
  const countdownStr = `${mins}:${secs.toString().padStart(2, "0")}`;

  const jobCodeDisplay =
    order.publicJobCode || order.orderId.slice(0, 8).toUpperCase();
  const customerName = order.customerName || "Walk-in Customer";
  const initials = getInitials(customerName);

  const copyText = (text: string, label: string) => {
    void navigator.clipboard?.writeText(text);
    setCopied(label);
    setTimeout(() => {
      setCopied(null);
      setMenuOpen(false);
    }, 1200);
  };

  return (
    <div
      className={`order-card cash-order-card ${isGrace ? "card-grace" : ""}`}
    >
      {/* Top row: Code + Status Badge + Timer */}
      <div className="order-card-header">
        <div className="order-title-group">
          <strong className="order-code-title text-green">
            {jobCodeDisplay}
          </strong>
          <span className="status-pill status-cash-awaiting">
            <span className="status-dot green-dot" aria-hidden="true" />
            AWAITING CASH PAYMENT
          </span>
        </div>
        <div className="order-header-right">
          {isGrace ? (
            <span className="timer-pill timer-grace">
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              Grace: {countdownStr}
            </span>
          ) : (
            <span className="timer-pill timer-normal">
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              {countdownStr}
            </span>
          )}
        </div>
      </div>

      {/* Middle row: Avatar + Customer Details and Cash Amount */}
      <div className="order-card-body">
        <div className="customer-avatar-group">
          <div className="customer-avatar-circle" aria-hidden="true">
            {initials}
          </div>
          <div className="customer-text-meta">
            <span className="customer-primary-name">{customerName}</span>
            {order.customerPhone ? (
              <span className="customer-phone-number">
                {order.customerPhone}
              </span>
            ) : null}
          </div>
        </div>

        <div className="amount-highlight-box">
          <span className="amount-label-caption">CASH TO COLLECT</span>
          <strong className="amount-primary-value text-green">
            {formatPaise(order.payableAmountPaise)}
          </strong>
        </div>
      </div>

      {/* Bottom actions row */}
      <div className="order-card-actions">
        <button
          className="order-btn-primary btn-green"
          type="button"
          onClick={() => onConfirm(order)}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
          Confirm Cash Received
        </button>

        <div className="more-menu-wrapper" ref={menuRef}>
          <button
            className="order-btn-icon"
            type="button"
            aria-label="More actions for this order"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((prev) => !prev)}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="1.5" />
              <circle cx="19" cy="12" r="1.5" />
              <circle cx="5" cy="12" r="1.5" />
            </svg>
          </button>
          {menuOpen ? (
            <div className="dropdown-popover" role="menu">
              <button
                type="button"
                className="dropdown-item"
                role="menuitem"
                onClick={() => copyText(jobCodeDisplay, "code")}
              >
                {copied === "code" ? "✓ Copied!" : "Copy Job Code"}
              </button>
              <button
                type="button"
                className="dropdown-item"
                role="menuitem"
                onClick={() => copyText(order.orderId, "id")}
              >
                {copied === "id" ? "✓ Copied!" : "Copy Order ID"}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
});
