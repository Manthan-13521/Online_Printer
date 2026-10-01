import type {
  AdminAddonService,
  AdminAddonServiceRequest,
  HandlingMode,
  PricingType,
} from "@printgo/api-contract";
import { formatPaiseAsRupeesInput, parseRupeesToPaise } from "@printgo/pricing";
import { useState, type FormEvent } from "react";
import { adminApi, AdminApiError, friendlyAdminError } from "./api";

const HANDLING_LABELS: Record<HandlingMode, string> = {
  AUTO: "Automatic",
  POST_PRINT: "Print Automatically + Staff Finishing",
  MANUAL_PRINT: "Manual Printing Required",
};

const PRICING_LABELS: Record<PricingType, string> = {
  FIXED_PRICE: "Fixed Price",
  STAFF_PRICED: "Staff Priced",
};

interface ServiceDraft {
  id?: string;
  name: string;
  pricingType: PricingType;
  fixedPriceRupees: string;
  handlingMode: HandlingMode;
  enabled: boolean;
  displayOrder: string;
}

function newDraft(service?: AdminAddonService): ServiceDraft {
  return {
    ...(service?.id ? { id: service.id } : {}),
    name: service?.name ?? "",
    pricingType: service?.pricingType ?? "FIXED_PRICE",
    fixedPriceRupees:
      service?.fixedPricePaise != null
        ? formatPaiseAsRupeesInput(service.fixedPricePaise)
        : "0",
    handlingMode: service?.handlingMode ?? "POST_PRINT",
    enabled: service?.enabled ?? true,
    displayOrder: String(service?.displayOrder ?? 0),
  };
}

function formatServicePrice(service: AdminAddonService): string {
  if (service.pricingType === "STAFF_PRICED") return "Staff Priced";
  if (service.fixedPricePaise === 0 || service.fixedPricePaise == null)
    return "Free";
  return `₹${(service.fixedPricePaise / 100).toFixed(2)}`;
}

