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
}: {
  onSessionExpired: (message: string) => void;
}) {
  const [orders, setOrders] = useState<AdminLiveOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
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
    return () => {
      active = false;
    };
  }, [onSessionExpired]);

  return (
    <div className="page-stack">
      <div>
        <p className="eyebrow">Shop operations</p>
        <h1>Live Orders</h1>
        <p className="page-intro">
          Observe paid jobs currently waiting, printing, or needing attention.
        </p>
      </div>
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
            </article>
          ))}
        </div>
      ) : null}
    </div>
  );
}
