import { applyShopBranding } from "../../branding";
import type { ShopSettings } from "@printgo/api-contract";
import {
  FILE_SIZE_5_MIB,
  FILE_SIZE_10_MIB,
  FILE_SIZE_25_MIB,
  MIB,
} from "@printgo/domain";
import {
  ADDRESS_MAX_LENGTH,
  APP_NAME_MAX_LENGTH,
  CONTACT_PHONE_MAX_LENGTH,
  CUSTOMER_NOTICE_MAX_LENGTH,
  SHOP_NAME_MAX_LENGTH,
} from "@printgo/validation";
import { formatPaiseAsRupeesInput, parseRupeesToPaise } from "@printgo/pricing";
import { useEffect, useState, type FormEvent } from "react";

import {
  adminApi,
  AdminApiError,
  friendlyAdminError,
  brandingUrl,
} from "./api";
import { AdminPwaInstall } from "./AdminPwaInstall";

const PDF_LIMITS = [
  FILE_SIZE_5_MIB,
  FILE_SIZE_10_MIB,
  15 * MIB,
  20 * MIB,
  FILE_SIZE_25_MIB,
] as const;

export function ShopSettingsPage({
  onSessionExpired,
}: {
  onSessionExpired: (message: string) => void;
}) {
  const [settings, setSettings] = useState<ShopSettings | null>(null);
  const [saved, setSaved] = useState<ShopSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [logoBusy, setLogoBusy] = useState(false);
  const [confirmPause, setConfirmPause] = useState(false);
  const [resettingCode, setResettingCode] = useState(false);

  const dirty =
    settings !== null && JSON.stringify(settings) !== JSON.stringify(saved);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const response = await adminApi.getSettings();
      if (response.ok) {
        const loaded = response.data.settings;
        setSettings(loaded);
        setSaved(loaded);
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

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (saved?.appName) return applyShopBranding(saved.appName, true);
    return undefined;
  }, [saved?.appName]);

  function patch(update: Partial<ShopSettings>) {
    setSettings((current) => (current ? { ...current, ...update } : current));
    setMessage(null);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settings || saving || !dirty) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const response = await adminApi.updateSettings(settings);
      if (response.ok) {
        const loaded = response.data.settings;
        setSettings(loaded);
        setSaved(loaded);
        setMessage(response.data.message ?? "Shop settings saved.");
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

  async function changeLogo(file: File | null) {
    if (logoBusy) return;
    setLogoBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = file
        ? await adminApi.uploadLogo(file)
        : await adminApi.removeLogo();
      if (response.ok) {
        const logoUrl = response.data.logoUrl;
        setSettings((current) => (current ? { ...current, logoUrl } : current));
        setSaved((current) => (current ? { ...current, logoUrl } : current));
        setMessage(response.data.message);
      }
    } catch (caught) {
      if (caught instanceof AdminApiError && caught.status === 401)
        onSessionExpired(caught.message);
      else setError(friendlyAdminError(caught));
    } finally {
      setLogoBusy(false);
    }
  }

  async function handleResetPickupCode() {
    if (
      !window.confirm(
        "Reset next pickup code sequence back to PA-001? This only affects future orders.",
      )
    ) {
      return;
    }
    setResettingCode(true);
    setError(null);
    setMessage(null);
    try {
      const res = await adminApi.resetPickupCode();
      if (res.ok) {
        patch({ nextPickupCode: res.data.nextPickupCode });
        setMessage(res.data.message);
      }
    } catch (caught: unknown) {
      if (caught instanceof AdminApiError && caught.status === 401) {
        onSessionExpired("Your session has expired. Please sign in again.");
        return;
      }
      setError(friendlyAdminError(caught));
    } finally {
      setResettingCode(false);
    }
  }

  if (loading) {
    return (
      <div className="panel page-loading" aria-busy="true">
        Loading shop settings…
      </div>
    );
  }
  if (!settings) {
    return (
      <div className="panel">
        <h1>Shop Settings</h1>
        <p className="form-error" role="alert">
          {error ?? "Shop settings are not available."}
        </p>
        <button
          className="secondary-button"
          onClick={() => void load()}
          type="button"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="page-stack settings-page">
      <div>
        <p className="eyebrow">Business configuration</p>
        <h1>Shop Settings</h1>
        <p className="page-intro">
          Update the details and controls customers will rely on.
        </p>
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
      <form onSubmit={(event) => void save(event)}>
        <section className="panel form-section">
          <h2>Branding &amp; shop details</h2>
          <label htmlFor="app-name">App name *</label>
          <input
            id="app-name"
            maxLength={APP_NAME_MAX_LENGTH}
            required
            value={settings.appName ?? "PrintGo"}
            onChange={(event) => patch({ appName: event.target.value })}
          />
          <label htmlFor="shop-name">Shop name *</label>
          <input
            id="shop-name"
            maxLength={SHOP_NAME_MAX_LENGTH}
            required
            value={settings.shopName}
            onChange={(event) => patch({ shopName: event.target.value })}
          />
          <label htmlFor="shop-logo">Shop logo (optional)</label>
          {settings.logoUrl ? (
            <img
              src={brandingUrl(settings.logoUrl)}
              alt="Current shop logo"
              style={{ maxWidth: 160, maxHeight: 100, objectFit: "contain" }}
            />
          ) : null}
          <input
            id="shop-logo"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            disabled={logoBusy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void changeLogo(file);
              event.target.value = "";
            }}
          />
          <p className="field-help">
            PNG, JPEG or WebP, up to 1 MB. Choosing a file saves the logo
            immediately.
          </p>
          {settings.logoUrl ? (
            <button
              type="button"
              disabled={logoBusy}
              className="secondary-button"
              onClick={() => void changeLogo(null)}
            >
              Remove logo
            </button>
          ) : null}
          <label htmlFor="contact-phone">Contact phone</label>
          <input
            id="contact-phone"
            inputMode="tel"
            maxLength={CONTACT_PHONE_MAX_LENGTH}
            value={settings.contactPhone ?? ""}
            onChange={(event) =>
              patch({ contactPhone: event.target.value || null })
            }
          />
          <label htmlFor="shop-address">Address</label>
          <textarea
            id="shop-address"
            maxLength={ADDRESS_MAX_LENGTH}
            rows={4}
            value={settings.address ?? ""}
            onChange={(event) => patch({ address: event.target.value || null })}
          />
          <label htmlFor="customer-notice">Customer notice</label>
          <textarea
            id="customer-notice"
            maxLength={CUSTOMER_NOTICE_MAX_LENGTH}
            rows={3}
            value={settings.customerNotice ?? ""}
            onChange={(event) =>
              patch({ customerNotice: event.target.value || null })
            }
          />
          <p className="field-help">Plain text only. Shown to customers.</p>
        </section>

        <section className="panel setting-card important-setting">
          <div>
            <h2>Online Printing</h2>
            <p className="muted">
              Controls whether the shop accepts new online work.
            </p>
          </div>
          <div
            style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}
          >
            <span style={{ fontWeight: "bold", fontSize: "0.95rem" }}>
              {settings.onlinePrintingEnabled ? "On" : "Off"}
            </span>
            <label className="toggle-switch">
              <input
                aria-label="Accept online printing"
                checked={settings.onlinePrintingEnabled}
                onChange={(event) => {
                  if (!event.target.checked && settings.onlinePrintingEnabled)
                    setConfirmPause(true);
                  else patch({ onlinePrintingEnabled: event.target.checked });
                }}
                role="switch"
                type="checkbox"
              />
              <span className="toggle-slider" />
            </label>
          </div>
        </section>

        <section className="panel form-section">
          <h2>PDF upload limit</h2>
          <label htmlFor="pdf-limit">Maximum PDF size</label>
          <select
            id="pdf-limit"
            value={settings.maxPdfSizeBytes}
            onChange={(event) =>
              patch({ maxPdfSizeBytes: Number(event.target.value) })
            }
          >
            {PDF_LIMITS.map((bytes) => (
              <option key={bytes} value={bytes}>
                {bytes / MIB} MB
              </option>
            ))}
          </select>
          <p className="field-help">
            Stored and enforced as binary MiB. The maximum is 25 MB.
          </p>
          <label htmlFor="order-upload-limit">Maximum total per order</label>
          <select
            id="order-upload-limit"
            value={settings.maxOrderUploadBytes ?? 100 * MIB}
            onChange={(event) =>
              patch({ maxOrderUploadBytes: Number(event.target.value) })
            }
          >
            {[25, 50, 75, 100].map((megabytes) => (
              <option key={megabytes} value={megabytes * MIB}>
                {megabytes} MB
              </option>
            ))}
          </select>
        </section>

        <section className="panel form-section">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-start",
              gap: "1rem",
              marginBottom: "0.5rem",
            }}
          >
            <h2 style={{ margin: 0 }}>Identification Sheet</h2>
            <div
              style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}
            >
              <span style={{ fontWeight: "bold", fontSize: "0.95rem" }}>
                {settings.identificationSheetEnabled ? "On" : "Off"}
              </span>
              <label className="toggle-switch">
                <input
                  aria-label="Print one identification sheet for each order"
                  checked={Boolean(settings.identificationSheetEnabled)}
                  onChange={(event) =>
                    patch({ identificationSheetEnabled: event.target.checked })
                  }
                  role="switch"
                  type="checkbox"
                />
                <span className="toggle-slider" />
              </label>
            </div>
          </div>
          <p className="field-help" style={{ margin: "0 0 0.75rem 0" }}>
            Adds one shop identification sheet per order for sorting printed
            jobs. Customers are not charged for this sheet.
          </p>
          <fieldset disabled={!settings.identificationSheetEnabled}>
            <legend>Placement</legend>
            <label className="radio-row">
              <input
                checked={settings.identificationSheetPlacement === "FIRST"}
                name="placement"
                onChange={() =>
                  patch({ identificationSheetPlacement: "FIRST" })
                }
                type="radio"
              />
              <span>Print before document</span>
            </label>
            <label className="radio-row">
              <input
                checked={settings.identificationSheetPlacement === "LAST"}
                name="placement"
                onChange={() => patch({ identificationSheetPlacement: "LAST" })}
                type="radio"
              />
              <span>Print after document</span>
            </label>
          </fieldset>

          <fieldset
            disabled={!settings.identificationSheetEnabled}
            style={{
              border: 0,
              padding: 0,
              margin: 0,
              minInlineSize: 0,
              display: "grid",
              gap: "0.35rem",
              paddingTop: "1rem",
              borderTop: "1px solid #e2e8f0",
              opacity: settings.identificationSheetEnabled ? 1 : 0.6,
            }}
          >
            <h3
              style={{
                margin: "0.25rem 0",
                fontSize: "1.05rem",
                color: "#1e293b",
              }}
            >
              Customer Identification at Pickup
            </h3>
            <p className="field-help">
              Require customer identification when collecting their orders. No
              sensitive identity documents, Aadhaar numbers, or photos are ever
              collected or stored.
            </p>
            <label htmlFor="id-requirement-mode">Identification policy</label>
            <select
              id="id-requirement-mode"
              disabled={!settings.identificationSheetEnabled}
              value={settings.idRequirementMode ?? "ALWAYS"}
              onChange={(event) =>
                patch({
                  idRequirementMode: event.target.value as
                    "ALWAYS" | "ABOVE_THRESHOLD",
                })
              }
            >
              <option value="ALWAYS">Always required</option>
              <option value="ABOVE_THRESHOLD">
                Required only above order amount
              </option>
            </select>

            {settings.idRequirementMode === "ABOVE_THRESHOLD" ? (
              <div
                style={{ display: "grid", gap: "0.35rem", marginTop: "0.5rem" }}
              >
                <label htmlFor="id-threshold-amount">
                  Minimum order amount (₹)
                </label>
                <input
                  id="id-threshold-amount"
                  type="number"
                  min="1"
                  step="1"
                  disabled={!settings.identificationSheetEnabled}
                  value={
                    settings.idThresholdPaise !== undefined
                      ? formatPaiseAsRupeesInput(settings.idThresholdPaise)
                      : "500"
                  }
                  onChange={(event) =>
                    patch({
                      idThresholdPaise:
                        parseRupeesToPaise(event.target.value || "0") ?? 0,
                    })
                  }
                />
                <p className="field-help">
                  Orders with online printing total equal to or above this
                  amount will require customer ID at pickup.
                </p>
              </div>
            ) : null}
          </fieldset>
        </section>

        <section className="panel form-section">
          <h2>Pickup Codes</h2>
          <p className="field-help">
            Sequential codes (PA-001 through PZ-999) assigned to paid orders for
            safe, collision-free customer identification.
          </p>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "1rem",
              flexWrap: "wrap",
              marginTop: "0.5rem",
            }}
          >
            <div>
              <span
                className="muted"
                style={{ display: "block", fontSize: "0.85rem" }}
              >
                Next code to be assigned:
              </span>
              <strong style={{ fontSize: "1.25rem", letterSpacing: "1px" }}>
                {settings.nextPickupCode ?? "PA-001"}
              </strong>
            </div>
            <button
              type="button"
              className="secondary-button"
              disabled={resettingCode}
              onClick={() => void handleResetPickupCode()}
            >
              {resettingCode ? "Resetting…" : "Reset next code to PA-001"}
            </button>
          </div>
          <p className="field-help">
            Resetting takes effect only on future orders and will never
            overwrite or conflict with currently active codes.
          </p>
        </section>

        <div className="save-bar">
          <span className={dirty ? "unsaved" : "saved-state"}>
            {dirty ? "Unsaved changes" : "All changes saved"}
          </span>
          <button
            className="primary-button fit"
            disabled={!dirty || saving}
            type="submit"
          >
            {saving ? "Saving…" : "Save Changes"}
          </button>
        </div>
      </form>

      <AdminPwaInstall />

      {confirmPause ? (
        <div className="dialog-backdrop">
          <section
            aria-labelledby="pause-title"
            aria-modal="true"
            className="confirm-dialog"
            role="dialog"
          >
            <h2 id="pause-title">Pause new online print orders?</h2>
            <p>
              New customers will not be able to upload or pay. Existing paid
              jobs will continue.
            </p>
            <div className="dialog-actions">
              <button
                className="secondary-button"
                onClick={() => setConfirmPause(false)}
                type="button"
              >
                Cancel
              </button>
              <button
                className="danger-button"
                onClick={() => {
                  patch({ onlinePrintingEnabled: false });
                  setConfirmPause(false);
                }}
                type="button"
              >
                Pause Printing
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
