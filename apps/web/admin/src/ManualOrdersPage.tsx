import type {
  AdminManualOrder,
  OrderAddonServiceSnapshot,
} from "@printgo/api-contract";
import { useEffect, useState } from "react";
import { adminApi, AdminApiError, friendlyAdminError } from "./api";

function formatPaise(paise: number): string {
  return `₹${(paise / 100).toFixed(2)}`;
}

function AddonBadge({ snapshot }: { snapshot: OrderAddonServiceSnapshot }) {
  return (
    <span className="addon-badge">
      {snapshot.serviceName}
      {snapshot.pricingType === "FIXED_PRICE"
        ? snapshot.onlinePricePaise === 0
          ? " (Free)"
          : ` (+${formatPaise(snapshot.onlinePricePaise)})`
        : " (Staff Priced)"}
    </span>
  );
}

function ManualOrderCard({
  order,
  onAction,
  onSessionExpired,
}: {
  order: AdminManualOrder;
  onAction: () => void;
  onSessionExpired: (message: string) => void;
}) {
  const [acting, setActing] = useState(false);
  const [pickupRupees, setPickupRupees] = useState("");
  const [showPickup, setShowPickup] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const isManualPrint = order.status === "MANUAL_PRINT";
  const isAwaitingFinishing = order.status === "AWAITING_FINISHING";

  return (
    <div className="manual-order-card">
      <div className="manual-order-header">
        <div>
          <strong className="job-code">{order.jobCode}</strong>
          <span
            className={`status-badge status-${order.status.toLowerCase().replace(/_/g, "-")}`}
          >
            {isManualPrint ? "Manual Printing" : "Awaiting Finishing"}
          </span>
        </div>
        <div className="manual-order-meta">
          <span>{order.customerName}</span>
          {order.fileCount > 1 ? (
            <span className="muted">{order.fileCount} files</span>
          ) : null}
        </div>
      </div>

      <div className="manual-order-services">
        {order.addonServices.map((s) => (
          <AddonBadge key={s.serviceId} snapshot={s} />
        ))}
      </div>

      {order.instructions ? (
        <p className="manual-order-instructions">
          <strong>Instructions:</strong> {order.instructions}
        </p>
      ) : null}

      <div className="manual-order-amounts">
        <div>
          <span className="muted">Online paid</span>
          <strong>{formatPaise(order.onlineAmountPaise)}</strong>
        </div>
        {order.hasStaffPriced ? (
          <div>
            <span className="muted">Due at pickup</span>
            <strong>
              {order.dueAtPickupPaise > 0
                ? formatPaise(order.dueAtPickupPaise)
                : "Not yet set"}
            </strong>
          </div>
        ) : null}
        {order.hasStaffPriced && order.dueAtPickupPaise > 0 ? (
          <div>
            <span className="muted">Total order value</span>
            <strong>
              {formatPaise(order.onlineAmountPaise + order.dueAtPickupPaise)}
            </strong>
          </div>
        ) : null}
      </div>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

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
              className="primary-button fit"
              type="button"
              disabled={acting}
              onClick={() => void savePickupCharge()}
            >
              {acting ? "Saving…" : "Save Charge"}
            </button>
            <button
              className="secondary-button fit"
              type="button"
              onClick={() => setShowPickup(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      <div className="manual-order-actions">
        <button
          className="secondary-button fit"
          type="button"
          onClick={() => void downloadPdf()}
        >
          Download PDF{order.fileCount > 1 ? "s" : ""}
        </button>
        {order.hasStaffPriced && !showPickup ? (
          <button
            className="secondary-button fit"
            type="button"
            onClick={() => {
              setPickupRupees(
                order.dueAtPickupPaise > 0
                  ? String(order.dueAtPickupPaise / 100)
                  : "",
              );
              setShowPickup(true);
            }}
          >
            Set Pickup Charge
          </button>
        ) : null}
        {isManualPrint ? (
          <button
            className="primary-button fit"
            type="button"
            disabled={acting}
            onClick={() => void markPrinted()}
          >
            {acting ? "Updating…" : "Mark Printed"}
          </button>
        ) : null}
        {isAwaitingFinishing ? (
          <button
            className="primary-button fit"
            type="button"
            disabled={acting}
            onClick={() => void markFinished()}
          >
            {acting ? "Updating…" : "Mark Finished"}
          </button>
        ) : null}
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const response = await adminApi.getManualOrders();
      if (response.ok) {
        setOrders(response.data.orders);
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

  useEffect(() => {
    void load();
  }, []);

  if (loading) {
    return (
      <div className="panel page-loading" aria-busy="true">
        Loading manual orders…
      </div>
    );
  }

  return (
    <div className="page-stack">
      <div>
        <p className="eyebrow">Shop staff</p>
        <h1>Manual Orders</h1>
        <p className="page-intro">
          Orders requiring manual printing or staff finishing. Download the PDF,
          print it yourself, then mark it as done.
        </p>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <button
        className="secondary-button fit"
        type="button"
        onClick={() => void load()}
      >
        Refresh
      </button>
      {orders.length === 0 ? (
        <div className="panel">
          <p>No manual orders at this time.</p>
        </div>
      ) : (
        <div className="manual-orders-list">
          {orders.map((order) => (
            <ManualOrderCard
              key={order.orderId}
              order={order}
              onAction={() => void load()}
              onSessionExpired={onSessionExpired}
            />
          ))}
        </div>
      )}
    </div>
  );
}
