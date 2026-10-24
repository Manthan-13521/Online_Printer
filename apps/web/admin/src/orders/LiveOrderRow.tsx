import type { AdminLiveOrder } from "@printgo/api-contract";
import { formatTimeOnly } from "../utils/formatters";

function summary(order: AdminLiveOrder): string {
  const print = order.printSummary;
  return `${print.paperSize} · ${print.colorMode === "COLOR" ? "Colour" : "B&W"} · ${print.sides === "DOUBLE" ? "Duplex" : "Single-sided"} · ${print.copies} ${print.copies === 1 ? "copy" : "copies"} · pages ${print.selectedPages}`;
}

export interface LiveOrderRowProps {
  order: AdminLiveOrder;
  actionBusyId: string | null;
  confirmRetryId: string | null;
  onDownloadPdf: (order: AdminLiveOrder) => void | Promise<void>;
  onManualComplete: (order: AdminLiveOrder) => void | Promise<void>;
  onRetry: (
    order: AdminLiveOrder,
    forceUncertain?: boolean,
  ) => void | Promise<void>;
  onSetConfirmRetryId: (orderId: string | null) => void;
  onConvertSingleSided: (order: AdminLiveOrder) => void | Promise<void>;
  onDeleteOrder: (order: AdminLiveOrder) => void | Promise<void>;
}

export function LiveOrderRow({
  order,
  actionBusyId,
  confirmRetryId,
  onDownloadPdf,
  onManualComplete,
  onRetry,
  onSetConfirmRetryId,
  onConvertSingleSided,
  onDeleteOrder,
}: LiveOrderRowProps) {
  return (
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
              <span className="priority-thunder-gold-badge">
                <span className="thunder-bolt">⚡</span>
                <span>Priority</span>
              </span>
            ) : null}
            <div
              style={{
                display: "inline-flex",
                flexDirection: "column",
                alignItems: "flex-start",
              }}
            >
              <span
                style={{
                  fontWeight: 700,
                  padding: "0.15rem 0.55rem",
                  borderRadius: "4px",
                  backgroundColor: "#dcfce7",
                  color: "#166534",
                  fontSize: "0.85rem",
                }}
              >
                Paid ₹
                {(order.amountPaidPaise / 100) % 1 === 0
                  ? order.amountPaidPaise / 100
                  : (order.amountPaidPaise / 100).toFixed(2)}
              </span>
              <span
                style={{
                  fontWeight: 700,
                  fontSize: "0.72rem",
                  color: "#0369a1",
                  backgroundColor: "#e0f2fe",
                  padding: "0.06rem 0.45rem",
                  borderRadius: "3px",
                  marginTop: "0.15rem",
                }}
              >
                {order.paymentMethod === "CASH" ? "Cash" : "Online"}
              </span>
            </div>
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
        <div>
          <dt>Phone</dt>
          <dd>{order.customerPhone}</dd>
        </div>
        <div>
          <dt>Printer</dt>
          <dd>{order.printerName ?? "Not assigned"}</dd>
        </div>
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
        {order.cashConfirmedAt ? (
          <div>
            <dt>Cash Confirmed</dt>
            <dd>{formatTimeOnly(order.cashConfirmedAt)}</dd>
          </div>
        ) : null}
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
          marginTop: "0.65rem",
          paddingTop: "0.65rem",
          borderTop: "1px solid var(--border-color, #e0e0e0)",
          alignItems: "center",
        }}
      >
        <button
          type="button"
          className="secondary-button"
          disabled={actionBusyId !== null}
          onClick={() => void onDownloadPdf(order)}
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
          "NEEDS_ADMIN",
          "COMPLETION_UNKNOWN",
          "RETRY_PENDING",
        ].includes(order.status) ? (
          <button
            type="button"
            className="secondary-button"
            disabled={actionBusyId !== null}
            onClick={() => void onManualComplete(order)}
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
          "NEEDS_ADMIN",
          "COMPLETION_UNKNOWN",
          "RETRY_PENDING",
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
                style={{
                  fontSize: "0.8rem",
                  padding: "0.2rem 0.5rem",
                }}
                disabled={actionBusyId !== null}
                onClick={() => void onRetry(order, true)}
              >
                {actionBusyId === `retry-${order.orderId}`
                  ? "Retrying…"
                  : "Yes, Retry"}
              </button>
              <button
                type="button"
                className="text-button"
                style={{ fontSize: "0.8rem" }}
                onClick={() => onSetConfirmRetryId(null)}
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
                if (
                  order.status === "ADMIN_ACTION_REQUIRED" ||
                  order.status === "COMPLETION_UNKNOWN"
                ) {
                  onSetConfirmRetryId(order.orderId);
                } else {
                  void onRetry(order, false);
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

        {order.errorCategory === "PRINTER_CAPABILITY_UNSUPPORTED" &&
        order.printSummary?.sides === "DOUBLE" ? (
          <button
            type="button"
            className="primary-button"
            style={{
              backgroundColor: "#0284c7",
              borderColor: "#0284c7",
            }}
            disabled={actionBusyId !== null}
            onClick={() => void onConvertSingleSided(order)}
            title="Convert double-sided order to 1-sided and print immediately on 1-sided printer"
          >
            {actionBusyId === `single-sided-${order.orderId}`
              ? "Converting…"
              : "Print 1-Sided"}
          </button>
        ) : null}

        <button
          type="button"
          className="secondary-button"
          style={{
            marginLeft: "auto",
            color: "#dc2626",
            borderColor: "#fca5a5",
          }}
          disabled={actionBusyId !== null}
          onClick={() => void onDeleteOrder(order)}
          title="Permanently delete order and associated customer data"
        >
          {actionBusyId === `delete-${order.orderId}`
            ? "Deleting…"
            : "Delete Order"}
        </button>
      </div>
    </article>
  );
}
