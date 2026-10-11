import type {
  AdminCashOrder,
  AdminManualOrder,
  OrderAddonServiceSnapshot,
} from "@printgo/api-contract";
import { useEffect, useState } from "react";
import { Pagination } from "./Pagination";
import {
  adminApi,
  AdminApiError,
  friendlyAdminError,
  getAdminToken,
} from "./api";

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

function CashOrderCard({
  order,
  nowMs,
  onConfirm,
}: {
  order: AdminCashOrder;
  nowMs: number;
  onConfirm: (order: AdminCashOrder) => void;
}) {
  const isGrace =
    nowMs >= order.cashExpiresAtMs && nowMs < order.cashGraceUntilMs;

  const targetMs = isGrace ? order.cashGraceUntilMs : order.cashExpiresAtMs;
  const diffSec = Math.max(0, Math.floor((targetMs - nowMs) / 1000));
  const mins = Math.floor(diffSec / 60);
  const secs = diffSec % 60;
  const countdownStr = `${mins}:${secs.toString().padStart(2, "0")}`;

  const jobCodeDisplay =
    order.publicJobCode || order.orderId.slice(0, 8).toUpperCase();

  return (
    <div
      className="manual-order-card"
      style={{
        backgroundColor: isGrace ? "#FFFBEB" : "#F0FDF4",
        border: `1.5px solid ${isGrace ? "#FDE68A" : "#BBF7D0"}`,
        borderRadius: "0.75rem",
        padding: "1.1rem",
        display: "flex",
        flexDirection: "column",
        gap: "0.75rem",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "0.5rem",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <strong
            className="job-code"
            style={{
              fontSize: "1.25rem",
              color: isGrace ? "#92400E" : "#166534",
              margin: 0,
            }}
          >
            {jobCodeDisplay}
          </strong>
        </div>
        <div>
          {isGrace ? (
            <span
              style={{
                backgroundColor: "#FEF3C7",
                color: "#92400E",
                padding: "0.2rem 0.6rem",
                borderRadius: "9999px",
                fontSize: "0.8rem",
                fontWeight: 700,
                border: "1px solid #FCD34D",
              }}
            >
              ⚠️ Grace: {countdownStr}
            </span>
          ) : (
            <span
              style={{
                backgroundColor: "#DCFCE7",
                color: "#166534",
                padding: "0.2rem 0.6rem",
                borderRadius: "9999px",
                fontSize: "0.8rem",
                fontWeight: 700,
                border: "1px solid #86EFAC",
              }}
            >
              ⏱️ {countdownStr}
            </span>
          )}
        </div>
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          borderTop: `1px solid ${isGrace ? "#FEF3C7" : "#DCFCE7"}`,
          borderBottom: `1px solid ${isGrace ? "#FEF3C7" : "#DCFCE7"}`,
          padding: "0.55rem 0",
        }}
      >
        <div>
          <div
            style={{ fontSize: "0.95rem", fontWeight: 600, color: "#1F2937" }}
          >
            {order.customerName || "Walk-in Customer"}
          </div>
          {order.customerPhone ? (
            <div className="muted" style={{ fontSize: "0.85rem" }}>
              {order.customerPhone}
            </div>
          ) : null}
        </div>
        <div style={{ textAlign: "right" }}>
          <span
            className="muted"
            style={{
              fontSize: "0.75rem",
              display: "block",
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              fontWeight: 600,
            }}
          >
            Cash to Collect
          </span>
          <strong
            style={{
              fontSize: "1.35rem",
              color: isGrace ? "#92400E" : "#166534",
              fontWeight: 800,
            }}
          >
            {formatPaise(order.payableAmountPaise)}
          </strong>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          marginTop: "0.25rem",
        }}
      >
        <button
          className="primary-button"
          type="button"
          style={{
            width: "100%",
            padding: "0.55rem 0.75rem",
            fontSize: "0.95rem",
            fontWeight: 700,
            backgroundColor: isGrace ? "#D97706" : "#166534",
          }}
          onClick={() => onConfirm(order)}
        >
          Confirm Cash Received
        </button>
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

  // 1-second ticker for smooth countdown with ZERO network calls
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

  // Event-driven WebSocket connection + window focus + 90s fallback
  useEffect(() => {
    // Initial fetch
    void loadCash();
    void load();

    let ws: WebSocket | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout> | undefined;
    let isDisposed = false;

    function connectWs() {
      if (isDisposed) return;
      try {
        const token = getAdminToken();
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const wsUrl = `${protocol}//${window.location.host}/api/admin/ws${token ? `?token=${encodeURIComponent(token)}` : ""}`;
        ws = new WebSocket(wsUrl);

        ws.onmessage = (event: MessageEvent<string>) => {
          try {
            const rawData: unknown = event.data;
            if (typeof rawData === "string") {
              const data: unknown = JSON.parse(rawData);
              if (
                typeof data === "object" &&
                data !== null &&
                "type" in data &&
                data.type === "WAKE_UP"
              ) {
                void loadCash();
                void load();
              }
            }
          } catch {
            // Ignored
          }
        };

        ws.onerror = () => {
          // Fallback handlers active
        };

        ws.onclose = () => {
          if (!isDisposed) {
            reconnectTimeout = setTimeout(connectWs, 15_000);
          }
        };
      } catch {
        // Fallback handlers active
      }
    }

    connectWs();

    // Browser tab focus & visibility change handler
    function handleVisibility() {
      if (!document.hidden) {
        void loadCash();
        void load();
      }
    }

    function handleFocus() {
      void loadCash();
      void load();
    }

    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("focus", handleFocus);

    // Infrequent fallback refresh timer (90s)
    const fallbackTimer = setInterval(() => {
      if (!document.hidden) {
        void loadCash();
        void load();
      }
    }, 90_000);

    return () => {
      isDisposed = true;
      if (ws) {
        try {
          ws.close();
        } catch {
          // Ignored
        }
      }
      clearTimeout(reconnectTimeout);
      clearInterval(fallbackTimer);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("focus", handleFocus);
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
              maxWidth: "420px",
              width: "90%",
              margin: 0,
              boxShadow: "0 4px 20px rgba(0, 0, 0, 0.15)",
            }}
          >
            <h3 style={{ marginTop: 0 }}>Confirm Cash Payment</h3>
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
              >
                {confirmCashBusy ? "Confirming…" : "Yes, Confirm Cash"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* ── Modern Two-Column Layout ── */}
      <div className="cash-manual-two-col">
        {/* Left Column: Manual & Finishing Orders */}
        <section className="manual-orders-column">
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
                Manual &amp; Finishing Orders ({orders.length})
              </h2>
              <p
                className="muted"
                style={{ margin: "0.2rem 0 0", fontSize: "0.85rem" }}
              >
                Orders requiring manual printing or staff finishing.
              </p>
            </div>
            <button
              className="secondary-button fit"
              style={{ fontSize: "0.8rem", padding: "0.3rem 0.6rem" }}
              type="button"
              onClick={() => {
                setCurrentPage(1);
                void load();
              }}
              disabled={loading}
            >
              {loading ? "Refreshing…" : "Refresh"}
            </button>
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

          {orders.length === 0 ? (
            <div
              className="panel"
              style={{ padding: "1.5rem", textAlign: "center" }}
            >
              <p className="muted" style={{ margin: 0 }}>
                No manual or finishing orders at this time.
              </p>
            </div>
          ) : (
            <div className="manual-orders-list">
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
          )}

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
        </section>

        {/* Right Column: Pending Cash Orders */}
        <section className="cash-orders-column">
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
                style={{ margin: "0.2rem 0 0", fontSize: "0.85rem" }}
              >
                Orders waiting for cash payment at counter.
              </p>
            </div>
            <button
              className="secondary-button fit"
              style={{ fontSize: "0.8rem", padding: "0.3rem 0.6rem" }}
              type="button"
              onClick={() => void loadCash()}
              disabled={cashLoading}
            >
              {cashLoading ? "Refreshing…" : "Refresh"}
            </button>
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

          {activeCashOrders.length === 0 ? (
            <div
              className="panel"
              style={{ padding: "1.5rem", textAlign: "center" }}
            >
              <p className="muted" style={{ margin: 0 }}>
                No pending cash orders. New counter orders will appear here in
                real time.
              </p>
            </div>
          ) : (
            <div
              style={{ display: "flex", flexDirection: "column", gap: "1rem" }}
            >
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
