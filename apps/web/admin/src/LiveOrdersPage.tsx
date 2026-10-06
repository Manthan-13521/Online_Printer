import { startVisiblePolling } from "../../polling";
import type { AdminLiveOrder } from "@printgo/api-contract";
import { useEffect, useState } from "react";

import { Pagination } from "./Pagination";
import { SystemStatusPanel } from "./SystemStatusPanel";
import { adminApi, AdminApiError, friendlyAdminError, removeOrderFromQueue } from "./api";

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
  const [currentPage, setCurrentPage] = useState(1);
  const PAGE_SIZE = 10;

  const totalPages = Math.max(1, Math.ceil((orders?.length ?? 0) / PAGE_SIZE));
  useEffect(() => {
    if (orders && currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [orders, totalPages, currentPage]);

  useEffect(() => {
    let active = true;
    let previous = "";
    const stop = startVisiblePolling(async () => {
      try {
        const response = await adminApi.getLiveOrders();
        if (!active || !response.ok) return undefined;
        setOrders(response.data.orders);
        setError(null);
        const snapshot = JSON.stringify(response.data.orders);
        const changed = snapshot !== previous;
        previous = snapshot;
        return changed;
      } catch (caught) {
        if (!active) return undefined;
        if (caught instanceof AdminApiError && caught.status === 401) {
          onSessionExpired("Your session has expired. Please sign in again.");
        } else setError(friendlyAdminError(caught));
      }
      return undefined;
    }, pollIntervalMs);
    return () => {
      active = false;
      stop();
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
    const code = order.pickupCode ?? order.jobCode;
    const reason = window
      .prompt(
        `Confirm every file in ${code} was physically printed. Enter who verified it and how:`,
      )
      ?.trim();
    if (!reason) return;
    setActionBusyId(`complete-${order.orderId}`);
    setError(null);
    setActionNotice(null);
    try {
      const res = await adminApi.manualCompleteOrder(order.orderId, reason);
      if (res.ok) {
        setOrders(
          (prev) =>
            prev?.map((o) =>
              o.orderId === order.orderId
                ? { ...o, status: res.data.status }
                : o,
            ) ?? [],
        );
        setActionNotice(
          res.data.status === "COMPLETED"
            ? `Job ${code} marked as completed.`
            : `Job ${code} is awaiting finishing in Manual Orders.`,
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

  async function handleRetry(order: AdminLiveOrder, forceUncertain = false) {
    const code = order.pickupCode ?? order.jobCode;
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
          `Job ${code} re-queued. Only unfinished steps will print.`,
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
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          flexWrap: "wrap",
          gap: "1rem",
        }}
      >
        <div>
          <p className="eyebrow">Shop operations</p>
          <h1>Live Orders</h1>
          <p className="page-intro">
            Observe paid jobs currently waiting, printing, or needing attention.
          </p>
        </div>
        <SystemStatusPanel onSessionExpired={onSessionExpired} />
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
        <>
          <div className="live-order-list">
            {orders
              .slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)
              .map((order) => (
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
                        {false ? (
                          <span
                            style={{
                              fontWeight: 600,
                              padding: "0.1rem 0.5rem",
                              borderRadius: "4px",
                              backgroundColor: "#fee2e2",
                              color: "#991b1b",
                              fontSize: "0.85rem",
                            }}
                          >
                            🪪 ID Required
                          </span>
                        ) : null}
                      </div>
                      <h2>{order.customerName}</h2>
                    </div>
                    <strong
                      className="status-pill"
                      style={{
                        backgroundColor:
                          order.status === "RETRY_PENDING"
                            ? "#feefe3"
                            : order.status === "NEEDS_ADMIN" ||
                                order.status === "PRINT_FAILED"
                              ? "#fee2e2"
                              : order.status === "PRINT_BLOCKED"
                                ? "#fef3c7"
                                : undefined,
                        color:
                          order.status === "RETRY_PENDING"
                            ? "#b06000"
                            : order.status === "NEEDS_ADMIN" ||
                                order.status === "PRINT_FAILED"
                              ? "#991b1b"
                              : order.status === "PRINT_BLOCKED"
                                ? "#92400e"
                                : undefined,
                      }}
                    >
                      {order.status === "RETRY_PENDING"
                        ? "Retrying"
                        : order.status === "NEEDS_ADMIN"
                          ? "Needs Admin"
                          : order.status === "COMPLETION_UNKNOWN"
                            ? "Completion Unknown"
                            : order.status === "PRINT_BLOCKED"
                              ? "Printer Issue"
                              : order.status.replaceAll("_", " ")}
                    </strong>
                  </div>
                  <p>{summary(order)}</p>
                  <dl className="live-order-details">
                    {order.attemptCount && order.attemptCount > 0 ? (
                      <div>
                        <dt>Attempts</dt>
                        <dd>{order.attemptCount} / 3</dd>
                      </div>
                    ) : null}
                    {order.errorCategory ? (
                      <div>
                        <dt>Error</dt>
                        <dd>{order.rawError ?? order.errorCategory}</dd>
                      </div>
                    ) : null}
                    {order.pickupCode ? (
                      <div>
                        <dt>Pickup Code</dt>
                        <dd>
                          <strong>{order.pickupCode}</strong>
                        </dd>
                      </div>
                    ) : null}
                    <div>
                      <dt>Priority</dt>
                      <dd>{order.isPriority ? "Priority Queue" : "Normal"}</dd>
                    </div>
                    <div>
                      <dt>ID Check</dt>
                      <dd>
                        {false
                          ? "Required at pickup"
                          : "Not required"}
                      </dd>
                    </div>
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
                    {order.status === "QUEUED" && (
                      <button
                        type="button"
                        className="secondary-button"
                        style={{ color: "#991b1b", borderColor: "#fca5a5", backgroundColor: "#fef2f2" }}
                        disabled={actionBusyId !== null}
                        onClick={() => {
  if (window.confirm("Remove this order from the queue?")) {
    setActionBusyId(`remove-${order.orderId}`);
    removeOrderFromQueue(order.orderId)
      .then(() => {
        setOrders(prev => prev?.filter(o => o.orderId !== order.orderId) ?? []);
      })
      .catch((caught) => {
        setError(caught instanceof Error ? caught.message : "Failed to remove");
      })
      .finally(() => {
        setActionBusyId(null);
      });
  }
}}
>
                        {actionBusyId === `remove-${order.orderId}` ? "Removing..." : "Remove from Queue"}
                      </button>
                    )}

                    {["QUEUED", "COMPLETED", "PRINTED"].includes(order.status) && (
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={actionBusyId !== null}
                        onClick={() => void handleDownloadPdf(order)}
                      >
                        {actionBusyId === `pdf-${order.orderId}`
                          ? "Opening…"
                          : "View/Download PDF"}
                      </button>
                    )}

                    {["COMPLETED", "PRINTED", "PRINT_FAILED", "RETRY_PENDING", "NEEDS_ADMIN"].includes(order.status) && (
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
                          <span
                            style={{ fontSize: "0.8rem", color: "#92400e" }}
                          >
                            Print this order again?
                          </span>
                          <button
                            type="button"
                            className="primary-button"
                            style={{
                              fontSize: "0.8rem",
                              padding: "0.2rem 0.5rem",
                            }}
                            disabled={actionBusyId !== null}
                            onClick={() => {
                               setConfirmRetryId(null);
                               void handleRetry(order, false);
                            }}
                          >
                            {actionBusyId === `retry-${order.orderId}`
                              ? "Retrying…"
                              : "Yes, Print Again"}
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
                             setConfirmRetryId(order.orderId);
                          }}
                          title="Print this order again"
                        >
                          {actionBusyId === `retry-${order.orderId}`
                            ? "Retrying…"
                            : "Print Again"}
                        </button>
                      )
                    )}

                    {["ADMIN_ACTION_REQUIRED", "COMPLETION_UNKNOWN"].includes(order.status) && (
                      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", backgroundColor: "#fff7ed", padding: "0.5rem", borderRadius: "4px", border: "1px solid #fdba74" }}>
                        <span style={{ fontSize: "0.85rem", color: "#9a3412", fontWeight: 500 }}>
                          Printing result is uncertain. Some pages may already have printed.
                        </span>
                        <button
                          type="button"
                          className="secondary-button"
                          style={{ backgroundColor: "#166534", color: "white" }}
                          disabled={actionBusyId !== null}
                          onClick={() => void handleManualComplete(order)}
                        >
                           {actionBusyId === `complete-${order.orderId}` ? "Marking..." : "Mark as Printed"}
                        </button>
                      </div>
                    )}

                    {["PRINTING", "CLAIMED", "SPOOLING"].includes(order.status) && (
                       <span style={{ fontSize: "0.85rem", color: "#4b5563" }}>Printing in progress...</span>
                    )}

                    {order.status === "PRINT_BLOCKED" && (
                       <span style={{ fontSize: "0.85rem", color: "#b91c1c" }}>Printer fault. Clear printer error, then Recover.</span>
                    )}
                  </div>
                </article>
              ))}
          </div>
          <Pagination
            currentPage={currentPage}
            totalItems={orders.length}
            pageSize={PAGE_SIZE}
            onPageChange={setCurrentPage}
            itemLabel="live orders"
          />
        </>
      ) : null}
    </div>
  );
}
