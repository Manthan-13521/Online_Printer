import { useState } from "react";
import type { CustomerConfigData } from "@printgo/api-contract";

export interface PricingModalProps {
  isOpen: boolean;
  config: CustomerConfigData | null;
  onClose: () => void;
}

export function PricingModal({ isOpen, config, onClose }: PricingModalProps) {
  const [activeTab, setActiveTab] = useState<"pricing" | "info">("pricing");

  if (!isOpen || !config) return null;

  return (
    <div className="pricing-modal-backdrop" onClick={onClose}>
      <div
        className="pricing-modal-content"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pricing-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pricing-modal-header">
          <h2 id="pricing-modal-title">
            {activeTab === "pricing"
              ? "Pricing & Rates"
              : "Shop & Privacy Info"}
          </h2>
          <button
            type="button"
            className="close-button"
            aria-label="Close"
            onClick={onClose}
          >
            &times;
          </button>
        </div>

        <div className="pricing-modal-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "pricing"}
            className={`pricing-modal-tab ${activeTab === "pricing" ? "active" : ""}`}
            onClick={() => setActiveTab("pricing")}
          >
            💰 Rates & Pricing
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "info"}
            className={`pricing-modal-tab ${activeTab === "info" ? "active" : ""}`}
            onClick={() => setActiveTab("info")}
          >
            ℹ️ Shop & Privacy
          </button>
        </div>

        {activeTab === "pricing" ? (
          <>
            {config.availablePrintOptions &&
            config.availablePrintOptions.length > 0 ? (
              <section className="pricing-info-section">
                <h3>Printing Rates</h3>
                <table className="pricing-table">
                  <thead>
                    <tr>
                      <th>Option</th>
                      <th>Sides</th>
                      <th>Rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {config.availablePrintOptions.map((opt) => (
                      <tr
                        key={`${opt.paperSize}-${opt.colorMode}-${opt.sides}`}
                      >
                        <td>
                          {opt.paperSize}{" "}
                          {opt.colorMode === "BW" ? "B&W" : "Colour"}
                        </td>
                        <td>
                          {opt.sides === "SINGLE"
                            ? "Single-sided"
                            : "Double-sided"}
                        </td>
                        <td>
                          {opt.pricePerPagePaise !== undefined
                            ? `₹${(opt.pricePerPagePaise / 100).toFixed(2)} / page`
                            : "Standard"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            ) : null}

            {config.addonServices && config.addonServices.length > 0 ? (
              <section className="pricing-info-section">
                <h3>Add-on Services</h3>
                <ul className="pricing-addon-list">
                  {config.addonServices.map((svc) => (
                    <li key={svc.id}>
                      <strong>{svc.name}</strong>
                      <span>
                        {svc.pricingType === "STAFF_PRICED"
                          ? "Price decided by staff"
                          : svc.fixedPricePaise === 0
                            ? "FREE"
                            : `₹${(svc.fixedPricePaise / 100).toFixed(2)}`}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {config.priorityPrinting?.enabled ? (
              <section className="pricing-info-section">
                <h3>Priority Printing</h3>
                <p>
                  ⚡ Fast-track your print in the queue for an additional{" "}
                  <strong>
                    ₹{(config.priorityPrinting.feePaise / 100).toFixed(2)}
                  </strong>
                  .
                </p>
              </section>
            ) : null}

            {config.discountRules && config.discountRules.length > 0 ? (
              <section className="pricing-info-section">
                <h3>Volume Discounts</h3>
                <ul className="pricing-addon-list">
                  {config.discountRules.map((rule) => (
                    <li key={rule.id}>
                      <span>
                        Orders above ₹{(rule.minSubtotalPaise / 100).toFixed(0)}
                      </span>
                      <strong style={{ color: "#16754A" }}>
                        {rule.discountPercent}% OFF
                      </strong>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        ) : (
          <>
            {config.shopName || config.contactPhone || config.address ? (
              <section className="pricing-info-section">
                <h3>Shop Details</h3>
                {config.shopName && (
                  <p>
                    <strong>{config.shopName}</strong>
                  </p>
                )}
                {config.address && (
                  <p style={{ color: "#475569", margin: "0.25rem 0" }}>
                    📍 {config.address}
                  </p>
                )}
                {config.contactPhone && (
                  <p style={{ marginTop: "0.35rem" }}>
                    📞 Contact:{" "}
                    <a
                      href={`tel:${config.contactPhone}`}
                      style={{
                        fontWeight: 700,
                        color: "#166534",
                        textDecoration: "underline",
                      }}
                    >
                      {config.contactPhone}
                    </a>
                  </p>
                )}
                {config.pickupSchedule?.enabled && (
                  <p
                    style={{
                      fontSize: "0.85rem",
                      color: "#64748b",
                      marginTop: "0.35rem",
                    }}
                  >
                    🕒 Opening hours: {config.pickupSchedule.openingTime} -{" "}
                    {config.pickupSchedule.closingTime}
                  </p>
                )}
              </section>
            ) : null}

            {config.customerNotice ? (
              <section className="pricing-info-section">
                <h3>Notice</h3>
                <p
                  style={{
                    background: "#fffdf5",
                    border: "1px solid #fef08a",
                    padding: "0.6rem 0.85rem",
                    borderRadius: "8px",
                    color: "#854d0e",
                  }}
                >
                  {config.customerNotice}
                </p>
              </section>
            ) : null}

            <section className="pricing-info-section">
              <h3>🔒 Zero-Retention Privacy Policy</h3>
              <ul
                style={{
                  paddingLeft: "1.2rem",
                  margin: "0.5rem 0",
                  fontSize: "0.85rem",
                  color: "#334155",
                  lineHeight: 1.6,
                }}
              >
                <li>
                  <strong>Private Storage:</strong> Uploaded documents are
                  stored in private cloud storage and never made publicly
                  accessible.
                </li>
                <li>
                  <strong>Automatic Deletion:</strong> Printed files are
                  permanently deleted from storage within{" "}
                  <strong>1 hour</strong> after printing.
                </li>
                <li>
                  <strong>Customer Privacy:</strong> Any customer contact info
                  and instructions are wiped after <strong>5 hours</strong>.
                </li>
                <li>
                  <strong>Unpaid Drafts:</strong> Unpaid files and expired
                  sessions are purged automatically within 10–30 minutes.
                </li>
              </ul>
            </section>
          </>
        )}

        <div className="pricing-modal-footer">
          <button
            type="button"
            className="primary-button fit"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
