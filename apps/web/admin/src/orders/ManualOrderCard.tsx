import type {
  AdminManualOrder,
  OrderAddonServiceSnapshot,
} from "@printgo/api-contract";
import { memo, useEffect, useRef, useState } from "react";
import { adminApi, AdminApiError, friendlyAdminError } from "../api";
import { formatPaise } from "../utils/formatters";

export function AddonBadge({
  snapshot,
}: {
  snapshot: OrderAddonServiceSnapshot;
}) {
  return (
    <span className="order-service-pill">
      {snapshot.serviceName}
      {snapshot.pricingType === "FIXED_PRICE"
        ? snapshot.onlinePricePaise === 0
          ? " (Free)"
          : ` (+${formatPaise(snapshot.onlinePricePaise)})`
        : " (Staff Priced)"}
    </span>
  );
}

export interface ManualOrderCardProps {
  order: AdminManualOrder;
  onAction: () => void;
  onFinished?: (orderId: string) => void;
  onSessionExpired: (message: string) => void;
}

export const ManualOrderCard = memo(function ManualOrderCard({
  order,
  onAction,
  onFinished,
  onSessionExpired,
}: ManualOrderCardProps) {
  const [acting, setActing] = useState(false);
  const [pickupRupees, setPickupRupees] = useState("");
  const [showPickup, setShowPickup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

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

  async function markPrinted() {
    setActing(true);
    setError(null);
    try {
      await adminApi.markOrderPrinted(order.orderId);
      onAction();
    } catch (caught: unknown) {
      if (caught instanceof AdminApiError && caught.status === 401) {
        onSessionExpired("Your session has expired. Please sign in again.");
        return;
      }
      setError(friendlyAdminError(caught));
    } finally {
      setActing(false);
    }
  }

  async function markFinished() {
    setActing(true);
    setError(null);
    try {
      await adminApi.markOrderFinished(order.orderId);
      onFinished?.(order.orderId);
      onAction();
    } catch (caught: unknown) {
      if (caught instanceof AdminApiError && caught.status === 401) {
        onSessionExpired("Your session has expired. Please sign in again.");
        return;
      }
      setError(friendlyAdminError(caught));
    } finally {
      setActing(false);
    }
  }

  async function savePickupCharge() {
    const rupees = parseFloat(pickupRupees);
    if (isNaN(rupees) || rupees < 0) {
      setError("Enter a valid non-negative amount.");
      return;
    }
    const paise = Math.round(rupees * 100);
    setActing(true);
    setError(null);
    try {
      await adminApi.setPickupCharge(order.orderId, paise);
      setShowPickup(false);
      onAction();
    } catch (caught: unknown) {
      if (caught instanceof AdminApiError && caught.status === 401) {
        onSessionExpired("Your session has expired. Please sign in again.");
        return;
      }
      setError(friendlyAdminError(caught));
    } finally {
      setActing(false);
    }
  }

  async function downloadPdf() {
    try {
      const response = await adminApi.getOrderPdfUrl(order.orderId);
      if (response.ok) {
        window.open(response.data.downloadUrl, "_blank", "noopener");
      }
    } catch (caught: unknown) {
      if (caught instanceof AdminApiError && caught.status === 401) {
        onSessionExpired("Your session has expired. Please sign in again.");
        return;
      }
      setError(friendlyAdminError(caught));
    }
  }

  const copyText = (text: string, label: string) => {
    void navigator.clipboard?.writeText(text);
    setCopied(label);
    setTimeout(() => {
      setCopied(null);
      setMenuOpen(false);
    }, 1200);
  };

  const isManualPrint = order.status === "MANUAL_PRINT";
  const isAwaitingFinishing = order.status === "AWAITING_FINISHING";
  const displayCode = order.pickupCode ?? order.jobCode;

  return (
    <div className="order-card manual-order-card">
      {/* Top row: Code + Status Badge on left, Customer Name + Phone on right (NO MJ avatar) */}
      <div className="order-card-header">
        <div className="order-title-group">
          <strong className="order-code-title text-slate">{displayCode}</strong>
          {order.isPriority ? (
            <span className="priority-pill">⚡ Priority</span>
          ) : null}
          <span
            className={`status-pill ${
              isManualPrint
                ? "status-manual-print"
                : "status-awaiting-finishing"
            }`}
          >
            <span
              className={`status-dot ${isManualPrint ? "cyan-dot" : "indigo-dot"}`}
              aria-hidden="true"
            />
            {isManualPrint ? "MANUAL PRINTING" : "AWAITING FINISHING"}
          </span>
        </div>

        {/* Customer contact top-right without avatar */}
        <div className="manual-customer-top-right">
          <span className="manual-customer-name">{order.customerName}</span>
          {order.customerPhone ? (
            <span className="manual-customer-phone">
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
              </svg>
              {order.customerPhone}
            </span>
          ) : null}
        </div>
      </div>

      {/* Services pills */}
      {order.addonServices.length > 0 ? (
        <div className="manual-services-row">
          {order.addonServices.map((s) => (
            <AddonBadge key={s.serviceId} snapshot={s} />
          ))}
        </div>
      ) : null}

      {/* Custom instructions */}
      {order.instructions ? (
        <div className="manual-instructions-note">
          <strong>Instructions:</strong> {order.instructions}
        </div>
      ) : null}

      {/* 3-column detail grid */}
      <div className="manual-details-grid">
        <div className="manual-detail-col">
          <span className="detail-meta-label">Pickup code</span>
          <strong className="detail-meta-value">
            {order.pickupCode || displayCode}
          </strong>
        </div>
        <div className="manual-detail-col">
          <span className="detail-meta-label">
            {order.paymentMethod === "CASH"
              ? "Cash paid"
              : order.paymentMethod === "ONLINE"
                ? "Online paid"
                : "Paid"}
          </span>
          <strong className="detail-meta-value">
            {formatPaise(order.onlineAmountPaise)}
          </strong>
        </div>
        <div className="manual-detail-col">
          <span className="detail-meta-label">Order type</span>
          <strong className="detail-meta-value">
            {isManualPrint ? "Manual printing" : "Manual finishing"}
          </strong>
        </div>
        {order.hasStaffPriced ? (
          <div className="manual-detail-col">
            <span className="detail-meta-label">Due at pickup</span>
            <strong className="detail-meta-value text-amber">
              {order.dueAtPickupPaise > 0
                ? formatPaise(order.dueAtPickupPaise)
                : "Not yet set"}
            </strong>
          </div>
        ) : null}
      </div>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      {/* Set pickup charge form */}
      {showPickup ? (
        <div className="pickup-charge-form">
          <label htmlFor={`pickup-${order.orderId}`}>
            Additional charge due at pickup (₹)
          </label>
          <div className="money-input">
            <span aria-hidden="true">₹</span>
            <input
              id={`pickup-${order.orderId}`}
              inputMode="decimal"
              value={pickupRupees}
              onChange={(e) => setPickupRupees(e.target.value)}
              placeholder="0.00"
            />
          </div>
          <div className="form-actions">
            <button
              className="order-btn-primary btn-blue fit"
              type="button"
              disabled={acting}
              onClick={() => void savePickupCharge()}
            >
              {acting ? "Saving…" : "Save Charge"}
            </button>
            <button
              className="order-btn-secondary fit"
              type="button"
              onClick={() => setShowPickup(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {/* Bottom actions row */}
      <div className="order-card-actions">
        <button
          className="order-btn-secondary"
          type="button"
          onClick={() => void downloadPdf()}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="12" y1="18" x2="12" y2="12" />
            <line x1="9" y1="15" x2="15" y2="15" />
          </svg>
          Download PDF{order.fileCount > 1 ? "s" : ""}
        </button>

        {isManualPrint ? (
          <button
            className="order-btn-primary btn-blue"
            type="button"
            disabled={acting}
            onClick={() => void markPrinted()}
          >
            <svg
              width="15"
              height="15"
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
            {acting ? "Updating…" : "Mark Printed"}
          </button>
        ) : null}

        {isAwaitingFinishing ? (
          <button
            className="order-btn-primary btn-blue"
            type="button"
            disabled={acting}
            onClick={() => void markFinished()}
          >
            <svg
              width="15"
              height="15"
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
            {acting ? "Updating…" : "Mark Finished"}
          </button>
        ) : null}

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
              {order.hasStaffPriced && !showPickup ? (
                <button
                  type="button"
                  className="dropdown-item"
                  role="menuitem"
                  onClick={() => {
                    setPickupRupees(
                      order.dueAtPickupPaise > 0
                        ? String(order.dueAtPickupPaise / 100)
                        : "",
                    );
                    setShowPickup(true);
                    setMenuOpen(false);
                  }}
                >
                  Set Pickup Charge
                </button>
              ) : null}
              <button
                type="button"
                className="dropdown-item"
                role="menuitem"
                onClick={() => copyText(displayCode, "code")}
              >
                {copied === "code" ? "✓ Copied!" : "Copy Code"}
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
