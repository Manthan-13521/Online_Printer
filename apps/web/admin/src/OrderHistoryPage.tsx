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
  const PAGE_SIZE = 10;

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
            <dl className="history-details">
              <dt>Created</dt>
              <dd>{time(order.createdAt)}</dd>
              <dt>Completed</dt>
              <dd>{time(order.completedAt)}</dd>
              <dt>Online paid</dt>
              <dd>{amount(order.onlinePaidPaise)}</dd>
              <dt>Due at pickup</dt>
              <dd>{amount(order.dueAtPickupPaise)}</dd>
              <dt>Add-on services</dt>
              <dd>
                {order.addonServices.length
                  ? order.addonServices
                      .map((service) => service.name)
                      .join(", ")
                  : "None"}
              </dd>
              <dt>Printer used</dt>
              <dd>{order.printerUsed ?? "—"}</dd>
              <dt>Fallback printer</dt>
              <dd>{order.fallbackPrinter ?? "—"}</dd>
              <dt>Attempts</dt>
              <dd>{order.attemptCount}</dd>
              {order.failureHistory.length ? (
                <>
                  <dt>Failure / uncertain history</dt>
                  <dd>
                    {order.failureHistory
                      .map(
                        (failure) =>
                          `${failure.status}${failure.code ? ` (${failure.code})` : ""}${failure.at ? ` · ${time(failure.at)}` : ""}`,
                      )
                      .join("; ")}
                  </dd>
                </>
              ) : null}
            </dl>
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
