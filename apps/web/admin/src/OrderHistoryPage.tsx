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
          <article className="manual-order-card" key={order.orderId}>
            <div className="manual-order-header">
              <div>
                <strong>
                  {order.pickupCode
                    ? `Pickup ${order.pickupCode}`
                    : order.purged
                      ? "Privacy cleared"
                      : "No pickup code"}
                </strong>
                <span className="status-badge">
                  {order.status.replaceAll("_", " ")}
                </span>
              </div>
              <span>
                {order.isPriority ? "Priority" : "Normal"} ·{" "}
                {order.isManual ? "Manual" : "Auto"}
              </span>
            </div>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.55rem",
                fontSize: "0.9rem",
                marginTop: "0.25rem",
              }}
            >
              {/* Customer Name & Phone */}
              {(order.customerName || order.customerPhone) && (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                    gap: "0.4rem 1.5rem",
                  }}
                >
                  <div>
                    <span style={{ color: "#5E6A63" }}>Customer: </span>
                    <strong>{order.customerName ?? "—"}</strong>
                  </div>
                  <div>
                    <span style={{ color: "#5E6A63" }}>Phone: </span>
                    <strong>{order.customerPhone ?? "—"}</strong>
                  </div>
                </div>
              )}

              {/* Line 1: Created & Completed in same line */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                  gap: "0.4rem 1.5rem",
                }}
              >
                <div>
                  <span style={{ color: "#5E6A63" }}>Created: </span>
                  <strong>{time(order.createdAt)}</strong>
                </div>
                <div>
                  <span style={{ color: "#5E6A63" }}>Completed: </span>
                  <strong>{time(order.completedAt)}</strong>
                </div>
              </div>

              {/* Line 2: Online paid & Due at pickup in same line */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                  gap: "0.4rem 1.5rem",
                }}
              >
                <div>
                  <span style={{ color: "#5E6A63" }}>Online paid: </span>
                  <strong>{amount(order.onlinePaidPaise)}</strong>
                </div>
                <div>
                  <span style={{ color: "#5E6A63" }}>Due at pickup: </span>
                  <strong>{amount(order.dueAtPickupPaise)}</strong>
                </div>
              </div>

              {/* Line 3: Add-on services */}
              <div>
                <span style={{ color: "#5E6A63" }}>Add-on services: </span>
                <strong>
                  {order.addonServices.length
                    ? order.addonServices
                        .map((service) => service.name)
                        .join(", ")
                    : "None"}
                </strong>
              </div>

              {/* Line 4: Printer used & Fallback printer in same line */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                  gap: "0.4rem 1.5rem",
                }}
              >
                <div>
                  <span style={{ color: "#5E6A63" }}>Printer used: </span>
                  <strong>{order.printerUsed ?? "—"}</strong>
                </div>
                <div>
                  <span style={{ color: "#5E6A63" }}>Fallback printer: </span>
                  <strong>{order.fallbackPrinter ?? "—"}</strong>
                </div>
              </div>

              {/* Line 5: Attempts (left) & Print Again option (right bottom) */}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: "0.75rem",
                  paddingTop: "0.5rem",
                  borderTop: "1px solid #f1f5f9",
                  marginTop: "0.25rem",
                }}
              >
                <div>
                  <span style={{ color: "#5E6A63" }}>Attempts: </span>
                  <strong>{order.attemptCount}</strong>
                </div>

                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.75rem",
                    marginLeft: "auto",
                  }}
                >
                  {orderNotice[order.orderId] ? (
                    <span
                      style={{
                        fontSize: "0.85rem",
                        color: "#16a34a",
                        fontWeight: 600,
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
                      disabled={
                        order.purged || printingOrderId === order.orderId
                      }
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
                </div>
              </div>

              {order.failureHistory.length ? (
                <div
                  style={{
                    fontSize: "0.8rem",
                    color: "#b91c1c",
                    marginTop: "0.25rem",
                  }}
                >
                  <span style={{ color: "#5E6A63" }}>
                    Failure / uncertain history:{" "}
                  </span>
                  <span>
                    {order.failureHistory
                      .map(
                        (failure) =>
                          `${failure.status}${failure.code ? ` (${failure.code})` : ""}${failure.at ? ` · ${time(failure.at)}` : ""}`,
                      )
                      .join("; ")}
                  </span>
                </div>
              ) : null}
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
