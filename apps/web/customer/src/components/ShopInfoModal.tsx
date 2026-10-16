import type { CustomerConfigData } from "@printgo/api-contract";

export interface ShopInfoModalProps {
  isOpen: boolean;
  config: CustomerConfigData | null;
  onClose: () => void;
}

export function ShopInfoModal({ isOpen, config, onClose }: ShopInfoModalProps) {
  if (!isOpen || !config) return null;

  return (
    <div className="pricing-modal-backdrop" onClick={onClose}>
      <div
        className="pricing-modal-content"
        role="dialog"
        aria-modal="true"
        aria-labelledby="info-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pricing-modal-header">
          <h2 id="info-modal-title">Shop Information</h2>
          <button
            type="button"
            className="close-button"
            aria-label="Close"
            onClick={onClose}
          >
            &times;
          </button>
        </div>

        <div className="pricing-info-notice">
          <p>
            Most standard orders are automatically sent to the printer after
            successful payment. Orders requiring special/manual services are
            handled by shop staff and kept ready for collection.
          </p>
        </div>

        {config.customerNotice ? (
          <section className="pricing-info-section">
            <h3>Notice</h3>
            <p>{config.customerNotice}</p>
          </section>
        ) : null}

        {config.shopName || config.contactPhone || config.address ? (
          <section className="pricing-info-section">
            <h3>Shop Details</h3>
            <p>
              <strong>{config.shopName}</strong>
            </p>
            {config.address ? <p>{config.address}</p> : null}
            {config.contactPhone ? (
              <p>
                Phone:{" "}
                <a href={`tel:${config.contactPhone}`}>{config.contactPhone}</a>
              </p>
            ) : null}
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
