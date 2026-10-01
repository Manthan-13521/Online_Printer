import type {
  AdminAddonService,
  AdminFileSizeServiceCharge,
  AdminPrintRate,
  AdminPricingConfiguration,
} from "@printgo/api-contract";
import { MIB, type ColorMode, type PaperSize } from "@printgo/domain";
import { formatPaiseAsRupeesInput, parseRupeesToPaise } from "@printgo/pricing";
import { useEffect, useState, type FormEvent } from "react";

import { adminApi, AdminApiError, friendlyAdminError } from "./api";
import { AddonServicesSection } from "./AddonServicesSection";

interface RateDraft extends Omit<AdminPrintRate, "pricePerPagePaise"> {
  rupees: string;
}

interface ChargeDraft extends Omit<AdminFileSizeServiceCharge, "chargePaise"> {
  rupees: string;
}

interface PricingDraft {
  maxPdfSizeBytes: number;
  printRates: RateDraft[];
  fileSizeServiceCharges: ChargeDraft[];
}

const PAPER_LABELS: Record<PaperSize, string> = { A4: "A4", A3: "A3" };
const COLOR_LABELS: Record<ColorMode, string> = {
  BW: "Black & White",
  COLOR: "Colour",
};

function toDraft(pricing: AdminPricingConfiguration): PricingDraft {
  return {
    maxPdfSizeBytes: pricing.maxPdfSizeBytes,
    printRates: pricing.printRates.map(({ pricePerPagePaise, ...rate }) => ({
      ...rate,
      rupees: formatPaiseAsRupeesInput(pricePerPagePaise),
    })),
    fileSizeServiceCharges: pricing.fileSizeServiceCharges.map(
      ({ chargePaise, ...charge }) => ({
        ...charge,
        rupees: formatPaiseAsRupeesInput(chargePaise),
      }),
    ),
  };
}

function bandLabel(charge: ChargeDraft): string {
  const minimum = charge.minBytesExclusive / MIB;
  const maximum = charge.maxBytesInclusive / MIB;
  return minimum === 0 ? `Up to ${maximum} MB` : `${minimum}–${maximum} MB`;
}

