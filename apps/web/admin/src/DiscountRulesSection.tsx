import type {
  AdminDiscountRule,
  AdminDiscountRuleRequest,
} from "@printgo/api-contract";
import { formatPaiseAsRupeesInput, parseRupeesToPaise } from "@printgo/pricing";
import { useState, type FormEvent } from "react";
import { adminApi, AdminApiError, friendlyAdminError } from "./api";

interface RuleDraft {
  minSubtotalRupees: string;
  discountPercent: string;
  enabled: boolean;
}

export function DiscountRulesSection({
  rules: initialRules,
  onSessionExpired,
}: {
  rules: AdminDiscountRule[];
  onSessionExpired: (message: string) => void;
}) {
  const [rules, setRules] = useState<AdminDiscountRule[]>(initialRules);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<RuleDraft>({
    minSubtotalRupees: "500",
    discountPercent: "5",
    enabled: true,
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function handleToggle(id: string, currentlyEnabled: boolean) {
    setError(null);
    setMessage(null);
    try {
      const res = await adminApi.toggleDiscountRule(id, !currentlyEnabled);
      if (res.ok) {
        setRules((prev) =>
          prev.map((r) => (r.id === id ? res.data.discountRule : r)),
        );
      }
    } catch (caught: unknown) {
      if (caught instanceof AdminApiError && caught.status === 401) {
        onSessionExpired("Your session has expired. Please sign in again.");
        return;
      }
      setError(friendlyAdminError(caught));
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Are you sure you want to delete this discount rule?")) return;
    setError(null);
    setMessage(null);
    try {
      const res = await adminApi.deleteDiscountRule(id);
      if (res.ok) {
        setRules((prev) => prev.filter((r) => r.id !== id));
        setMessage("Discount rule deleted.");
      }
    } catch (caught: unknown) {
      if (caught instanceof AdminApiError && caught.status === 401) {
        onSessionExpired("Your session has expired. Please sign in again.");
        return;
      }
      setError(friendlyAdminError(caught));
    }
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    const minSubtotalPaise = parseRupeesToPaise(draft.minSubtotalRupees);
    const discountPercent = parseFloat(draft.discountPercent);

    if (minSubtotalPaise == null || minSubtotalPaise <= 0) {
      setError("Please enter a valid qualifying threshold in ₹.");
      return;
    }
    if (
      isNaN(discountPercent) ||
      discountPercent <= 0 ||
      discountPercent > 100
    ) {
      setError("Discount percentage must be between 1% and 100%.");
      return;
    }

    setSubmitting(true);
    setError(null);
    setMessage(null);

    const payload: AdminDiscountRuleRequest = {
      minSubtotalPaise,
      discountPercent,
      enabled: draft.enabled,
    };

    try {
      const res = await adminApi.createDiscountRule(payload);
      if (res.ok) {
        setRules((prev) =>
          [...prev, res.data.discountRule].sort(
            (a, b) => a.minSubtotalPaise - b.minSubtotalPaise,
          ),
        );
        setAdding(false);
        setDraft({
          minSubtotalRupees: "1000",
          discountPercent: "10",
          enabled: true,
        });
        setMessage("Discount rule added.");
      }
    } catch (caught: unknown) {
      if (caught instanceof AdminApiError && caught.status === 401) {
        onSessionExpired("Your session has expired. Please sign in again.");
        return;
      }
      setError(friendlyAdminError(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="panel pricing-section">
      <div
        className="section-heading"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
        }}
      >
        <div>
          <h2>Order Value Discounts</h2>
          <p className="muted">
            Discounts apply to online printing subtotals. The highest qualifying
            threshold is applied (rules never stack).
          </p>
        </div>
        {!adding && (
          <button
            className="secondary-button fit"
            type="button"
            onClick={() => {
              setAdding(true);
              setError(null);
              setMessage(null);
            }}
          >
            + Add Discount Rule
          </button>
        )}
      </div>

      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {adding && (
        <form
          onSubmit={(e) => void handleCreate(e)}
          style={{
            marginTop: "1rem",
            padding: "1rem",
            border: "1px solid var(--border-color, #e2e8f0)",
            borderRadius: "8px",
            background: "var(--bg-subtle, #f8fafc)",
          }}
        >
          <h3 style={{ marginTop: 0 }}>New Discount Rule</h3>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "1rem",
              marginBottom: "1rem",
            }}
          >
            <div>
              <label htmlFor="new-discount-threshold">
                Above Order Value (₹)
              </label>
              <div className="money-input">
                <span aria-hidden="true">₹</span>
                <input
                  id="new-discount-threshold"
                  inputMode="decimal"
                  value={draft.minSubtotalRupees}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      minSubtotalRupees: e.target.value,
                    }))
                  }
                  required
                />
              </div>
            </div>
            <div>
              <label htmlFor="new-discount-percent">
                Discount Percentage (%)
              </label>
              <div className="money-input">
                <input
                  id="new-discount-percent"
                  type="number"
                  min="0.1"
                  max="100"
                  step="0.5"
                  value={draft.discountPercent}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, discountPercent: e.target.value }))
                  }
                  required
                />
                <span>%</span>
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              className="primary-button fit"
              type="submit"
              disabled={submitting}
            >
              {submitting ? "Saving…" : "Save Rule"}
            </button>
            <button
              className="secondary-button fit"
              type="button"
              onClick={() => {
                setAdding(false);
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="charge-list" style={{ marginTop: "1rem" }}>
        {rules.length === 0 ? (
          <p className="muted" style={{ padding: "1rem 0" }}>
            No discount rules configured.
          </p>
        ) : (
          rules.map((rule) => (
            <div
              key={rule.id}
              className="charge-row"
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "0.75rem 0",
                borderBottom: "1px solid var(--border-color, #e2e8f0)",
              }}
            >
              <div>
                <strong>
                  Above ₹{formatPaiseAsRupeesInput(rule.minSubtotalPaise)}
                </strong>
                <span
                  style={{ margin: "0 0.5rem", color: "var(--muted, #64748b)" }}
                >
                  →
                </span>
                <span
                  style={{
                    fontSize: "1.1rem",
                    fontWeight: "600",
                    color: "#16a34a",
                  }}
                >
                  {rule.discountPercent}% OFF
                </span>
              </div>
              <div
                style={{ display: "flex", alignItems: "center", gap: "1rem" }}
              >
                <label className="compact-toggle">
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    onChange={() => void handleToggle(rule.id, rule.enabled)}
                  />
                  <span>{rule.enabled ? "Active" : "Disabled"}</span>
                </label>
                <button
                  type="button"
                  onClick={() => void handleDelete(rule.id)}
                  style={{
                    background: "none",
                    border: "none",
                    color: "var(--danger, #dc2626)",
                    cursor: "pointer",
                    fontSize: "0.875rem",
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
