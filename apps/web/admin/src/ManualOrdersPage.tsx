import type {
  AdminCashOrder,
  AdminManualOrder,
  OrderAddonServiceSnapshot,
} from "@printgo/api-contract";
import { useEffect, useRef, useState } from "react";
import { Pagination } from "./Pagination";
import { adminApi, AdminApiError, friendlyAdminError } from "./api";
import { useAdminWebSocket } from "./useAdminWebSocket";

function formatPaise(paise: number): string {
  return `₹${(paise / 100).toFixed(2)}`;
}

function getInitials(name?: string | null): string {
  if (!name || !name.trim()) return "C";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

function AddonBadge({ snapshot }: { snapshot: OrderAddonServiceSnapshot }) {
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

function CashEmptyState() {
  return (
    <div className="orders-empty-state-card green-empty-state">
      <div className="empty-state-illustration" aria-hidden="true">
        <svg width="76" height="76" viewBox="0 0 100 100" fill="none">
          {/* Sparkles */}
          <path
            d="M50 10 L50 18 M30 18 L36 24 M70 18 L64 24"
            stroke="#f59e0b"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
          {/* Register base */}
          <rect
            x="24"
            y="56"
            width="52"
            height="26"
            rx="4"
            fill="#e2e8f0"
            stroke="#94a3b8"
            strokeWidth="2"
          />
          <line
            x1="28"
            y1="68"
            x2="72"
            y2="68"
            stroke="#94a3b8"
            strokeWidth="2"
          />
          {/* Display screen */}
          <rect
            x="30"
            y="30"
            width="40"
            height="26"
            rx="4"
            fill="#cbd5e1"
            stroke="#94a3b8"
            strokeWidth="2"
          />
          <rect x="35" y="35" width="30" height="14" rx="2" fill="#0f172a" />
          <rect x="39" y="40" width="14" height="4" rx="1" fill="#22c55e" />
          {/* Keypad dots */}
          <circle cx="36" cy="62" r="2" fill="#64748b" />
          <circle cx="44" cy="62" r="2" fill="#64748b" />
          <circle cx="52" cy="62" r="2" fill="#64748b" />
          <circle cx="60" cy="62" r="2" fill="#64748b" />
          {/* Drawer handle */}
          <rect x="44" y="74" width="12" height="3" rx="1.5" fill="#64748b" />
        </svg>
      </div>
      <h3 className="empty-state-heading">No more pending cash orders!</h3>
      <p className="empty-state-subtext">
        All cash orders have been confirmed.
        <br />
        New counter orders will appear here in real time.
      </p>
    </div>
  );
}

function ManualEmptyState() {
  return (
    <div className="orders-empty-state-card blue-empty-state">
      <div className="empty-state-illustration" aria-hidden="true">
        <svg width="76" height="76" viewBox="0 0 100 100" fill="none">
          {/* Sparkles */}
          <path
            d="M50 10 L50 18 M30 18 L36 24 M70 18 L64 24"
            stroke="#f59e0b"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
          {/* Paper sheet */}
          <rect
            x="36"
            y="20"
            width="28"
            height="26"
            rx="2"
            fill="#ffffff"
            stroke="#94a3b8"
            strokeWidth="2"
          />
          <line
            x1="42"
            y1="26"
            x2="58"
            y2="26"
            stroke="#cbd5e1"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <line
            x1="42"
            y1="32"
            x2="54"
            y2="32"
            stroke="#cbd5e1"
            strokeWidth="2"
            strokeLinecap="round"
          />
          {/* Printer body */}
          <rect
            x="22"
            y="42"
            width="56"
            height="32"
            rx="6"
            fill="#e2e8f0"
            stroke="#94a3b8"
            strokeWidth="2"
          />
          {/* Output tray */}
          <rect
            x="32"
            y="62"
            width="36"
            height="18"
            rx="2"
            fill="#cbd5e1"
            stroke="#94a3b8"
            strokeWidth="2"
          />
          {/* Status light */}
          <circle cx="70" cy="50" r="2.5" fill="#3b82f6" />
        </svg>
      </div>
      <h3 className="empty-state-heading">No manual or finishing orders</h3>
      <p className="empty-state-subtext">
        All manual and finishing orders have been completed.
        <br />
        New orders will appear here in real time.
      </p>
    </div>
  );
}

function CashOrderCard({
  order,
  nowMs,
  onConfirm,
}: {
  order: AdminCashOrder;
  nowMs: number;
  onConfirm: (order: AdminCashOrder) => void;
}) {
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
}

function ManualOrderCard({
  order,
  onAction,
  onFinished,
  onSessionExpired,
}: {
  order: AdminManualOrder;
  onAction: () => void;
  onFinished?: (orderId: string) => void;
  onSessionExpired: (message: string) => void;
}) {
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
}

export function ManualOrdersPage({
  onSessionExpired,
}: {
  onSessionExpired: (message: string) => void;
}) {
  const [orders, setOrders] = useState<AdminManualOrder[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const PAGE_SIZE = 10;

  const [cashOrders, setCashOrders] = useState<AdminCashOrder[]>([]);
  const [cashLoading, setCashLoading] = useState(false);
  const [cashError, setCashError] = useState<string | null>(null);
  const [confirmingCashOrder, setConfirmingCashOrder] =
    useState<AdminCashOrder | null>(null);
  const [confirmCashBusy, setConfirmCashBusy] = useState(false);
  const [confirmCashError, setConfirmCashError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(Date.now());
  const [lastRefreshedAt, setLastRefreshedAt] = useState(Date.now());
  const [relativeTime, setRelativeTime] = useState("just now");

  // 1-second ticker for smooth countdown with ZERO network calls
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Format relative time since last refresh
  useEffect(() => {
    const timer = setInterval(() => {
      const diffSec = Math.floor((Date.now() - lastRefreshedAt) / 1000);
      if (diffSec < 15) {
        setRelativeTime("just now");
      } else if (diffSec < 60) {
        setRelativeTime(`${diffSec}s ago`);
      } else {
        const mins = Math.floor(diffSec / 60);
        setRelativeTime(`${mins}m ago`);
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [lastRefreshedAt]);

  async function loadCash() {
    setCashLoading(true);
    setCashError(null);
    try {
      const response = await adminApi.getCashOrders();
      if (response.ok) {
        setCashOrders(response.data.orders);
        setLastRefreshedAt(Date.now());
        setRelativeTime("just now");
      }
    } catch (caught: unknown) {
      if (caught instanceof AdminApiError && caught.status === 401) {
        onSessionExpired("Your session has expired. Please sign in again.");
        return;
      }
      setCashError(friendlyAdminError(caught));
    } finally {
      setCashLoading(false);
    }
  }

  async function load(next?: string) {
    setLoading(true);
    setError(null);
    try {
      const response = await adminApi.getManualOrders(next);
      if (response.ok) {
        setOrders((current) =>
          next ? [...current, ...response.data.orders] : response.data.orders,
        );
        setCursor(response.data.nextCursor);
        setLastRefreshedAt(Date.now());
        setRelativeTime("just now");
      }
    } catch (caught: unknown) {
      if (caught instanceof AdminApiError && caught.status === 401) {
        onSessionExpired("Your session has expired. Please sign in again.");
        return;
      }
      setError(friendlyAdminError(caught));
    } finally {
      setLoading(false);
    }
  }

  async function refreshAll() {
    await Promise.all([loadCash(), load()]);
  }

  useAdminWebSocket(() => {
    void loadCash();
    void load();
  });

  // Event-driven initial fetch + 90s fallback
  useEffect(() => {
    void loadCash();
    void load();

    const fallbackTimer = setInterval(() => {
      if (!document.hidden) {
        void loadCash();
        void load();
      }
    }, 90_000);

    return () => {
      clearInterval(fallbackTimer);
    };
  }, []);

  async function handleConfirmCash() {
    if (!confirmingCashOrder || confirmCashBusy) return;
    setConfirmCashBusy(true);
    setConfirmCashError(null);
    try {
      const response = await adminApi.confirmCashPayment(
        confirmingCashOrder.orderId,
      );
      if (response.ok) {
        setConfirmingCashOrder(null);
        await Promise.all([loadCash(), load()]);
      }
    } catch (caught: unknown) {
      if (caught instanceof AdminApiError && caught.status === 401) {
        onSessionExpired("Your session has expired. Please sign in again.");
        return;
      }
      setConfirmCashError(friendlyAdminError(caught));
    } finally {
      setConfirmCashBusy(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(orders.length / PAGE_SIZE));

  async function handlePageChange(newPage: number) {
    if (newPage > totalPages && cursor) {
      await load(cursor);
      setCurrentPage(newPage);
    } else {
      setCurrentPage(newPage);
    }
  }

  const paginatedOrders = orders.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  );

  if (loading && orders.length === 0 && cashOrders.length === 0) {
    return (
      <div className="panel page-loading" aria-busy="true">
        Loading orders…
      </div>
    );
  }

  const activeCashOrders = cashOrders.filter(
    (order) => nowMs < order.cashGraceUntilMs,
  );

  const isRefreshing = loading || cashLoading;

  return (
    <div className="page-stack">
      {/* ── Page Header ── */}
      <div className="orders-page-header">
        <div className="orders-header-titles">
          <p className="orders-header-eyebrow">SHOP STAFF</p>
          <h1 className="orders-header-main-title">Cash &amp; Manual Orders</h1>
          <p className="orders-header-subtitle">
            Confirm cash payments received at the counter and process orders
            requiring manual printing or finishing.
          </p>
        </div>
        <div className="orders-header-controls">
          <button
            className="refresh-all-button"
            type="button"
            onClick={() => void refreshAll()}
            disabled={isRefreshing}
          >
            <svg
              className={isRefreshing ? "spin-icon" : ""}
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
            {isRefreshing ? "Refreshing…" : "Refresh all"}
          </button>
          <span className="last-updated-text">Last updated {relativeTime}</span>
        </div>
      </div>

      {/* Confirmation Modal */}
      {confirmingCashOrder ? (
        <div className="dialog-backdrop">
          <section
            aria-labelledby="confirm-cash-dialog-title"
            aria-modal="true"
            className="confirm-dialog"
            role="dialog"
          >
            <h2 id="confirm-cash-dialog-title" style={{ marginTop: 0 }}>
              Confirm Cash Payment
            </h2>
            <p>
              Confirm receipt of{" "}
              <strong style={{ color: "#166534" }}>
                {formatPaise(confirmingCashOrder.payableAmountPaise)}
              </strong>{" "}
              for order{" "}
              <strong>
                {confirmingCashOrder.publicJobCode ||
                  confirmingCashOrder.orderId.slice(0, 8).toUpperCase()}
              </strong>{" "}
              ({confirmingCashOrder.customerName || "Customer"})?
            </p>
            <p
              className="muted"
              style={{ fontSize: "0.85rem", margin: "0 0 1rem" }}
            >
              Confirming will immediately admit this order into the active print
              queue.
            </p>
            {confirmCashError ? (
              <p className="form-error" style={{ marginBottom: "1rem" }}>
                {confirmCashError}
              </p>
            ) : null}
            <div
              style={{
                display: "flex",
                gap: "0.75rem",
                justifyContent: "flex-end",
              }}
            >
              <button
                className="secondary-button"
                type="button"
                onClick={() => setConfirmingCashOrder(null)}
                disabled={confirmCashBusy}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                type="button"
                onClick={() => void handleConfirmCash()}
                disabled={confirmCashBusy}
                style={{ backgroundColor: "#166534" }}
              >
                {confirmCashBusy ? "Confirming…" : "Yes, Confirm Cash"}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {/* ── Modern Two-Column Layout ── */}
      <div className="cash-manual-two-col">
        {/* Left Column: Manual & Finishing Orders (Blue Theme) */}
        <section className="manual-orders-column column-container blue-column">
          <div className="column-header">
            <div className="column-icon-circle blue-icon-circle">
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <polyline points="6 9 6 2 18 2 18 9" />
                <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                <rect x="6" y="14" width="12" height="8" />
              </svg>
            </div>
            <div className="column-title-box">
              <div className="column-title-row">
                <h2 className="column-main-heading">
                  Manual / Finishing Orders
                </h2>
                <span className="count-badge blue-count-badge">
                  {orders.length}
                </span>
              </div>
              <p className="column-subtext">
                Orders requiring manual printing or staff finishing.
              </p>
            </div>
          </div>

          {error ? (
            <p
              className="form-error"
              role="alert"
              style={{ marginBottom: "1rem" }}
            >
              {error}
            </p>
          ) : null}

          {/* Strict Empty State Condition: Never rendered beneath active orders */}
          {orders.length === 0 ? (
            <ManualEmptyState />
          ) : (
            <>
              <div className="orders-cards-list">
                {paginatedOrders.map((order) => (
                  <ManualOrderCard
                    key={order.orderId}
                    order={order}
                    onAction={() => void load()}
                    onFinished={(id) => {
                      setOrders((prev) => prev.filter((o) => o.orderId !== id));
                    }}
                    onSessionExpired={onSessionExpired}
                  />
                ))}
              </div>

              {orders.length > PAGE_SIZE && (
                <Pagination
                  currentPage={currentPage}
                  totalItems={orders.length}
                  pageSize={PAGE_SIZE}
                  onPageChange={(p) => void handlePageChange(p)}
                  loading={loading}
                  hasNextPage={Boolean(cursor)}
                  itemLabel="manual orders"
                />
              )}
            </>
          )}
        </section>

        {/* Right Column: Pending Cash Orders (Green Theme) */}
        <section className="cash-orders-column column-container green-column">
          <div className="column-header">
            <div className="column-icon-circle green-icon-circle">
              <span className="rupee-icon" aria-hidden="true">
                ₹
              </span>
            </div>
            <div className="column-title-box">
              <div className="column-title-row">
                <h2 className="column-main-heading">Pending Cash Orders</h2>
                <span className="count-badge green-count-badge">
                  {activeCashOrders.length}
                </span>
              </div>
              <p className="column-subtext">
                Orders waiting for cash payment at counter.
              </p>
            </div>
          </div>

          {cashError ? (
            <p
              className="form-error"
              role="alert"
              style={{ marginBottom: "1rem" }}
            >
              {cashError}
            </p>
          ) : null}

          {/* Strict Empty State Condition: Never rendered beneath active orders */}
          {activeCashOrders.length === 0 ? (
            <CashEmptyState />
          ) : (
            <div className="orders-cards-list">
              {activeCashOrders.map((order) => (
                <CashOrderCard
                  key={order.orderId}
                  order={order}
                  nowMs={nowMs}
                  onConfirm={(o) => {
                    setConfirmCashError(null);
                    setConfirmingCashOrder(o);
                  }}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
