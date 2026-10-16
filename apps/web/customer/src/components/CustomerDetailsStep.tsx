import type { CustomerConfigData } from "@printgo/api-contract";

export interface CustomerDetailsStepProps {
  customerName: string;
  onCustomerNameChange: (name: string) => void;
  customerPhone: string;
  onCustomerPhoneChange: (phone: string) => void;
  phoneError: string | null;
  onPhoneBlur: () => void;
  instructions: string;
  onInstructionsChange: (inst: string) => void;
  addonServices?: CustomerConfigData["addonServices"] | undefined;
  selectedAddonIds: string[];
  onToggleAddon: (id: string, checked: boolean) => void;
  disabled: boolean;
}

export function CustomerDetailsStep({
  customerName,
  onCustomerNameChange,
  customerPhone,
  onCustomerPhoneChange,
  phoneError,
  onPhoneBlur,
  instructions,
  onInstructionsChange,
  addonServices,
  selectedAddonIds,
  onToggleAddon,
  disabled,
}: CustomerDetailsStepProps) {
  return (
    <section className="step">
      <div className="step-header">
        <span className="step-number">1</span>
        <h2>Customer Details</h2>
        <p className="step-desc">
          Tell us a bit about yourself to get started.
        </p>
      </div>
      <div className="details-grid">
        <label>
          Name
          <div className="input-with-icon">
            <span className="icon">👤</span>
            <input
              required
              maxLength={120}
              aria-label="Name"
              value={customerName}
              onChange={(event) => onCustomerNameChange(event.target.value)}
            />
          </div>
        </label>
        <label>
          Phone
          <div className="input-with-icon">
            <span className="icon">📞</span>
            <input
              required
              maxLength={30}
              aria-label="Phone"
              inputMode="tel"
              pattern="[+0-9][0-9 ()-]{5,29}"
              value={customerPhone}
              onChange={(event) => onCustomerPhoneChange(event.target.value)}
              onBlur={onPhoneBlur}
            />
          </div>
          {phoneError ? (
            <span
              className="form-field-error"
              style={{
                display: "block",
                color: "#dc2626",
                fontSize: "0.8rem",
                fontWeight: 500,
                marginTop: "0.35rem",
              }}
              role="alert"
            >
              {phoneError}
            </span>
          ) : null}
        </label>
      </div>
      {addonServices && addonServices.length > 0 ? (
        <div className="addon-selection-group">
          <span className="addon-group-label">Add-on Services</span>
          <div className="addon-checkbox-list">
            {addonServices.map((service) => {
              const isSelected = selectedAddonIds.includes(service.id);
              return (
                <label
                  key={service.id}
                  className={`addon-checkbox-item ${isSelected ? "selected" : ""}`}
                >
                  <div className="addon-info">
                    <span className="addon-icon">
                      {service.name.toLowerCase().includes("bind")
                        ? "📖"
                        : service.name.toLowerCase().includes("staple")
                          ? "📎"
                          : "📄"}
                    </span>
                    <div>
                      <span className="addon-name">{service.name}</span>
                      <span className="addon-price-tag">
                        {service.pricingType === "STAFF_PRICED"
                          ? "Price decided by staff"
                          : service.fixedPricePaise === 0
                            ? "FREE"
                            : `+₹${(service.fixedPricePaise / 100).toFixed(2)}`}
                      </span>
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={isSelected}
                    disabled={disabled}
                    onChange={(e) =>
                      onToggleAddon(service.id, e.target.checked)
                    }
                  />
                </label>
              );
            })}
          </div>
        </div>
      ) : null}
      <label htmlFor="customer-inst">Instructions (optional)</label>
      <div className="input-with-icon textarea">
        <span className="icon">📝</span>
        <textarea
          placeholder="Any special instructions for your print job..."
          maxLength={500}
          aria-label="Instructions"
          id="customer-inst"
          value={instructions}
          onChange={(event) => onInstructionsChange(event.target.value)}
        />
      </div>
      <div className="char-count">{instructions.length}/500</div>
    </section>
  );
}
