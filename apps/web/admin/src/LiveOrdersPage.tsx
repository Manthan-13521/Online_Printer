import type { AdminLiveOrder } from "@printgo/api-contract";
import { useEffect, useState } from "react";

import { adminApi, AdminApiError, friendlyAdminError } from "./api";

function money(paise: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
  }).format(paise / 100);
}

function summary(order: AdminLiveOrder): string {
  const print = order.printSummary;
  return `${print.paperSize} · ${print.colorMode === "COLOR" ? "Colour" : "B&W"} · ${print.sides === "DOUBLE" ? "Duplex" : "Single-sided"} · ${print.copies} ${print.copies === 1 ? "copy" : "copies"} · pages ${print.selectedPages}`;
}

export function LiveOrdersPage({
  onSessionExpired,
  pollIntervalMs = 20000,
}: {
  onSessionExpired: (message: string) => void;
  pollIntervalMs?: number;
}) {
  const [orders, setOrders] = useState<AdminLiveOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [actionBusyId, setActionBusyId] = useState<string | null>(null);
  const [confirmRetryId, setConfirmRetryId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setInterval> | null = null;

    const fetchOrders = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      void adminApi
        .getLiveOrders()
        .then((response) => {
          if (active && response.ok) setOrders(response.data.orders);
        })
        .catch((caught: unknown) => {
          if (!active) return;
          if (caught instanceof AdminApiError && caught.status === 401) {
            onSessionExpired("Your session has expired. Please sign in again.");
          } else setError(friendlyAdminError(caught));
        });
    };

    fetchOrders();

    const startPolling = () => {
      if (timer) clearInterval(timer);
      timer = setInterval(fetchOrders, pollIntervalMs);
    };

    const stopPolling = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };

    const handleVisibilityChange = () => {
      if (typeof document !== "undefined" && document.hidden) {
        stopPolling();
      } else {
        fetchOrders();
        startPolling();
      }
    };

    if (typeof document === "undefined" || !document.hidden) {
      startPolling();
    }

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }

    return () => {
      active = false;
      stopPolling();
      if (typeof document !== "undefined") {
        document.removeEventListener(
          "visibilitychange",
          handleVisibilityChange,
        );
      }
    };
  }, [onSessionExpired, pollIntervalMs]);

  async function handleDownloadPdf(order: AdminLiveOrder) {
    setActionBusyId(`pdf-${order.orderId}`);
    setError(null);
    try {
      const res = await adminApi.getOrderPdfUrl(order.orderId);
      if (res.ok) {
        window.open(res.data.downloadUrl, "_blank", "noopener,noreferrer");
      }
    } catch (caught: unknown) {
      if (caught instanceof AdminApiError && caught.status === 401) {
        onSessionExpired("Your session has expired. Please sign in again.");
        return;
      }
      setError(friendlyAdminError(caught));
    } finally {
      setActionBusyId(null);
    }
  }

  async function handleManualComplete(order: AdminLiveOrder) {
    setActionBusyId(`complete-${order.orderId}`);
    setError(null);
    setActionNotice(null);
    try {
      const res = await adminApi.manualCompleteOrder(order.orderId);
      if (res.ok) {
        setOrders(
          (prev) =>
            prev?.map((o) =>
              o.orderId === order.orderId ? { ...o, status: "COMPLETED" } : o,
            ) ?? [],
        );
        setActionNotice(`Job ${order.jobCode} marked as completed.`);
      }
    } catch (caught: unknown) {
      if (caught instanceof AdminApiError && caught.status === 401) {
        onSessionExpired("Your session has expired. Please sign in again.");
        return;
      }
      setError(friendlyAdminError(caught));
    } finally {
      setActionBusyId(null);
    }
  }

  async function handleRetry(order: AdminLiveOrder, forceUncertain = false) {
    setActionBusyId(`retry-${order.orderId}`);
    setError(null);
    setActionNotice(null);
    try {
      const res = await adminApi.retryOrder(order.orderId, forceUncertain);
      if (res.ok) {
        setOrders(
          (prev) =>
            prev?.map((o) =>
              o.orderId === order.orderId ? { ...o, status: "QUEUED" } : o,
            ) ?? [],
        );
        setConfirmRetryId(null);
        setActionNotice(
          `Job ${order.jobCode} re-queued. Only unfinished steps will print.`,
        );
      }
    } catch (caught: unknown) {
      if (caught instanceof AdminApiError && caught.status === 401) {
        onSessionExpired("Your session has expired. Please sign in again.");
        return;
      }
      setError(friendlyAdminError(caught));
    } finally {
      setActionBusyId(null);
    }
  }

  return (
    <div className="page-stack">
      <div>
        <p className="eyebrow">Shop operations</p>
        <h1>Live Orders</h1>
        <p className="page-intro">
          Observe paid jobs currently waiting, printing, or needing attention.
        </p>
      </div>
      {actionNotice ? (
        <p className="notice" role="status">
          {actionNotice}
        </p>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {orders === null && !error ? (
        <p className="page-loading">Loading live orders…</p>
      ) : null}
      {orders?.length === 0 ? (
        <section className="panel">
          <h2>No active paid jobs</h2>
          <p className="muted">New verified orders will appear here.</p>
        </section>
      ) : null}
      {orders && orders.length > 0 ? (
        <div className="live-order-list">
          {orders.map((order) => (
            <article className="panel live-order" key={order.orderId}>
              <div className="live-order-heading">
                <div>
                  <p className="eyebrow">{order.jobCode}</p>
                  <h2>{order.customerName}</h2>
                </div>
                <strong className="status-pill">
                  {order.status.replaceAll("_", " ")}
                </strong>
              </div>
              <p>{summary(order)}</p>
              <dl className="live-order-details">
                <div>
                  <dt>Phone</dt>
                  <dd>{order.customerPhone}</dd>
                </div>
                <div>
                  <dt>Paid</dt>
                  <dd>{money(order.amountPaidPaise)}</dd>
                </div>
                <div>
                  <dt>Agent</dt>
                  <dd>{order.agentName ?? "Not assigned"}</dd>
                </div>
                <div>
                  <dt>Printer</dt>
                  <dd>{order.printerName ?? "Not assigned"}</dd>
                </div>
                <div>
                  <dt>Updated</dt>
                  <dd>{new Date(order.updatedAt).toLocaleString()}</dd>
                </div>
              </dl>
              {order.issue ? (
                <p className="order-issue">
                  <strong>Attention:</strong> {order.issue}
                </p>
              ) : null}

              <div
                style={{
                  display: "flex",
                  gap: "0.5rem",
                  flexWrap: "wrap",
                  marginTop: "0.75rem",
                  paddingTop: "0.75rem",
                  borderTop: "1px solid var(--border-color, #e0e0e0)",
                  alignItems: "center",
                }}
              >
                <button
                  type="button"
                  className="secondary-button"
                  disabled={actionBusyId !== null}
                  onClick={() => void handleDownloadPdf(order)}
                >
                  {actionBusyId === `pdf-${order.orderId}`
                    ? "Opening…"
                    : "Download PDF"}
                </button>

                {[
                  "ADMIN_ACTION_REQUIRED",
                  "PRINT_FAILED",
                  "PRINT_BLOCKED",
                  "PRINTING",
                  "SPOOLING",
                  "CLAIMED",
                ].includes(order.status) ? (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={actionBusyId !== null}
                    onClick={() => void handleManualComplete(order)}
                    title="Mark order completed if physically printed and handed to customer"
                  >
                    {actionBusyId === `complete-${order.orderId}`
                      ? "Marking…"
                      : "Mark as Printed"}
                  </button>
                ) : null}

                {[
                  "ADMIN_ACTION_REQUIRED",
                  "PRINT_FAILED",
                  "PRINT_BLOCKED",
                ].includes(order.status) ? (
                  confirmRetryId === order.orderId ? (
                    <div
                      style={{
                        display: "flex",
                        gap: "0.5rem",
                        alignItems: "center",
                        backgroundColor: "#fef3c7",
                        padding: "0.35rem 0.65rem",
                        borderRadius: "6px",
                      }}
                    >
                      <span style={{ fontSize: "0.8rem", color: "#92400e" }}>
                        Check printer output! Confirm retry unprinted pages?
                      </span>
                      <button
                        type="button"
                        className="primary-button"
                        style={{ fontSize: "0.8rem", padding: "0.2rem 0.5rem" }}
                        disabled={actionBusyId !== null}
                        onClick={() => void handleRetry(order, true)}
                      >
                        {actionBusyId === `retry-${order.orderId}`
                          ? "Retrying…"
                          : "Yes, Retry"}
                      </button>
                      <button
                        type="button"
                        className="text-button"
                        style={{ fontSize: "0.8rem" }}
                        onClick={() => setConfirmRetryId(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="primary-button"
                      disabled={actionBusyId !== null}
                      onClick={() => {
                        if (order.status === "ADMIN_ACTION_REQUIRED") {
                          setConfirmRetryId(order.orderId);
                        } else {
                          void handleRetry(order, false);
                        }
                      }}
                      title="Retry printing remaining unfinished steps"
                    >
                      {actionBusyId === `retry-${order.orderId}`
                        ? "Retrying…"
                        : "Retry Print"}
                    </button>
                  )
                ) : null}
              </div>
            </article>
          ))}
        </div>
      ) : null}
    </div>
  );
}
