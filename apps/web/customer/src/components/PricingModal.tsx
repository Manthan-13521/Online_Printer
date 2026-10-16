import type { CustomerConfigData } from "@printgo/api-contract";

export interface PricingModalProps {
  isOpen: boolean;
  config: CustomerConfigData | null;
  onClose: () => void;
}

export function PricingModal({ isOpen, config, onClose }: PricingModalProps) {
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
          <h2 id="pricing-modal-title">Pricing &amp; Rates</h2>
          <button
            type="button"
            className="close-button"
            aria-label="Close"
            onClick={onClose}
          >
            &times;
          </button>
        </div>

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
                  <tr key={`${opt.paperSize}-${opt.colorMode}-${opt.sides}`}>
                    <td>
                      {opt.paperSize}{" "}
                      {opt.colorMode === "BW" ? "B&W" : "Colour"}
                    </td>
                    <td>
                      {opt.sides === "SINGLE" ? "Single-sided" : "Double-sided"}
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
