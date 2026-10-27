import { useEffect, useState, useCallback } from "react";
import type { AdminPickupOrder } from "@printgo/api-contract";
import { formatInr } from "@printgo/pricing";
import { adminApi, AdminApiError, friendlyAdminError } from "./api";

export function PickupOrdersPage({
  onSessionExpired,
}: {
  onSessionExpired: (message: string) => void;
}) {
  const [orders, setOrders] = useState<AdminPickupOrder[]>([]);
  const [autoPrintEnabled, setAutoPrintEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionBusyId, setActionBusyId] = useState<string | null>(null);
  const [autoPrintBusy, setAutoPrintBusy] = useState(false);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      const response = await adminApi.getPickupOrders();
      if (response.ok) {
        setOrders(response.data.orders);
        setAutoPrintEnabled(response.data.autoPrintEnabled);
        setError(null);
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
  }, [onSessionExpired]);

  useEffect(() => {
    void loadData();
    const interval = setInterval(() => {
      void loadData();
    }, 15000);
    return () => clearInterval(interval);
  }, [loadData]);

  const handleToggleAutoPrint = async () => {
    const nextState = !autoPrintEnabled;
    setAutoPrintEnabled(nextState);
    setAutoPrintBusy(true);
    try {
      await adminApi.setPickupAutoPrint(nextState);
      setActionNotice(
        nextState
          ? "Print Automatically enabled. Eligible pickup orders will print when the shop opens."
          : "Print Automatically disabled. Orders will await manual 'Print Now' approval.",
      );
    } catch (caught: unknown) {
      setAutoPrintEnabled(!nextState);
      if (caught instanceof AdminApiError && caught.status === 401) {
        onSessionExpired("Your session has expired. Please sign in again.");
        return;
      }
      setError(friendlyAdminError(caught));
    } finally {
      setAutoPrintBusy(false);
    }
  };

  const handlePrintNow = async (orderId: string) => {
    setActionBusyId(orderId);
    setError(null);
    try {
      await adminApi.printPickupOrder(orderId);
      setActionNotice("Order queued for printing.");
      await loadData();
    } catch (caught: unknown) {
      if (caught instanceof AdminApiError && caught.status === 401) {
        onSessionExpired("Your session has expired. Please sign in again.");
        return;
      }
      setError(friendlyAdminError(caught));
    } finally {
      setActionBusyId(null);
    }
  };

  const handleMarkCollected = async (orderId: string) => {
    setActionBusyId(orderId);
    setError(null);
    try {
      await adminApi.markPickupCollected(orderId);
      setActionNotice("Order marked as collected.");
      await loadData();
    } catch (caught: unknown) {
      if (caught instanceof AdminApiError && caught.status === 401) {
        onSessionExpired("Your session has expired. Please sign in again.");
        return;
      }
      setError(friendlyAdminError(caught));
    } finally {
      setActionBusyId(null);
    }
  };

  const handleRetry = async (orderId: string) => {
    setActionBusyId(orderId);
    setError(null);
    try {
      await adminApi.retryPickupOrder(orderId);
      setActionNotice("Order print retry queued.");
      await loadData();
    } catch (caught: unknown) {
      if (caught instanceof AdminApiError && caught.status === 401) {
        onSessionExpired("Your session has expired. Please sign in again.");
        return;
      }
      setError(friendlyAdminError(caught));
    } finally {
      setActionBusyId(null);
    }
  };

  const getStatusBadge = (status: string, manualPrintRequested?: boolean) => {
    switch (status) {
      case "PRINTED":
        return {
          label: "Printed · Ready for Pickup",
          className: "badge-status-printed",
          style: {
            background: "#dcfce7",
            color: "#166534",
            border: "1px solid #86efac",
          },
        };
      case "CLAIMED":
      case "SPOOLING":
        return {
          label: "Sending to Printer…",
          className: "badge-status-spooling",
          style: {
            background: "#e0f2fe",
            color: "#0369a1",
            border: "1px solid #7dd3fc",
          },
        };
      case "PRINTING":
        return {
          label: "Printing…",
          className: "badge-status-printing",
          style: {
            background: "#dbeafe",
            color: "#1e40af",
            border: "1px solid #93c5fd",
          },
        };
      case "QUEUED":
        return manualPrintRequested
          ? {
              label: "Queued for Printing",
              className: "badge-status-queued",
              style: {
                background: "#fef3c7",
                color: "#92400e",
                border: "1px solid #fcd34d",
              },
            }
          : {
              label: "Awaiting Print",
              className: "badge-status-awaiting",
              style: {
                background: "#fef3c7",
                color: "#92400e",
                border: "1px solid #fcd34d",
              },
            };
      case "PRINT_FAILED":
      case "PRINT_BLOCKED":
      case "RETRY_PENDING":
        return {
          label: "Print Failed",
          className: "badge-status-failed",
          style: {
            background: "#fee2e2",
            color: "#991b1b",
            border: "1px solid #fca5a5",
          },
        };
      case "COMPLETION_UNKNOWN":
        return {
          label: "Completion Unknown",
          className: "badge-status-unknown",
          style: {
            background: "#ffedd5",
            color: "#c2410c",
            border: "1px solid #fdba74",
          },
        };
      case "ADMIN_ACTION_REQUIRED":
      case "NEEDS_ADMIN":
        return {
          label: "Admin Action Required",
          className: "badge-status-warning",
          style: {
            background: "#ffedd5",
            color: "#c2410c",
            border: "1px solid #fdba74",
          },
        };
      case "COMPLETED":
        return {
          label: "Collected",
          className: "badge-status-completed",
          style: {
            background: "#f1f5f9",
            color: "#475569",
            border: "1px solid #cbd5e1",
          },
        };
      default:
        return {
          label: "Awaiting Print",
          className: "badge-status-awaiting",
          style: {
            background: "#fef3c7",
            color: "#92400e",
            border: "1px solid #fcd34d",
          },
        };
    }
  };

  return (
    <div
      className="pickup-orders-page"
      style={{ padding: "1.5rem", maxWidth: "1000px", margin: "0 auto" }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "1rem",
          marginBottom: "1.5rem",
        }}
      >
        <div>
          <h1
            style={{
              margin: "0 0 0.25rem 0",
              fontSize: "1.75rem",
              fontWeight: 800,
            }}
          >
            Tomorrow Pickup Orders
          </h1>
          <p className="muted" style={{ margin: 0, fontSize: "0.95rem" }}>
            Orders scheduled for collection at shop opening.
          </p>
        </div>

        {/* Print automatically toggle */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.75rem",
            background: "#ffffff",
            padding: "0.5rem 1rem",
            borderRadius: "8px",
            border: "1px solid #e2e8f0",
            boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
          }}
        >
          <span
            style={{ fontSize: "0.9rem", fontWeight: 600, color: "#334155" }}
          >
            Print automatically
          </span>
          <label className="toggle-switch" style={{ margin: 0 }}>
            <input
              type="checkbox"
              role="switch"
              aria-label="Print automatically"
              checked={autoPrintEnabled}
              disabled={autoPrintBusy}
              onChange={() => void handleToggleAutoPrint()}
            />
            <span className="toggle-slider" />
          </label>
        </div>
      </div>

      {actionNotice && (
        <div
          role="status"
          style={{
            marginBottom: "1rem",
            padding: "0.75rem 1rem",
            background: "#f0fdf4",
            color: "#166534",
            border: "1px solid #bbf7d0",
            borderRadius: "8px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span>{actionNotice}</span>
          <button
            type="button"
            onClick={() => setActionNotice(null)}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "#166534",
              fontWeight: "bold",
            }}
          >
            ×
          </button>
        </div>
      )}

      {error && (
        <div
          role="alert"
          style={{
            marginBottom: "1rem",
            padding: "0.75rem 1rem",
            background: "#fef2f2",
            color: "#991b1b",
            border: "1px solid #fecaca",
            borderRadius: "8px",
          }}
        >
          {error}
        </div>
      )}

      {loading && orders.length === 0 ? (
        <div style={{ textAlign: "center", padding: "3rem", color: "#64748b" }}>
          Loading pickup orders…
        </div>
      ) : orders.length === 0 ? (
        <div
          style={{
            background: "#ffffff",
            padding: "3rem 1.5rem",
            borderRadius: "12px",
            textAlign: "center",
            border: "1px dashed #cbd5e1",
            marginTop: "1rem",
          }}
        >
          <div style={{ fontSize: "2.5rem", marginBottom: "0.5rem" }}>📦</div>
          <h3 style={{ margin: "0 0 0.5rem 0", color: "#1e293b" }}>
            No Tomorrow Pickup Orders
          </h3>
          <p
            className="muted"
            style={{ margin: 0, maxWidth: "400px", marginInline: "auto" }}
          >
            Scheduled orders placed by customers for shop opening will appear
            here.
          </p>
        </div>
      ) : (
        <div style={{ display: "grid", gap: "1rem" }}>
          {orders.map((order) => {
            const badge = getStatusBadge(
              order.status,
              order.pickupManualPrintRequested,
            );
            const isBusy = actionBusyId === order.orderId;

            return (
              <div
                key={order.orderId}
                style={{
                  background: "#ffffff",
                  borderRadius: "12px",
                  border: "1px solid #e2e8f0",
                  padding: "1.25rem",
                  boxShadow: "0 2px 4px rgba(0,0,0,0.02)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.75rem",
                }}
              >
                {/* Top Row: Code & Status */}
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.75rem",
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "monospace",
                        fontSize: "1.15rem",
                        fontWeight: 700,
                        color: "#0f172a",
                        letterSpacing: "0.5px",
                      }}
                    >
                      #
                      {order.pickupCode ??
                        order.jobCode ??
                        order.orderId.slice(0, 8)}
                    </span>
                    <span
                      style={{
                        ...badge.style,
                        padding: "0.2rem 0.6rem",
                        borderRadius: "999px",
                        fontSize: "0.8rem",
                        fontWeight: 600,
                      }}
                    >
                      {badge.label}
                    </span>
                  </div>

                  <div style={{ fontSize: "0.85rem", color: "#64748b" }}>
                    {new Date(order.createdAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </div>
                </div>

                {/* Customer & Payment Info */}
                <div style={{ fontSize: "0.95rem", color: "#334155" }}>
                  <strong>{order.customerName}</strong>
                  {order.customerPhone && (
                    <span style={{ color: "#64748b" }}>
                      {" "}
                      · {order.customerPhone}
                    </span>
                  )}
                </div>

                <div style={{ fontSize: "0.9rem", color: "#475569" }}>
                  <span style={{ fontWeight: 600, color: "#166534" }}>
                    Paid {formatInr(order.totalAmountPaise)}
                  </span>
                  <span>
                    {" "}
                    · {order.paymentMethod === "CASH" ? "Cash" : "Online"}
                  </span>
                </div>

                {/* Pickup availability time */}
                <div
                  style={{
                    background: "#f8fafc",
                    padding: "0.5rem 0.75rem",
                    borderRadius: "6px",
                    fontSize: "0.9rem",
                    color: "#0369a1",
                    display: "flex",
                    alignItems: "center",
                    gap: "0.4rem",
                    border: "1px solid #e0f2fe",
                  }}
                >
                  <span>🌅</span>
                  <span>
                    <strong>Pickup: </strong>
                    {order.pickupFormatted ||
                      (order.pickupTargetTime
                        ? new Date(order.pickupTargetTime).toLocaleString([], {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })
                        : "At shop opening")}
                  </span>
                </div>

                {/* Files */}
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: "0.5rem",
                    marginTop: "0.25rem",
                  }}
                >
                  {order.files && order.files.length > 0 ? (
                    order.files.map((file) => (
                      <span
                        key={file.id}
                        style={{
                          fontSize: "0.85rem",
                          background: "#f1f5f9",
                          padding: "0.25rem 0.6rem",
                          borderRadius: "4px",
                          color: "#334155",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "0.3rem",
                        }}
                      >
                        📄 {file.originalFilename} ({file.copies}x ·{" "}
                        {file.paperSize} · {file.colorMode})
                      </span>
                    ))
                  ) : (
                    <span
                      style={{
                        fontSize: "0.85rem",
                        background: "#f1f5f9",
                        padding: "0.25rem 0.6rem",
                        borderRadius: "4px",
                        color: "#334155",
                      }}
                    >
                      📄 {order.originalFilename}
                    </span>
                  )}
                </div>

                {/* Instructions if present */}
                {order.instructions && (
                  <p
                    style={{
                      margin: 0,
                      fontSize: "0.85rem",
                      color: "#64748b",
                      fontStyle: "italic",
                    }}
                  >
                    "{order.instructions}"
                  </p>
                )}

                {/* Action Buttons */}
                <div
                  style={{
                    display: "flex",
                    justifyContent: "flex-end",
                    gap: "0.75rem",
                    marginTop: "0.5rem",
                    paddingTop: "0.75rem",
                    borderTop: "1px solid #f1f5f9",
                  }}
                >
                  {order.status === "PRINTED" ? (
                    <button
                      type="button"
                      className="primary-button"
                      disabled={isBusy}
                      onClick={() => void handleMarkCollected(order.orderId)}
                      style={{ background: "#16a34a", borderColor: "#16a34a" }}
                    >
                      {isBusy ? "Marking…" : "Mark as Collected"}
                    </button>
                  ) : order.status === "COMPLETED" ? null : [
                      "CLAIMED",
                      "SPOOLING",
                      "PRINTING",
                    ].includes(order.status) ? (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={true}
                      style={{ opacity: 0.7, cursor: "not-allowed" }}
                    >
                      {order.status === "PRINTING"
                        ? "Printing in Progress…"
                        : "Sending to Printer…"}
                    </button>
                  ) : [
                      "PRINT_FAILED",
                      "PRINT_BLOCKED",
                      "RETRY_PENDING",
                      "COMPLETION_UNKNOWN",
                      "ADMIN_ACTION_REQUIRED",
                      "NEEDS_ADMIN",
                    ].includes(order.status) ? (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={isBusy}
                      onClick={() => void handleRetry(order.orderId)}
                    >
                      {isBusy ? "Retrying…" : "Retry"}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="primary-button"
                      disabled={
                        isBusy ||
                        (order.status === "QUEUED" &&
                          order.pickupManualPrintRequested)
                      }
                      onClick={() => void handlePrintNow(order.orderId)}
                    >
                      {isBusy
                        ? "Queuing…"
                        : order.status === "QUEUED" &&
                            order.pickupManualPrintRequested
                          ? "Queued for Printing…"
                          : "Print Now"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
