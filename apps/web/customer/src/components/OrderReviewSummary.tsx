import type React from "react";
import type { CustomerQuoteData } from "@printgo/api-contract";
import { formatInr } from "@printgo/pricing";
import { humanFileSize, type LocalOrderFile } from "./customer-types";

export interface OrderReviewSummaryProps {
  quote: CustomerQuoteData;
  files: LocalOrderFile[];
  customerName: string;
  customerPhone: string;
  isRecalculating?: boolean;
  children?: React.ReactNode;
}

export function OrderReviewSummary({
  quote,
  files,
  customerName,
  customerPhone,
  isRecalculating = false,
  children,
}: OrderReviewSummaryProps) {
  return (
    <div className="review-summary">
      <div className="summary-section">
        <div className="summary-box">
          <div className="summary-label">Customer Details</div>
          <div className="summary-val">
            <span className="icon">👤</span> {customerName || "—"}
          </div>
          <div className="summary-val">
            <span className="icon">📞</span> {customerPhone || "—"}
          </div>
        </div>
        <div className="summary-box">
          <div className="summary-label">Files ({files.length})</div>
          <div className="summary-files">
            {files.map((f) => (
              <div key={f.clientId} className="summary-file-row">
                <span className="pdf-icon-small">PDF</span>
                <div className="summary-file-info">
                  <span className="name" title={f.name}>
                    {f.name.length > 25
                      ? f.name.substring(0, 25) + "..."
                      : f.name}
                  </span>
                  <span className="meta">
                    {f.pageCount} pages · {humanFileSize(f.size)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="summary-order">
        <div className="summary-label">Order Summary</div>
        {quote.files?.map((quoted, index) => (
          <div className="summary-row" key={quoted.fileId}>
            <span>File {index + 1}</span>
            <span>{formatInr(quoted.printingAmountPaise ?? 0)}</span>
          </div>
        ))}
        <div className="summary-row">
          <span>Printing</span>
          <span>
            {formatInr(
              quote.printingAmountPaise ?? quote.totalAmountPaise ?? 0,
            )}
          </span>
        </div>
        {quote.serviceChargePaise ? (
          <div className="summary-row">
            <span>File service</span>
            <span>{formatInr(quote.serviceChargePaise)}</span>
          </div>
        ) : null}
        {quote.addonServices && quote.addonServices.length > 0
          ? quote.addonServices.map((s) => (
              <div className="summary-row" key={s.serviceId}>
                <span>{s.serviceName}</span>
                <span>
                  {s.pricingType === "STAFF_PRICED"
                    ? "TBD"
                    : s.onlinePricePaise === 0
                      ? "FREE"
                      : formatInr(s.onlinePricePaise)}
                </span>
              </div>
            ))
          : null}
        {quote.priorityFeePaise && quote.priorityFeePaise > 0 ? (
          <div className="summary-row">
            <span>Priority queue</span>
            <span>{formatInr(quote.priorityFeePaise)}</span>
          </div>
        ) : null}
        {quote.discountAmountPaise && quote.discountAmountPaise > 0 ? (
          <div className="summary-row discount">
            <span>
              Discount ({quote.appliedDiscount?.discountPercent}% off)
            </span>
            <span>-{formatInr(quote.discountAmountPaise)}</span>
          </div>
        ) : null}
        {quote.isPickup && (
          <div
            className="summary-row pickup-row"
            style={{
              background: "#f0f9ff",
              padding: "0.5rem 0.6rem",
              borderRadius: "6px",
              color: "#0369a1",
              fontWeight: 600,
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            <span>🌅 Pickup at Opening</span>
            <span>{quote.pickupFormatted || "At next opening"}</span>
          </div>
        )}
      </div>

      <div className="total-box">
        <div className="total-label">
          Total Amount
          {isRecalculating && (
            <span
              className="recalculating-hint"
              style={{
                fontSize: "0.82rem",
                fontWeight: 500,
                opacity: 0.85,
                marginLeft: "0.5rem",
                color: "#166534",
              }}
            >
              (Updating total…)
            </span>
          )}
        </div>
        <div
          className="total-value"
          style={{
            opacity: isRecalculating ? 0.6 : 1,
            transition: "opacity 0.2s ease",
          }}
        >
          {formatInr(quote.totalAmountPaise ?? 0)}
        </div>

        {quote.addonServices?.some((s) => s.pricingType === "STAFF_PRICED") && (
          <div className="staff-price-warning">
            Note: Staff-priced items will be paid at the counter.
          </div>
        )}

        {children}
      </div>
    </div>
  );
}
