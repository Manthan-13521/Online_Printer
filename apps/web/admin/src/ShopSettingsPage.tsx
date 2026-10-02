import { applyShopBranding } from "../../branding";
import type {
  AdminCleanupPreviewData,
  AdminCleanupRunData,
  CleanupScope,
  ShopSettings,
} from "@printgo/api-contract";
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
  const [cleanupScope, setCleanupScope] = useState<Extract<
    CleanupScope,
    "ALL_COMPLETED" | "ALL_PRINT_DATA"
  > | null>(null);
  const [cleanupPreview, setCleanupPreview] =
    useState<AdminCleanupPreviewData | null>(null);
  const [cleanupResult, setCleanupResult] =
    useState<AdminCleanupRunData | null>(null);
  const [cleanupConfirmation, setCleanupConfirmation] = useState("");
  const [cleanupBusy, setCleanupBusy] = useState(false);
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
        const normalized =
          loaded.idRequirementMode !== undefined
            ? {
                ...loaded,
                idRequirementMode: "OFF" as const,
                idThresholdPaise: 0,
              }
            : loaded;
        setSettings(normalized);
        setSaved(normalized);
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
      const payload: ShopSettings = {
        ...settings,
        ...(settings.idRequirementMode !== undefined
          ? { idRequirementMode: "OFF", idThresholdPaise: 0 }
          : {}),
      };
      const response = await adminApi.updateSettings(payload);
      if (response.ok) {
        const loaded = response.data.settings;
        const normalized =
          loaded.idRequirementMode !== undefined
            ? {
                ...loaded,
                idRequirementMode: "OFF" as const,
                idThresholdPaise: 0,
              }
            : loaded;
        setSettings(normalized);
        setSaved(normalized);
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

  async function previewCleanup(
    scope: Extract<CleanupScope, "ALL_COMPLETED" | "ALL_PRINT_DATA">,
  ) {
    setCleanupBusy(true);
    setError(null);
    try {
      const response = await adminApi.cleanupPreview(scope);
      if (response.ok) {
        setCleanupScope(scope);
        setCleanupPreview(response.data);
        setCleanupConfirmation("");
      }
    } catch (caught) {
      if (caught instanceof AdminApiError && caught.status === 401)
        onSessionExpired(caught.message);
      else setError(friendlyAdminError(caught));
    } finally {
      setCleanupBusy(false);
    }
  }

  async function executeCleanup() {
    if (!cleanupScope || cleanupBusy) return;
    setCleanupBusy(true);
    setError(null);
    try {
      const response = await adminApi.startCleanup(
        cleanupScope,
        cleanupConfirmation,
      );
      if (response.ok) {
        setCleanupResult(response.data);
        setCleanupPreview(null);
        setCleanupScope(null);
        setCleanupConfirmation("");
        setMessage(
          "Cleanup run started. Remaining batches continue automatically.",
        );
      }
    } catch (caught) {
      if (caught instanceof AdminApiError && caught.status === 401)
        onSessionExpired(caught.message);
      else setError(friendlyAdminError(caught));
    } finally {
      setCleanupBusy(false);
    }
  }

  async function refreshCleanup() {
    if (!cleanupResult || cleanupBusy) return;
    setCleanupBusy(true);
    try {
      const response = await adminApi.getCleanupRun(cleanupResult.runId);
      if (response.ok) setCleanupResult(response.data);
    } catch (caught) {
      if (caught instanceof AdminApiError && caught.status === 401)
        onSessionExpired(caught.message);
      else setError(friendlyAdminError(caught));
    } finally {
      setCleanupBusy(false);
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
          <label className="switch-row">
            <span>{settings.onlinePrintingEnabled ? "On" : "Off"}</span>
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
          </label>
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
          <h2>Identification Sheet</h2>
          <label className="checkbox-row">
            <input
              checked={settings.identificationSheetEnabled}
              onChange={(event) =>
                patch({ identificationSheetEnabled: event.target.checked })
              }
              type="checkbox"
            />
            <span>Print one identification sheet for each order</span>
          </label>
          <p className="field-help">
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

        <section className="panel form-section">
          <h2>Storage &amp; Privacy</h2>
          <p className="field-help">
            Completed orders are automatically purged after 2 hours. Abandoned
            unpaid uploads are purged after 10 minutes.
          </p>
          <label className="checkbox-row">
            <input
              checked={settings.automaticDailyCleanupEnabled ?? false}
              onChange={(event) =>
                patch({ automaticDailyCleanupEnabled: event.target.checked })
              }
              type="checkbox"
            />
            <span>Automatic Daily Cleanup</span>
          </label>
          <label htmlFor="cleanup-time">Cleanup Time</label>
          <input
            id="cleanup-time"
            type="time"
            value={settings.dailyCleanupTime ?? "23:30"}
            onChange={(event) =>
              patch({ dailyCleanupTime: event.target.value })
            }
          />
          <label htmlFor="cleanup-timezone">Timezone (IANA)</label>
          <input
            id="cleanup-timezone"
            value={settings.timezone ?? "Asia/Kolkata"}
            onChange={(event) => patch({ timezone: event.target.value })}
          />
          <dl>
            <div>
              <dt>Last Cleanup</dt>
              <dd>{settings.lastCleanupAt ?? "Not yet run"}</dd>
            </div>
            <div>
              <dt>Next Cleanup</dt>
              <dd>{settings.nextCleanupAt ?? "Calculated after save"}</dd>
            </div>
            <div>
              <dt>Last Result</dt>
              <dd>{settings.lastCleanupResult ?? "—"}</dd>
            </div>
          </dl>
          <div className="dialog-actions">
            <button
              className="danger-button"
              disabled={cleanupBusy}
              onClick={() => void previewCleanup("ALL_COMPLETED")}
              type="button"
            >
              Free Printed Data
            </button>
            <button
              className="danger-button"
              disabled={cleanupBusy}
              onClick={() => void previewCleanup("ALL_PRINT_DATA")}
              type="button"
            >
              Free All Print Data
            </button>
          </div>
          {cleanupPreview && cleanupScope ? (
            <div
              className="confirm-dialog"
              role="alertdialog"
              aria-modal="false"
            >
              <h3>
                {cleanupScope === "ALL_COMPLETED"
                  ? "Free Printed Data"
                  : "Free All Print Data"}
              </h3>
              <p>
                This permanently deletes customer print files and related
                operational data. This cannot be undone.
              </p>
              <p>
                {cleanupPreview.orders} orders · {cleanupPreview.files} PDFs ·{" "}
                {Math.ceil(cleanupPreview.bytes / MIB)} MB.{" "}
                {cleanupPreview.active} active orders will be skipped.
                {cleanupPreview.limited
                  ? " Preview covers the first 100 due orders; cleanup continues in bounded batches."
                  : ""}
              </p>
              <label htmlFor="cleanup-confirmation">
                Type{" "}
                {cleanupScope === "ALL_COMPLETED" ? "FREE PRINTED" : "FREE ALL"}{" "}
                to confirm
              </label>
              <input
                id="cleanup-confirmation"
                value={cleanupConfirmation}
                onChange={(event) => setCleanupConfirmation(event.target.value)}
              />
              <div className="dialog-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setCleanupPreview(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="danger-button"
                  disabled={
                    cleanupConfirmation !==
                      (cleanupScope === "ALL_COMPLETED"
                        ? "FREE PRINTED"
                        : "FREE ALL") || cleanupBusy
                  }
                  onClick={() => void executeCleanup()}
                >
                  Permanently delete
                </button>
              </div>
            </div>
          ) : null}
          {cleanupResult ? (
            <div>
              <p role="status">
                Deleted: {cleanupResult.deletedOrders} orders /{" "}
                {cleanupResult.deletedFiles} PDFs. Active skipped:{" "}
                {cleanupResult.activeSkipped}. Failed: {cleanupResult.failures}.
                Status: {cleanupResult.status}.
              </p>
              {cleanupResult.status !== "COMPLETED" ? (
                <button
                  type="button"
                  disabled={cleanupBusy}
                  onClick={() => void refreshCleanup()}
                >
                  Refresh cleanup status
                </button>
              ) : null}
            </div>
          ) : null}
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
