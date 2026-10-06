import type {
  AdminCleanupPreviewData,
  AdminCleanupRunData,
  CleanupScope,
  ShopSettings,
} from "@printgo/api-contract";
import { MIB } from "@printgo/domain";
import { useEffect, useState, type FormEvent } from "react";
import { adminApi, AdminApiError, friendlyAdminError } from "./api";

function formatCleanupDateTime(iso: string | null | undefined): string {
  if (!iso) return "Not yet run";
  const date = new Date(iso);
  if (isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function StoragePrivacySection({
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

  const dirty =
    settings !== null && JSON.stringify(settings) !== JSON.stringify(saved);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const response = await adminApi.getSettings();
      if (response.ok) {
        setSettings(response.data.settings);
        setSaved(response.data.settings);
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
        setSettings(response.data.settings);
        setSaved(response.data.settings);
        setMessage(response.data.message ?? "Storage settings saved.");
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

  if (loading) {
    return (
      <section className="panel form-section" aria-busy="true">
        <h2>Storage &amp; Privacy</h2>
        <p className="muted">Loading storage settings…</p>
      </section>
    );
  }

  if (!settings) {
    return (
      <section className="panel form-section">
        <h2>Storage &amp; Privacy</h2>
        <p className="form-error" role="alert">
          {error ?? "Storage settings are not available."}
        </p>
        <button
          className="secondary-button"
          onClick={() => void load()}
          type="button"
        >
          Try again
        </button>
      </section>
    );
  }

  return (
    <>
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
          <h2>Storage &amp; Privacy</h2>
          <p className="field-help">
            Completed orders are automatically purged after{" "}
            {settings.orderRetentionHours ?? 2} hour
            {(settings.orderRetentionHours ?? 2) === 1 ? "" : "s"}. Abandoned
            unpaid uploads are purged after 10 minutes.
          </p>
          <label htmlFor="order-retention-hours">
            Completed Order &amp; PDF Retention
          </label>
          <select
            id="order-retention-hours"
            value={settings.orderRetentionHours ?? 2}
            onChange={(event) =>
              patch({ orderRetentionHours: Number(event.target.value) })
            }
          >
            <option value={1}>1 hour</option>
            <option value={2}>2 hours (default)</option>
            <option value={3}>3 hours</option>
            <option value={6}>6 hours</option>
            <option value={12}>12 hours</option>
          </select>
          <p className="field-help">
            Choose how long completed order details and customer PDFs remain
            before automatic deletion.
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
          <dl className="settings-stat-grid">
            <div className="stat-card">
              <dt>Last Cleanup</dt>
              <dd>{formatCleanupDateTime(settings.lastCleanupAt)}</dd>
            </div>
            <div className="stat-card">
              <dt>Next Cleanup</dt>
              <dd>
                {settings.nextCleanupAt
                  ? formatCleanupDateTime(settings.nextCleanupAt)
                  : "Calculated after save"}
              </dd>
            </div>
            <div className="stat-card">
              <dt>Last Result</dt>
              <dd>{settings.lastCleanupResult ?? "—"}</dd>
            </div>
          </dl>
          <div className="dialog-actions" style={{ marginTop: "0.5rem" }}>
            <button
              className="danger-button subtle"
              disabled={cleanupBusy}
              onClick={() => void previewCleanup("ALL_COMPLETED")}
              type="button"
            >
              Free Printed Data
            </button>
            <button
              className="danger-button subtle"
              disabled={cleanupBusy}
              onClick={() => void previewCleanup("ALL_PRINT_DATA")}
              type="button"
            >
              Free All Print Data
            </button>
          </div>
          {cleanupResult ? (
            <div
              className={`notice ${cleanupResult.status === "FAILED" ? "form-error" : ""}`}
              style={{
                marginTop: "0.75rem",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                flexWrap: "wrap",
                gap: "0.75rem",
              }}
            >
              <div>
                <strong style={{ textTransform: "capitalize" }}>
                  Cleanup {cleanupResult.status.toLowerCase()}:
                </strong>{" "}
                <span>
                  Deleted {cleanupResult.deletedOrders} orders (
                  {cleanupResult.deletedFiles} PDFs)
                  {cleanupResult.activeSkipped > 0
                    ? ` · ${cleanupResult.activeSkipped} active skipped`
                    : ""}
                  {cleanupResult.failures > 0
                    ? ` · ${cleanupResult.failures} failed`
                    : ""}
                  .
                </span>
              </div>
              {cleanupResult.status !== "COMPLETED" ? (
                <button
                  type="button"
                  className="secondary-button"
                  style={{
                    minHeight: "2.2rem",
                    padding: "0.35rem 0.85rem",
                    fontSize: "0.85rem",
                  }}
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

      {cleanupPreview && cleanupScope ? (
        <div className="dialog-backdrop">
          <section
            aria-labelledby="cleanup-dialog-title"
            aria-modal="true"
            className="confirm-dialog"
            role="dialog"
          >
            <h2 id="cleanup-dialog-title">
              {cleanupScope === "ALL_COMPLETED"
                ? "Free Printed Data"
                : "Free All Print Data"}
            </h2>
            <p>
              This permanently deletes customer print files and related
              operational data. This cannot be undone.
            </p>
            <p className="field-help" style={{ margin: "0.5rem 0" }}>
              <strong>{cleanupPreview.orders}</strong> orders ·{" "}
              <strong>{cleanupPreview.files}</strong> PDFs ·{" "}
              <strong>{Math.ceil(cleanupPreview.bytes / MIB)} MB</strong>.{" "}
              {cleanupPreview.active} active orders will be skipped.
              {cleanupPreview.limited
                ? " Preview covers the first 100 due orders; cleanup continues in bounded batches."
                : ""}
            </p>
            <label
              htmlFor="cleanup-confirmation"
              style={{ display: "block", marginTop: "0.75rem" }}
            >
              Type{" "}
              <strong style={{ color: "#dc2626" }}>
                {cleanupScope === "ALL_COMPLETED" ? "FREE PRINTED" : "FREE ALL"}
              </strong>{" "}
              to confirm
            </label>
            <input
              id="cleanup-confirmation"
              value={cleanupConfirmation}
              onChange={(event) => setCleanupConfirmation(event.target.value)}
              placeholder={
                cleanupScope === "ALL_COMPLETED" ? "FREE PRINTED" : "FREE ALL"
              }
              autoComplete="off"
            />
            <div className="dialog-actions" style={{ marginTop: "1.25rem" }}>
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
                {cleanupBusy ? "Deleting…" : "Permanently delete"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
