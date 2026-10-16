import type { AdminCashOrder, AdminManualOrder } from "@printgo/api-contract";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pagination } from "./Pagination";
import { adminApi, AdminApiError, friendlyAdminError } from "./api";
import {
  CashEmptyState,
  CashOrderCard,
  ManualEmptyState,
  ManualOrderCard,
  RelativeTimeBadge,
} from "./orders";
import { useAdminWebSocket } from "./useAdminWebSocket";
import { formatPaise } from "./utils/formatters";
import { startVisiblePolling } from "./utils/polling";

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
  const [lastRefreshedAt, setLastRefreshedAt] = useState(() => Date.now());
  const [cashExpiryTick, setCashExpiryTick] = useState(0);

  const handleCashOrderExpired = useCallback(() => {
    setCashExpiryTick((t) => t + 1);
  }, []);

  async function loadCash() {
    setCashLoading(true);
    setCashError(null);
    try {
      const response = await adminApi.getCashOrders();
      if (response.ok) {
        setCashOrders(response.data.orders);
        setLastRefreshedAt(Date.now());
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
        setLastRefreshedAt(Date.now());
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

  async function refreshAll() {
    await Promise.all([loadCash(), load()]);
  }

  useAdminWebSocket(() => {
    void loadCash();
    void load();
  });

  const prevCashSnapshot = useRef("");
  const prevManualSnapshot = useRef("");

  const pollOrders = useCallback(async (): Promise<boolean> => {
    let changed = false;
    try {
      const [cashRes, manualRes] = await Promise.all([
        adminApi.getCashOrders().catch(() => null),
        adminApi.getManualOrders().catch(() => null),
      ]);
      if (cashRes && cashRes.ok) {
        const snap = JSON.stringify(cashRes.data.orders);
        if (snap !== prevCashSnapshot.current) {
          prevCashSnapshot.current = snap;
          setCashOrders(cashRes.data.orders);
          changed = true;
        }
      }
      if (manualRes && manualRes.ok) {
        const snap = JSON.stringify(manualRes.data.orders);
        if (snap !== prevManualSnapshot.current) {
          prevManualSnapshot.current = snap;
          setOrders(manualRes.data.orders);
          setCursor(manualRes.data.nextCursor);
          changed = true;
        }
      }
      setLastRefreshedAt(Date.now());
      setLoading(false);
      setCashLoading(false);
      return changed;
    } catch (caught: unknown) {
      if (caught instanceof AdminApiError && caught.status === 401) {
        onSessionExpired("Your session has expired. Please sign in again.");
      }
      setLoading(false);
      setCashLoading(false);
      return false;
    }
  }, [onSessionExpired]);

  // Event-driven initial fetch + visible adaptive polling fallback
  useEffect(() => {
    return startVisiblePolling(pollOrders, 45_000, 120_000);
  }, [pollOrders]);

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
        await Promise.all([loadCash(), load()]);
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

  const activeCashOrders = useMemo(
    () => cashOrders.filter((order) => Date.now() < order.cashGraceUntilMs),
    [cashOrders, cashExpiryTick],
  );

  if (loading && orders.length === 0 && cashOrders.length === 0) {
    return (
      <div className="panel page-loading" aria-busy="true">
        Loading orders…
      </div>
    );
  }

  const isRefreshing = loading || cashLoading;

  return (
    <div className="page-stack">
      {/* ── Page Header ── */}
      <div className="orders-page-header">
        <div className="orders-header-titles">
          <p className="orders-header-eyebrow">SHOP STAFF</p>
          <h1 className="orders-header-main-title">Cash &amp; Manual Orders</h1>
          <p className="orders-header-subtitle">
            Confirm cash payments received at the counter and process orders
            requiring manual printing or finishing.
          </p>
        </div>
        <div className="orders-header-controls">
          <button
            className="refresh-all-button"
            type="button"
            onClick={() => void refreshAll()}
            disabled={isRefreshing}
          >
            <svg
              className={isRefreshing ? "spin-icon" : ""}
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
            {isRefreshing ? "Refreshing…" : "Refresh all"}
          </button>
          <RelativeTimeBadge lastRefreshedAt={lastRefreshedAt} />
        </div>
      </div>

      {/* Confirmation Modal */}
      {confirmingCashOrder ? (
        <div className="dialog-backdrop">
          <section
            aria-labelledby="confirm-cash-dialog-title"
            aria-modal="true"
            className="confirm-dialog"
            role="dialog"
          >
            <h2 id="confirm-cash-dialog-title" style={{ marginTop: 0 }}>
              Confirm Cash Payment
            </h2>
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
                style={{ backgroundColor: "#166534" }}
              >
                {confirmCashBusy ? "Confirming…" : "Yes, Confirm Cash"}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {/* ── Modern Two-Column Layout ── */}
      <div className="cash-manual-two-col">
        {/* Left Column: Manual & Finishing Orders (Blue Theme) */}
        <section className="manual-orders-column column-container blue-column">
          <div className="column-header">
            <div className="column-icon-circle blue-icon-circle">
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <polyline points="6 9 6 2 18 2 18 9" />
                <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                <rect x="6" y="14" width="12" height="8" />
              </svg>
            </div>
            <div className="column-title-box">
              <div className="column-title-row">
                <h2 className="column-main-heading">
                  Manual / Finishing Orders
                </h2>
                <span className="count-badge blue-count-badge">
                  {orders.length}
                </span>
              </div>
              <p className="column-subtext">
                Orders requiring manual printing or staff finishing.
              </p>
            </div>
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

          {/* Strict Empty State Condition: Never rendered beneath active orders */}
          {orders.length === 0 ? (
            <ManualEmptyState />
          ) : (
            <>
              <div className="orders-cards-list">
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
            </>
          )}
        </section>

        {/* Right Column: Pending Cash Orders (Green Theme) */}
        <section className="cash-orders-column column-container green-column">
          <div className="column-header">
            <div className="column-icon-circle green-icon-circle">
              <span className="rupee-icon" aria-hidden="true">
                ₹
              </span>
            </div>
            <div className="column-title-box">
              <div className="column-title-row">
                <h2 className="column-main-heading">Pending Cash Orders</h2>
                <span className="count-badge green-count-badge">
                  {activeCashOrders.length}
                </span>
              </div>
              <p className="column-subtext">
                Orders waiting for cash payment at counter.
              </p>
            </div>
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

          {/* Strict Empty State Condition: Never rendered beneath active orders */}
          {activeCashOrders.length === 0 ? (
            <CashEmptyState />
          ) : (
            <div className="orders-cards-list">
              {activeCashOrders.map((order) => (
                <CashOrderCard
                  key={order.orderId}
                  order={order}
                  onConfirm={(o) => {
                    setConfirmCashError(null);
                    setConfirmingCashOrder(o);
                  }}
                  onExpired={handleCashOrderExpired}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
