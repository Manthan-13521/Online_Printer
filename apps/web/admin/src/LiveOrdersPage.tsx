import { startVisiblePolling } from "./utils/polling";
import type { AdminLiveOrder, QueueStallDetails } from "@printgo/api-contract";
import { useEffect, useRef, useState } from "react";

import { Pagination } from "./Pagination";
import { adminApi, AdminApiError, friendlyAdminError } from "./api";
import { LiveOrderRow } from "./orders";
import { useAdminWebSocket } from "./useAdminWebSocket";

export function LiveOrdersPage({
  onSessionExpired,
  pollIntervalMs = 40_000,
}: {
  onSessionExpired: (message: string) => void;
  pollIntervalMs?: number;
}) {
  const [orders, setOrders] = useState<AdminLiveOrder[] | null>(null);
  const [stallDetails, setStallDetails] = useState<QueueStallDetails | null>(
    null,
  );
  const [confirmRecovery, setConfirmRecovery] = useState(false);
  const [confirmClearSpooler, setConfirmClearSpooler] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [actionBusyId, setActionBusyId] = useState<string | null>(null);
  const [confirmRetryId, setConfirmRetryId] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const PAGE_SIZE = 10;
  const previousRef = useRef("");

  const totalPages = Math.max(1, Math.ceil((orders?.length ?? 0) / PAGE_SIZE));
  useEffect(() => {
    if (orders && currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [orders, totalPages, currentPage]);

  const fetchOrders = async () => {
    try {
      const response = await adminApi.getLiveOrders();
      if (!response.ok) return undefined;
      setOrders(response.data.orders);
      setStallDetails(response.data.stallDetails ?? null);
      setError(null);
      const snapshot = JSON.stringify(response.data.orders);
      const changed = snapshot !== previousRef.current;
      previousRef.current = snapshot;
      return changed;
    } catch (caught) {
      if (caught instanceof AdminApiError && caught.status === 401) {
        onSessionExpired("Your session has expired. Please sign in again.");
      } else setError(friendlyAdminError(caught));
      return undefined;
    }
  };

  useAdminWebSocket(() => {
    void fetchOrders();
  });

  useEffect(() => {
    let active = true;
    const stop = startVisiblePolling(async () => {
      if (!active) return undefined;
      return await fetchOrders();
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
    const confirmed = window.confirm(
      `Confirm order ${code} was physically printed and handed to the customer?`,
    );
    if (!confirmed) return;
    setActionBusyId(`complete-${order.orderId}`);
    setError(null);
    setActionNotice(null);
    try {
      const res = await adminApi.manualCompleteOrder(order.orderId);
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

  async function handleDeleteOrder(order: AdminLiveOrder) {
    const code = order.pickupCode ?? order.jobCode;
    const confirmed = window.confirm(
      `Permanently delete order ${code} and its files? This cannot be undone.`,
    );
    if (!confirmed) return;
    setActionBusyId(`delete-${order.orderId}`);
    setError(null);
    setActionNotice(null);
    try {
      const res = await adminApi.deleteOrder(order.orderId);
      if (res.ok) {
        setOrders(
          (prev) => prev?.filter((o) => o.orderId !== order.orderId) ?? [],
        );
        setActionNotice(`Order ${code} has been permanently deleted.`);
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

  async function handleConvertSingleSided(order: AdminLiveOrder) {
    const code = order.pickupCode ?? order.jobCode;
    setActionBusyId(`single-sided-${order.orderId}`);
    setError(null);
    setActionNotice(null);
    try {
      const res = await adminApi.convertOrderToSingleSided(order.orderId);
      if (res.ok) {
        setOrders(
          (prev) =>
            prev?.map((o) =>
              o.orderId === order.orderId
                ? {
                    ...o,
                    status: "QUEUED",
                    errorCategory: null,
                    rawError: null,
                    printSummary: { ...o.printSummary, sides: "SINGLE" },
                  }
                : o,
            ) ?? [],
        );
        setActionNotice(
          `Order ${code} converted to 1-sided and re-queued. Printing will begin on the enabled printer.`,
        );
        const fresh = await adminApi.getLiveOrders();
        if (fresh.ok) {
          setOrders(fresh.data.orders);
          setStallDetails(fresh.data.stallDetails ?? null);
        }
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

  async function handleExecuteRecovery() {
    setActionBusyId("recovery");
    setError(null);
    setActionNotice(null);
    try {
      const res = await adminApi.recoverQueue();
      if (res.ok) {
        setConfirmRecovery(false);
        setActionNotice(res.data.message);
        const fresh = await adminApi.getLiveOrders();
        if (fresh.ok) {
          setOrders(fresh.data.orders);
          setStallDetails(fresh.data.stallDetails ?? null);
        }
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

  async function handleExecuteClearSpooler() {
    setActionBusyId("clear-spooler");
    setError(null);
    setActionNotice(null);
    try {
      const res = await adminApi.clearSpooler();
      if (res.ok) {
        setConfirmClearSpooler(false);
        setActionNotice(res.data.message);
        const fresh = await adminApi.getLiveOrders();
        if (fresh.ok) {
          setOrders(fresh.data.orders);
          setStallDetails(fresh.data.stallDetails ?? null);
        }
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

  const attentionOrders =
    orders?.filter((o) => {
      const isProblemStatus =
        o.status === "ADMIN_ACTION_REQUIRED" ||
        o.status === "COMPLETION_UNKNOWN" ||
        o.status === "NEEDS_ADMIN" ||
        o.status === "PRINT_BLOCKED" ||
        o.status === "PRINT_FAILED";
      const isStuckQueue =
        (o.status === "QUEUED" ||
          o.status === "PRINTING" ||
          o.status === "SPOOLING" ||
          o.status === "CLAIMED") &&
        Date.now() - new Date(o.updatedAt).getTime() >= 5 * 60 * 1000 &&
        Boolean(stallDetails?.isStalled);
      return isProblemStatus || isStuckQueue;
    }) ?? [];

  const hasPrinterIssue = Boolean(stallDetails?.printerIssue);
  const isStalled = Boolean(stallDetails?.isStalled);
  const hasAttentionIssue =
    isStalled || hasPrinterIssue || attentionOrders.length > 0;
  const attentionCount = Math.max(
    attentionOrders.length + (hasPrinterIssue ? 1 : 0),
    isStalled ? 1 : 0,
  );

  return (
    <div className="page-stack">
      <div
        className="live-orders-header"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          flexWrap: "wrap",
          gap: "1rem",
        }}
      >
        <div>
          <p className="eyebrow" style={{ marginBottom: "0.2rem" }}>
            Shop operations · Print Queue
          </p>
          <h1
            style={{
              margin: "0 0 0.2rem",
              fontSize: "1.65rem",
              fontWeight: 800,
            }}
          >
            Live Orders
          </h1>
          <p
            className="page-intro"
            style={{ margin: 0, fontSize: "0.92rem", color: "#64748b" }}
          >
            Paid orders and live printing activity
          </p>
        </div>

        <div
          className="live-orders-status-area"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: "0.45rem",
          }}
        >
          {hasAttentionIssue ? (
            <>
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.35rem",
                  padding: "0.3rem 0.75rem",
                  borderRadius: "9999px",
                  backgroundColor: "#fffbeb",
                  border: "1px solid #fde68a",
                  color: "#b45309",
                  fontSize: "0.82rem",
                  fontWeight: 700,
                }}
              >
                <span>⚠️</span>
                <span>
                  {attentionCount}{" "}
                  {attentionCount === 1 ? "needs attention" : "need attention"}
                </span>
              </div>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                  flexWrap: "wrap",
                }}
              >
                <button
                  type="button"
                  className="primary-button"
                  style={{
                    backgroundColor: "#d97706",
                    borderColor: "#b45309",
                    fontSize: "0.85rem",
                    padding: "0.35rem 0.75rem",
                    fontWeight: 600,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "0.35rem",
                    borderRadius: "0.45rem",
                  }}
                  disabled={actionBusyId !== null}
                  onClick={() => setConfirmRecovery(true)}
                  title="Check agent/printer, safely recover pre-submission orders, and clear physical locks"
                >
                  {actionBusyId === "recovery"
                    ? "Recovering…"
                    : "↻ Print Recovery"}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  style={{
                    color: "#334155",
                    borderColor: "#cbd5e1",
                    fontSize: "0.85rem",
                    padding: "0.35rem 0.75rem",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "0.35rem",
                    borderRadius: "0.45rem",
                  }}
                  disabled={actionBusyId !== null}
                  onClick={() => setConfirmClearSpooler(true)}
                  title="Selectively clear printgo-* spool jobs from Windows spooler without deleting orders"
                >
                  {actionBusyId === "clear-spooler"
                    ? "Clearing…"
                    : "Clear Queue"}
                </button>
              </div>
            </>
          ) : (
            <div style={{ textAlign: "right" }}>
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.35rem",
                  padding: "0.3rem 0.75rem",
                  borderRadius: "9999px",
                  backgroundColor: "#f0fdf4",
                  border: "1px solid #bbf7d0",
                  color: "#166534",
                  fontSize: "0.82rem",
                  fontWeight: 700,
                }}
              >
                All clear
              </div>
              <div
                style={{
                  fontSize: "0.8rem",
                  color: "#64748b",
                  marginTop: "0.2rem",
                }}
              >
                No action needed
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Printer Issue Alert Banner */}
      {stallDetails?.printerIssue ? (
        <div
          style={{
            backgroundColor: "#fef2f2",
            border: "1px solid #f87171",
            borderRadius: "0.55rem",
            padding: "0.85rem 1.15rem",
            color: "#991b1b",
            fontSize: "0.92rem",
            display: "flex",
            alignItems: "center",
            gap: "0.65rem",
          }}
          role="alert"
        >
          <span style={{ fontSize: "1.25rem" }}>⚠️</span>
          <div>
            <strong>Printer Issue Detected: </strong>
            <span>{stallDetails.printerIssue}</span>
            <div
              style={{
                fontSize: "0.82rem",
                color: "#b91c1c",
                marginTop: "0.2rem",
              }}
            >
              Check printer power, paper tray, USB connection, and ensure
              printer is not paused.
            </div>
          </div>
        </div>
      ) : null}

      {/* Stall Alert Banner */}
      {stallDetails?.isStalled && !stallDetails.printerIssue ? (
        <div
          style={{
            backgroundColor: "#fffbeb",
            border: "1px solid #fcd34d",
            borderRadius: "0.55rem",
            padding: "0.85rem 1.15rem",
            color: "#92400e",
            fontSize: "0.92rem",
            display: "flex",
            alignItems: "center",
            gap: "0.65rem",
          }}
          role="status"
        >
          <span style={{ fontSize: "1.25rem" }}>⚡</span>
          <div>
            <strong>Queue Stagnation Detected (5m+): </strong>
            <span>{stallDetails.reason}</span>
            <div
              style={{
                fontSize: "0.82rem",
                color: "#78350f",
                marginTop: "0.2rem",
              }}
            >
              Use <strong>Print Recovery</strong> above to safely resume
              printing without duplicate sheets.
            </div>
          </div>
        </div>
      ) : null}

      {/* Recovery Confirmation Panel */}
      {confirmRecovery ? (
        <div
          className="panel"
          style={{
            borderColor: "#d97706",
            backgroundColor: "#fffbeb",
            borderWidth: "2px",
          }}
        >
          <h3 style={{ margin: "0 0 0.5rem", color: "#92400e" }}>
            ⚡ Confirm Smart Print Recovery
          </h3>
          <p
            style={{
              margin: "0 0 0.75rem",
              fontSize: "0.9rem",
              color: "#78350f",
            }}
          >
            Print Recovery checks Windows Agent and printer connectivity, safely
            re-queues pre-submission failures (
            <strong>0 duplicate reprint risk</strong>), and releases physical
            printer locks on held orders so waiting paid jobs can continue.
            <br />
            Orders that already began spooler submission remain held in{" "}
            <em>Needs review</em> for physical operator inspection.
          </p>
          <div style={{ display: "flex", gap: "0.75rem" }}>
            <button
              type="button"
              className="primary-button"
              style={{ backgroundColor: "#d97706", borderColor: "#b45309" }}
              disabled={actionBusyId !== null}
              onClick={() => void handleExecuteRecovery()}
            >
              {actionBusyId === "recovery"
                ? "Recovering…"
                : "Execute Print Recovery"}
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() => setConfirmRecovery(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {/* Clear Spooler Confirmation Panel */}
      {confirmClearSpooler ? (
        <div
          className="panel"
          style={{
            borderColor: "#b45309",
            backgroundColor: "#fef3c7",
            borderWidth: "2px",
          }}
        >
          <h3 style={{ margin: "0 0 0.5rem", color: "#92400e" }}>
            🧹 Confirm Selective Spooler Clear
          </h3>
          <p
            style={{
              margin: "0 0 0.75rem",
              fontSize: "0.9rem",
              color: "#78350f",
            }}
          >
            This dispatches a selective spooler cancellation to the Windows
            Agent via PowerShell CIM.
            <br />
            <strong>Safety guarantees:</strong> Only PrintGo print jobs
            (matching <code>printgo-*</code>) on the production printer will be
            cancelled. Unrelated Windows jobs, customer orders in D1, and PDFs
            in R2 will <strong>NOT</strong> be deleted.
          </p>
          <div style={{ display: "flex", gap: "0.75rem" }}>
            <button
              type="button"
              className="primary-button"
              style={{ backgroundColor: "#b45309", borderColor: "#92400e" }}
              disabled={actionBusyId !== null}
              onClick={() => void handleExecuteClearSpooler()}
            >
              {actionBusyId === "clear-spooler"
                ? "Clearing…"
                : "Confirm Clear Spooler"}
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() => setConfirmClearSpooler(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

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
        <section
          className="panel"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: "2.5rem 1.5rem",
            textAlign: "center",
            borderRadius: "0.75rem",
            border: "1px solid #e2e8f0",
            backgroundColor: "#ffffff",
            marginTop: "0.5rem",
          }}
        >
          <div
            style={{
              width: "2.5rem",
              height: "2.5rem",
              borderRadius: "50%",
              backgroundColor: "#f0fdf4",
              border: "1.5px solid #22c55e",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#166534",
              fontSize: "1.25rem",
              fontWeight: "bold",
              marginBottom: "0.85rem",
            }}
            aria-hidden="true"
          >
            ✓
          </div>
          <h2
            style={{
              margin: "0 0 0.35rem",
              fontSize: "1.15rem",
              fontWeight: 700,
              color: "#0f172a",
            }}
          >
            No active orders
          </h2>
          <p
            className="muted"
            style={{
              margin: 0,
              fontSize: "0.92rem",
              color: "#64748b",
            }}
          >
            New paid orders will appear here automatically.
          </p>
        </section>
      ) : null}
      {orders && orders.length > 0 ? (
        <>
          <div className="live-order-list">
            {orders
              .slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)
              .map((order) => (
                <LiveOrderRow
                  key={order.orderId}
                  order={order}
                  actionBusyId={actionBusyId}
                  confirmRetryId={confirmRetryId}
                  onDownloadPdf={handleDownloadPdf}
                  onManualComplete={handleManualComplete}
                  onRetry={handleRetry}
                  onSetConfirmRetryId={setConfirmRetryId}
                  onConvertSingleSided={handleConvertSingleSided}
                  onDeleteOrder={handleDeleteOrder}
                />
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