export function PricingPage({
  onSessionExpired,
}: {
  onSessionExpired: (message: string) => void;
}) {
  const [draft, setDraft] = useState<PricingDraft | null>(null);
  const [saved, setSaved] = useState<PricingDraft | null>(null);
  const [addonServices, setAddonServices] = useState<AdminAddonService[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const dirty =
    draft !== null && JSON.stringify(draft) !== JSON.stringify(saved);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const response = await adminApi.getPricing();
      if (response.ok) {
        const next = toDraft(response.data.pricing);
        setDraft(next);
        setSaved(next);
        setAddonServices(response.data.pricing.addonServices ?? []);
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

  function updateRate(index: number, update: Partial<RateDraft>) {
    setDraft((current) =>
      current
        ? {
            ...current,
            printRates: current.printRates.map((rate, rateIndex) =>
              rateIndex === index ? { ...rate, ...update } : rate,
            ),
          }
        : current,
    );
    setMessage(null);
  }

  function updateCharge(index: number, rupees: string) {
    setDraft((current) =>
      current
        ? {
            ...current,
            fileSizeServiceCharges: current.fileSizeServiceCharges.map(
              (charge, chargeIndex) =>
                chargeIndex === index ? { ...charge, rupees } : charge,
            ),
          }
        : current,
    );
    setMessage(null);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || saving || !dirty) return;
    const printRates = draft.printRates.map(({ rupees, ...rate }) => ({
      ...rate,
      pricePerPagePaise: parseRupeesToPaise(rupees),
    }));
    const fileSizeServiceCharges = draft.fileSizeServiceCharges.map(
      ({ rupees, ...charge }) => ({
        ...charge,
        chargePaise: parseRupeesToPaise(rupees),
      }),
    );
    if (
      printRates.some((rate) => rate.pricePerPagePaise === null) ||
      fileSizeServiceCharges.some((charge) => charge.chargePaise === null)
    ) {
      setError("Enter prices in rupees with no more than two decimal places.");
      return;
    }
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const response = await adminApi.updatePricing({
        printRates: printRates as AdminPrintRate[],
        fileSizeServiceCharges:
          fileSizeServiceCharges as AdminFileSizeServiceCharge[],
      });
      if (response.ok) {
        const next = toDraft(response.data.pricing);
        setDraft(next);
        setSaved(next);
        setMessage(response.data.message ?? "Pricing saved.");
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

  if (loading) {
    return (
      <div className="panel page-loading" aria-busy="true">
        Loading pricing…
      </div>
    );
  }
  if (!draft) {
    return (
      <div className="panel">
        <h1>Pricing</h1>
        <p className="form-error" role="alert">
          {error ?? "Pricing is not available."}
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
    <div className="page-stack pricing-page">
      <div>
        <p className="eyebrow">Customer charges</p>
        <h1>Pricing</h1>
        <p className="page-intro">
          Set per-page printing rates and fixed PDF service charges.
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
        {(["A4", "A3"] as const).map((paperSize) => (
          <section className="panel pricing-section" key={paperSize}>
            <div className="section-heading">
              <div>
                <h2>{PAPER_LABELS[paperSize]} Printing</h2>
                <p className="muted">Price per logical PDF page.</p>
              </div>
            </div>
            <div className="rate-grid">
              {(["BW", "COLOR"] as const).map((colorMode) => (
                <div className="rate-group" key={colorMode}>
                  <h3>{COLOR_LABELS[colorMode]}</h3>
                  {draft.printRates.map((rate, index) =>
                    rate.paperSize === paperSize &&
                    rate.colorMode === colorMode ? (
                      <div
                        className="rate-row"
                        key={`${rate.paperSize}:${rate.colorMode}:${rate.sides}`}
                      >
                        <label htmlFor={`rate-${index}`}>
                          {rate.sides === "SINGLE"
                            ? "Single-sided"
                            : "Double-sided"}
                        </label>
                        <div className="money-input">
                          <span aria-hidden="true">₹</span>
                          <input
                            aria-label={`${paperSize} ${COLOR_LABELS[colorMode]} ${rate.sides === "SINGLE" ? "Single-sided" : "Double-sided"} price`}
                            id={`rate-${index}`}
                            inputMode="decimal"
                            onChange={(event) =>
                              updateRate(index, { rupees: event.target.value })
                            }
                            value={rate.rupees}
                          />
                          <span>/ page</span>
                        </div>
                        <label className="compact-toggle">
                          <input
                            aria-label={`Enable ${paperSize} ${COLOR_LABELS[colorMode]} ${rate.sides === "SINGLE" ? "Single-sided" : "Double-sided"}`}
                            checked={rate.enabled}
                            onChange={(event) =>
                              updateRate(index, {
                                enabled: event.target.checked,
                              })
                            }
                            type="checkbox"
                          />
                          <span>{rate.enabled ? "Enabled" : "Disabled"}</span>
                        </label>
                      </div>
                    ) : null,
                  )}
                </div>
              ))}
            </div>
          </section>
        ))}

        <section className="panel pricing-section">
          <div className="section-heading">
            <div>
              <h2>PDF File Service Charge</h2>
              <p className="muted">
                The size ranges are fixed to prevent gaps or overlaps.
              </p>
            </div>
          </div>
          <div className="charge-list">
            {draft.fileSizeServiceCharges.map((charge, index) => (
              <div className="charge-row" key={charge.maxBytesInclusive}>
                <div>
                  <label htmlFor={`charge-${index}`}>{bandLabel(charge)}</label>
                  {charge.minBytesExclusive >= draft.maxPdfSizeBytes ? (
                    <p className="field-help">
                      Not used while the current PDF limit is{" "}
                      {draft.maxPdfSizeBytes / MIB} MB.
                    </p>
                  ) : null}
                </div>
                <div className="money-input">
                  <span aria-hidden="true">₹</span>
                  <input
                    aria-label={`${bandLabel(charge)} service charge`}
                    id={`charge-${index}`}
                    inputMode="decimal"
                    onChange={(event) =>
                      updateCharge(index, event.target.value)
                    }
                    value={charge.rupees}
                  />
                </div>
              </div>
            ))}
          </div>
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
            {saving ? "Saving…" : "Save Pricing"}
          </button>
        </div>
      </form>

      <AddonServicesSection
        services={addonServices}
        onSessionExpired={onSessionExpired}
      />
    </div>
  );
}
