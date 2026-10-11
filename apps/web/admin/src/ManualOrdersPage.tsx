import type {
  AdminCashOrder,
  AdminManualOrder,
  OrderAddonServiceSnapshot,
} from "@printgo/api-contract";
import { useEffect, useState } from "react";
import { Pagination } from "./Pagination";
import { adminApi, AdminApiError, friendlyAdminError } from "./api";
import { startVisiblePolling } from "../../polling";

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
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              flexWrap: "wrap",
              marginBottom: "0.25rem",
            }}
          >
            <strong
              className="job-code"
              style={{ fontSize: "1.1rem", color: "#166534" }}
            >
              {order.pickupCode ?? order.jobCode}
            </strong>
            {order.isPriority ? (
              <span
                style={{
                  fontWeight: 700,
                  padding: "0.1rem 0.5rem",
                  borderRadius: "4px",
                  backgroundColor: "#fef3c7",
                  color: "#92400e",
                  fontSize: "0.85rem",
                }}
              >
                ⚡ Priority
              </span>
            ) : null}
            <span
              className={`status-badge status-${order.status.toLowerCase().replace(/_/g, "-")}`}
            >
              {isManualPrint ? "Manual Printing" : "Awaiting Finishing"}
            </span>
          </div>
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
        {order.pickupCode ? (
          <div>
            <span className="muted">Pickup code</span>
            <strong>{order.pickupCode}</strong>
          </div>
        ) : null}
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

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  async function loadCash() {
    setCashLoading(true);
    setCashError(null);
    try {
      const response = await adminApi.getCashOrders();
      if (response.ok) {
        setCashOrders(response.data.orders);
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
    return startVisiblePolling(async () => {
      await loadCash();
      await load();
    }, 10_000);
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
        await loadCash();
        await load();
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

  if (loading && orders.length === 0) {
    return (
      <div className="panel page-loading" aria-busy="true">
        Loading manual orders…
      </div>
    );
  }

  const activeCashOrders = cashOrders.filter(
    (order) => nowMs < order.cashGraceUntilMs,
  );

  return (
    <div className="page-stack">
      <div>
        <p className="eyebrow">Shop staff</p>
        <h1>Cash &amp; Manual Orders</h1>
        <p className="page-intro">
          Confirm cash payments received at the counter and process orders
          requiring manual printing or finishing.
        </p>
      </div>

      {/* ── Pending Cash Orders Table ── */}
      <section className="panel">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "1rem",
          }}
        >
          <div>
            <h2 style={{ margin: 0, fontSize: "1.2rem" }}>
              Pending Cash Orders ({activeCashOrders.length})
            </h2>
            <p
              className="muted"
              style={{ margin: "0.25rem 0 0", fontSize: "0.9rem" }}
            >
              Customers waiting at the counter. Confirm payment to release to
              the print queue.
            </p>
          </div>
          <button
            className="secondary-button fit"
            type="button"
            onClick={() => void loadCash()}
            disabled={cashLoading}
          >
            {cashLoading ? "Refreshing…" : "Refresh Cash"}
          </button>
        </div>

        {cashError ? <p className="form-error">{cashError}</p> : null}

        {activeCashOrders.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            No pending cash orders at the counter.
          </p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                textAlign: "left",
              }}
            >
              <thead>
                <tr
                  style={{
                    borderBottom: "2px solid #E1E5E2",
                    fontSize: "0.85rem",
                    color: "#4B5563",
                  }}
                >
                  <th style={{ padding: "0.6rem 0.5rem" }}>Order Ref</th>
                  <th style={{ padding: "0.6rem 0.5rem" }}>Customer</th>
                  <th style={{ padding: "0.6rem 0.5rem" }}>Amount</th>
                  <th style={{ padding: "0.6rem 0.5rem" }}>Time Remaining</th>
                  <th style={{ padding: "0.6rem 0.5rem", textAlign: "right" }}>
                    Action
                  </th>
                </tr>
              </thead>
              <tbody>
                {activeCashOrders.map((order) => {
                  const isGrace = nowMs >= order.cashExpiresAtMs;
                  const targetMs = isGrace
                    ? order.cashGraceUntilMs
                    : order.cashExpiresAtMs;
                  const secRemaining = Math.max(
                    0,
                    Math.floor((targetMs - nowMs) / 1000),
                  );
                  const mins = Math.floor(secRemaining / 60);
                  const secs = secRemaining % 60;
                  const countdownStr = `${mins}m ${secs.toString().padStart(2, "0")}s`;

                  return (
                    <tr
                      key={order.orderId}
                      style={{ borderBottom: "1px solid #F3F4F6" }}
                    >
                      <td
                        style={{
                          padding: "0.75rem 0.5rem",
                          fontWeight: "bold",
                        }}
                      >
                        {order.publicJobCode ||
                          order.orderId.slice(0, 8).toUpperCase()}
                      </td>
                      <td style={{ padding: "0.75rem 0.5rem" }}>
                        <div>{order.customerName}</div>
                        <div className="muted" style={{ fontSize: "0.8rem" }}>
                          {order.customerPhone}
                        </div>
                      </td>
                      <td
                        style={{
                          padding: "0.75rem 0.5rem",
                          fontWeight: "bold",
                        }}
                      >
                        {formatPaise(order.payableAmountPaise)}
                      </td>
                      <td style={{ padding: "0.75rem 0.5rem" }}>
                        {isGrace ? (
                          <span
                            style={{
                              backgroundColor: "#FEF3C7",
                              color: "#92400E",
                              padding: "0.2rem 0.5rem",
                              borderRadius: "4px",
                              fontSize: "0.85rem",
                              fontWeight: "bold",
                            }}
                          >
                            ⚠️ Grace Period ({countdownStr})
                          </span>
                        ) : (
                          <span
                            style={{
                              fontFamily: "monospace",
                              fontSize: "0.95rem",
                            }}
                          >
                            ⏱️ {countdownStr}
                          </span>
                        )}
                      </td>
                      <td
                        style={{
                          padding: "0.75rem 0.5rem",
                          textAlign: "right",
                        }}
                      >
                        <button
                          className="primary-button"
                          style={{
                            padding: "0.4rem 0.75rem",
                            fontSize: "0.85rem",
                          }}
                          type="button"
                          onClick={() => {
                            setConfirmCashError(null);
                            setConfirmingCashOrder(order);
                          }}
                        >
                          Confirm Cash Received
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Confirmation Modal */}
      {confirmingCashOrder ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "rgba(0, 0, 0, 0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
        >
          <div
            className="panel"
            style={{
              maxWidth: "460px",
              width: "90%",
              backgroundColor: "#fff",
              borderRadius: "8px",
              padding: "1.5rem",
              boxShadow: "0 4px 20px rgba(0, 0, 0, 0.15)",
            }}
          >
            <h3 style={{ margin: "0 0 0.75rem", fontSize: "1.2rem" }}>
              Confirm Cash Received
            </h3>
            <p style={{ margin: "0 0 0.5rem" }}>
              Has the customer paid{" "}
              <strong>
                {formatPaise(confirmingCashOrder.payableAmountPaise)}
              </strong>{" "}
              in cash for order{" "}
              <strong>
                {confirmingCashOrder.publicJobCode ||
                  confirmingCashOrder.orderId.slice(0, 8).toUpperCase()}
              </strong>{" "}
              ({confirmingCashOrder.customerName})?
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
              >
                {confirmCashBusy ? "Confirming…" : "Yes, Confirm Cash"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div style={{ marginTop: "1rem" }}>
        <h2>Manual &amp; Finishing Orders</h2>
        <p className="muted" style={{ margin: "0.25rem 0 1rem" }}>
          Orders requiring manual printing or staff finishing.
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
        onClick={() => {
          setCurrentPage(1);
          void load();
        }}
      >
        Refresh Manual Orders
      </button>
      {orders.length === 0 ? (
        <div className="panel">
          <p>No manual orders at this time.</p>
        </div>
      ) : (
        <div className="manual-orders-list">
          {paginatedOrders.map((order) => (
            <ManualOrderCard
              key={order.orderId}
              order={order}
              onAction={() => void load()}
              onSessionExpired={onSessionExpired}
            />
          ))}
        </div>
      )}
      <Pagination
        currentPage={currentPage}
        totalItems={orders.length}
        pageSize={PAGE_SIZE}
        onPageChange={(p) => void handlePageChange(p)}
        loading={loading}
        hasNextPage={Boolean(cursor)}
        itemLabel="manual orders"
      />
    </div>
  );
}