export function AddonServicesSection({
  services: initialServices,
  onSessionExpired,
}: {
  services: AdminAddonService[];
  onSessionExpired: (message: string) => void;
}) {
  const [services, setServices] = useState(initialServices);
  const [editing, setEditing] = useState<ServiceDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  function startNew() {
    setEditing(newDraft());
    setError(null);
    setMessage(null);
  }

  function startEdit(service: AdminAddonService) {
    setEditing(newDraft(service));
    setError(null);
    setMessage(null);
  }

  function cancelEdit() {
    setEditing(null);
    setError(null);
  }

  async function saveService(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing || saving) return;

    const fixedPricePaise =
      editing.pricingType === "FIXED_PRICE"
        ? (parseRupeesToPaise(editing.fixedPriceRupees) ?? null)
        : null;

    if (editing.pricingType === "FIXED_PRICE" && fixedPricePaise === null) {
      setError("Enter a valid price in rupees (e.g. 0, 30, or 5.50).");
      return;
    }

    const displayOrder = parseInt(editing.displayOrder, 10);
    if (isNaN(displayOrder) || displayOrder < 0) {
      setError("Display order must be a non-negative number.");
      return;
    }

    const input: AdminAddonServiceRequest = {
      name: editing.name.trim(),
      pricingType: editing.pricingType,
      fixedPricePaise,
      handlingMode: editing.handlingMode,
      enabled: editing.enabled,
      displayOrder,
    };

    setSaving(true);
    setError(null);
    try {
      let response;
      if (editing.id) {
        response = await adminApi.updateAddonService(editing.id, input);
      } else {
        response = await adminApi.createAddonService(input);
      }
      if (response.ok) {
        const updated = response.data.addonService;
        setServices((prev) =>
          editing.id
            ? prev.map((s) => (s.id === editing.id ? updated : s))
            : [...prev, updated],
        );
        setEditing(null);
        setMessage(editing.id ? "Service updated." : "Service created.");
      }
    } catch (caught: unknown) {
      if (caught instanceof AdminApiError && caught.status === 401) {
        onSessionExpired("Your session has expired. Please sign in again.");
        return;
      }
      setError(friendlyAdminError(caught));
    } finally {
      setSaving(false);
    }
  }

  async function deleteService(id: string, name: string) {
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
    try {
      const response = await adminApi.deleteAddonService(id);
      if (response.ok) {
        setServices((prev) => prev.filter((s) => s.id !== id));
        setMessage("Service deleted.");
      }
    } catch (caught: unknown) {
      if (caught instanceof AdminApiError && caught.status === 401) {
        onSessionExpired("Your session has expired. Please sign in again.");
        return;
      }
      setError(friendlyAdminError(caught));
    }
  }

  async function toggleService(id: string, enabled: boolean) {
    try {
      const response = await adminApi.toggleAddonService(id, enabled);
      if (response.ok) {
        const updated = response.data.addonService;
        setServices((prev) => prev.map((s) => (s.id === id ? updated : s)));
      }
    } catch (caught: unknown) {
      if (caught instanceof AdminApiError && caught.status === 401) {
        onSessionExpired("Your session has expired. Please sign in again.");
        return;
      }
      setError(friendlyAdminError(caught));
    }
  }

  return (
    <section className="panel pricing-section">
      <div className="section-heading">
        <div>
          <h2>Add-on Services</h2>
          <p className="muted">
            Services customers can select when placing an order.
          </p>
        </div>
        <button
          className="secondary-button fit"
          onClick={startNew}
          type="button"
        >
          + Add Service
        </button>
      </div>

      {message ? (
        <p className="notice" role="status">
          {message}
        </p>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      {editing ? (
        <form
          className="addon-service-form"
          onSubmit={(e) => void saveService(e)}
        >
          <h3>{editing.id ? "Edit Service" : "New Service"}</h3>
          <div className="form-field">
            <label htmlFor="addon-name">Name</label>
            <input
              id="addon-name"
              required
              maxLength={100}
              value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            />
          </div>
          <div className="form-field">
            <label>Pricing</label>
            <div className="radio-group">
              {(["FIXED_PRICE", "STAFF_PRICED"] as PricingType[]).map((pt) => (
                <label key={pt} className="radio-label">
                  <input
                    type="radio"
                    name="pricingType"
                    value={pt}
                    checked={editing.pricingType === pt}
                    onChange={() => setEditing({ ...editing, pricingType: pt })}
                  />
                  {PRICING_LABELS[pt]}
                </label>
              ))}
            </div>
          </div>
          {editing.pricingType === "FIXED_PRICE" ? (
            <div className="form-field">
              <label htmlFor="addon-price">Price (₹)</label>
              <div className="money-input">
                <span aria-hidden="true">₹</span>
                <input
                  id="addon-price"
                  inputMode="decimal"
                  value={editing.fixedPriceRupees}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      fixedPriceRupees: e.target.value,
                    })
                  }
                />
              </div>
              <p className="field-help">Enter 0 to show as FREE.</p>
            </div>
          ) : (
            <p className="field-help">
              Staff Priced — customer pays ₹0 online; you set the charge at
              pickup.
            </p>
          )}
          <div className="form-field">
            <label>Handling</label>
            <div className="radio-group">
              {(["AUTO", "POST_PRINT", "MANUAL_PRINT"] as HandlingMode[]).map(
                (hm) => (
                  <label key={hm} className="radio-label">
                    <input
                      type="radio"
                      name="handlingMode"
                      value={hm}
                      checked={editing.handlingMode === hm}
                      onChange={() =>
                        setEditing({ ...editing, handlingMode: hm })
                      }
                    />
                    {HANDLING_LABELS[hm]}
                  </label>
                ),
              )}
            </div>
          </div>
          <div className="form-field">
            <label htmlFor="addon-order">Display Order</label>
            <input
              id="addon-order"
              type="number"
              min={0}
              value={editing.displayOrder}
              onChange={(e) =>
                setEditing({ ...editing, displayOrder: e.target.value })
              }
            />
          </div>
          <label className="compact-toggle">
            <input
              type="checkbox"
              checked={editing.enabled}
              onChange={(e) =>
                setEditing({ ...editing, enabled: e.target.checked })
              }
            />
            <span>Enabled (visible to customers)</span>
          </label>
          <div className="form-actions">
            <button
              className="primary-button fit"
              type="submit"
              disabled={saving}
            >
              {saving
                ? "Saving…"
                : editing.id
                  ? "Update Service"
                  : "Create Service"}
            </button>
            <button
              className="secondary-button fit"
              type="button"
              onClick={cancelEdit}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {services.length === 0 && !editing ? (
        <p className="muted">
          No add-on services configured. Click &quot;+ Add Service&quot; to
          create one.
        </p>
      ) : null}

      {services.length > 0 ? (
        <div className="addon-service-list">
          {services.map((service) => (
            <div className="addon-service-row" key={service.id}>
              <div className="addon-service-info">
                <strong>{service.name}</strong>
                <span className="muted">
                  {formatServicePrice(service)} ·{" "}
                  {HANDLING_LABELS[service.handlingMode]}
                </span>
              </div>
              <div className="addon-service-actions">
                <label className="compact-toggle">
                  <input
                    type="checkbox"
                    checked={service.enabled}
                    onChange={(e) =>
                      void toggleService(service.id, e.target.checked)
                    }
                    aria-label={`${service.enabled ? "Disable" : "Enable"} ${service.name}`}
                  />
                  <span>{service.enabled ? "Enabled" : "Disabled"}</span>
                </label>
                <button
                  className="secondary-button fit"
                  type="button"
                  onClick={() => startEdit(service)}
                >
                  Edit
                </button>
                <button
                  className="danger-button fit"
                  type="button"
                  onClick={() => void deleteService(service.id, service.name)}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
