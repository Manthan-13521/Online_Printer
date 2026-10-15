import type { AdminOrderHistoryEntry } from "@printgo/api-contract";
import { useEffect, useState } from "react";

import { Pagination } from "./Pagination";
import { adminApi, AdminApiError, friendlyAdminError } from "./api";

function amount(paise: number): string {
  return `₹${(paise / 100).toFixed(2)}`;
}

function time(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

export function OrderHistoryPage({
  onSessionExpired,
}: {
  onSessionExpired: (message: string) => void;
}) {
  const [orders, setOrders] = useState<AdminOrderHistoryEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [printingOrderId, setPrintingOrderId] = useState<string | null>(null);
  const [deletingOrderId, setDeletingOrderId] = useState<string | null>(null);
  const [orderNotice, setOrderNotice] = useState<Record<string, string>>({});
  const PAGE_SIZE = 10;

  async function handlePrintAgain(order: AdminOrderHistoryEntry) {
    if (order.purged) return;
    setPrintingOrderId(order.orderId);
    setError(null);
    try {
      const res = await adminApi.retryOrder(order.orderId, true);
      if (res.ok) {
        setOrderNotice((prev) => ({
          ...prev,
          [order.orderId]: "Queued to print!",
        }));
        setOrders((prev) =>
          prev.map((o) =>
            o.orderId === order.orderId ? { ...o, status: "QUEUED" } : o,
          ),
        );
        setTimeout(() => {
          setOrderNotice((prev) => {
            const next = { ...prev };
            delete next[order.orderId];
            return next;
          });
        }, 5000);
      }
    } catch (caught: unknown) {
      if (caught instanceof AdminApiError && caught.status === 401) {
        onSessionExpired("Your session has expired. Please sign in again.");
        return;
      }
      setError(friendlyAdminError(caught));
    } finally {
      setPrintingOrderId(null);
    }
  }

  async function handleDeleteOrder(order: AdminOrderHistoryEntry) {
    const code = order.pickupCode ?? order.orderId.slice(0, 8);
    const confirmed = window.confirm(
      `Permanently delete order ${code} and its customer files? This cannot be undone.`,
    );
    if (!confirmed) return;
    setDeletingOrderId(order.orderId);
    setError(null);
    try {
      const res = await adminApi.deleteOrder(order.orderId);
      if (res.ok) {
        setOrders((prev) => prev.filter((o) => o.orderId !== order.orderId));
        setOrderNotice((prev) => ({
          ...prev,
          [order.orderId]: `Order ${code} deleted.`,
        }));
      }
    } catch (caught: unknown) {
      if (caught instanceof AdminApiError && caught.status === 401) {
        onSessionExpired("Your session has expired. Please sign in again.");
        return;
      }
      setError(friendlyAdminError(caught));
    } finally {
      setDeletingOrderId(null);
    }
  }

  async function load(next?: string) {
    setLoading(true);
    setError(null);
    try {
      const response = await adminApi.getOrderHistory(next);
      if (!response.ok) return;
      setOrders((current) =>
        next ? [...current, ...response.data.orders] : response.data.orders,
      );
      setCursor(response.data.nextCursor);
      setLoaded(true);
    } catch (caught) {
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

  return (
    <section className="page-content" aria-labelledby="history-title">
      <p className="eyebrow">Orders</p>
      <h1 id="history-title">Order History</h1>
      <p className="muted">
        Operational details appear until privacy cleanup. Older records retain
        only an anonymous accounting summary.
      </p>
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
      {loaded && orders.length === 0 ? <p>No orders yet.</p> : null}
      <div className="history-list">
        {paginatedOrders.map((order) => (
          <article className="panel live-order" key={order.orderId}>
            <div className="live-order-heading">
              <div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.5rem",
                    flexWrap: "wrap",
                  }}
                >
                  <strong
                    style={{
                      margin: 0,
                      fontSize: "1.15rem",
                      fontWeight: 700,
                      color: "#166534",
                      letterSpacing: "0.05em",
                    }}
                  >
                    {order.pickupCode
                      ? `Pickup ${order.pickupCode}`
                      : order.purged
                        ? "Privacy cleared"
                        : `Order #${order.orderId.slice(0, 8)}`}
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
                  {order.isManual ? (
                    <span
                      style={{
                        fontWeight: 600,
                        padding: "0.1rem 0.5rem",
                        borderRadius: "4px",
                        backgroundColor: "#e0e7ff",
                        color: "#3730a3",
                        fontSize: "0.85rem",
                      }}
                    >
                      Manual
                    </span>
                  ) : null}
                </div>
                <h2 style={{ margin: "0.25rem 0 0", fontSize: "1.2rem" }}>
                  {order.customerName ||
                    (order.purged ? "Anonymous" : "Customer")}
                </h2>
              </div>
              <strong
                className="status-pill"
                style={{
                  backgroundColor:
                    order.status === "COMPLETED" || order.status === "PRINTED"
                      ? "#dcfce7"
                      : order.status === "PRINT_FAILED" ||
                          order.status === "NEEDS_ADMIN" ||
                          order.status === "ADMIN_ACTION_REQUIRED"
                        ? "#fee2e2"
                        : order.status === "COMPLETION_UNKNOWN"
                          ? "#fef3c7"
                          : "#e0e7ff",
                  color:
                    order.status === "COMPLETED" || order.status === "PRINTED"
                      ? "#166534"
                      : order.status === "PRINT_FAILED" ||
                          order.status === "NEEDS_ADMIN" ||
                          order.status === "ADMIN_ACTION_REQUIRED"
                        ? "#991b1b"
                        : order.status === "COMPLETION_UNKNOWN"
                          ? "#92400e"
                          : "#3730a3",
                  fontSize: "0.85rem",
                  padding: "0.35rem 0.75rem",
                }}
              >
                {order.status === "COMPLETION_UNKNOWN"
                  ? "Completion Unknown"
                  : order.status === "NEEDS_ADMIN"
                    ? "Needs Admin"
                    : order.status.replaceAll("_", " ")}
              </strong>
            </div>

            <dl
              className="live-order-details"
              style={{
                marginTop: "0.85rem",
                gap: "0.85rem 1.25rem",
              }}
            >
              {order.customerPhone ? (
                <div>
                  <dt style={{ fontSize: "0.86rem" }}>Phone</dt>
                  <dd style={{ fontSize: "1.0rem" }}>{order.customerPhone}</dd>
                </div>
              ) : null}
              <div>
                <dt style={{ fontSize: "0.86rem" }}>Online Paid</dt>
                <dd style={{ fontSize: "1.0rem", fontWeight: 600 }}>
                  {amount(order.onlinePaidPaise)}
                </dd>
              </div>
              {order.dueAtPickupPaise > 0 ? (
                <div>
                  <dt style={{ fontSize: "0.86rem" }}>Due at Pickup</dt>
                  <dd
                    style={{
                      fontSize: "1.0rem",
                      color: "#b91c1c",
                      fontWeight: 600,
                    }}
                  >
                    {amount(order.dueAtPickupPaise)}
                  </dd>
                </div>
              ) : null}
              <div>
                <dt style={{ fontSize: "0.86rem" }}>Created</dt>
                <dd style={{ fontSize: "1.0rem" }}>{time(order.createdAt)}</dd>
              </div>
              {order.completedAt ? (
                <div>
                  <dt style={{ fontSize: "0.86rem" }}>Completed</dt>
                  <dd style={{ fontSize: "1.0rem" }}>
                    {time(order.completedAt)}
                  </dd>
                </div>
              ) : null}
              {order.addonServices && order.addonServices.length > 0 ? (
                <div>
                  <dt style={{ fontSize: "0.86rem" }}>Add-on Services</dt>
                  <dd style={{ fontSize: "1.0rem" }}>
                    {order.addonServices
                      .map((service) => service.name)
                      .join(", ")}
                  </dd>
                </div>
              ) : null}
              {order.printerUsed ? (
                <div>
                  <dt style={{ fontSize: "0.86rem" }}>Printer</dt>
                  <dd style={{ fontSize: "1.0rem" }}>{order.printerUsed}</dd>
                </div>
              ) : null}
              {order.fallbackPrinter ? (
                <div>
                  <dt style={{ fontSize: "0.86rem" }}>Fallback Printer</dt>
                  <dd style={{ fontSize: "1.0rem" }}>
                    {order.fallbackPrinter}
                  </dd>
                </div>
              ) : null}
              {order.attemptCount && order.attemptCount > 0 ? (
                <div>
                  <dt style={{ fontSize: "0.86rem" }}>Attempts</dt>
                  <dd style={{ fontSize: "1.0rem" }}>{order.attemptCount}</dd>
                </div>
              ) : null}
            </dl>

            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                alignItems: "center",
                gap: "0.75rem",
                marginTop: "0.85rem",
                paddingTop: "0.75rem",
                borderTop: "1px solid #f1f5f9",
                flexWrap: "wrap",
              }}
            >
              {orderNotice[order.orderId] ? (
                <span
                  style={{
                    fontSize: "0.9rem",
                    color: "#16a34a",
                    fontWeight: 600,
                    marginRight: "auto",
                  }}
                >
                  {orderNotice[order.orderId]}
                </span>
              ) : null}
              {[
                "COMPLETED",
                "PRINTED",
                "PRINT_FAILED",
                "ADMIN_ACTION_REQUIRED",
                "NEEDS_ADMIN",
                "COMPLETION_UNKNOWN",
              ].includes(order.status) ? (
                <button
                  type="button"
                  className="primary-button compact"
                  disabled={order.purged || printingOrderId === order.orderId}
                  onClick={() => void handlePrintAgain(order)}
                  title={
                    order.purged
                      ? "Document purged according to shop privacy policy."
                      : "Re-queue this order to print again on shop printer."
                  }
                >
                  {printingOrderId === order.orderId
                    ? "Queueing…"
                    : "Print Again"}
                </button>
              ) : null}

              <button
                type="button"
                className="secondary-button compact"
                style={{ color: "#dc2626", borderColor: "#fca5a5" }}
                disabled={deletingOrderId === order.orderId}
                onClick={() => void handleDeleteOrder(order)}
                title="Permanently delete order and associated customer data"
              >
                {deletingOrderId === order.orderId ? "Deleting…" : "Delete"}
              </button>
            </div>
          </article>
        ))}
      </div>
      {loading ? <p role="status">Loading history…</p> : null}
      <Pagination
        currentPage={currentPage}
        totalItems={orders.length}
        pageSize={PAGE_SIZE}
        onPageChange={(p) => void handlePageChange(p)}
        loading={loading}
        hasNextPage={Boolean(cursor)}
        itemLabel="orders"
      />
    </section>
  );
}
