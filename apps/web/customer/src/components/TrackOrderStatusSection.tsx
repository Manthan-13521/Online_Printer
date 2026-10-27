import type React from "react";

export interface TrackOrderStatusSectionProps {
  orderNumber: string;
  pickupCode?: string | null | undefined;
  statusLabel: string;
  statusMessage: string;
  isPriority: boolean;
  status?: string;
  shopName?: string | null | undefined;
  onOpenPricing?: (() => void) | undefined;
  trackBoxCode?: string | undefined;
  onTrackBoxCodeChange?: ((code: string) => void) | undefined;
  onTrackSubmit?: ((e: React.FormEvent) => void) | undefined;
  renderPickupCallout?: (() => React.ReactNode) | undefined;
}

export function TrackOrderStatusSection({
  orderNumber,
  pickupCode,
  statusLabel,
  statusMessage,
  isPriority,
  status,
  shopName,
  onOpenPricing,
  trackBoxCode,
  onTrackBoxCodeChange,
  onTrackSubmit,
  renderPickupCallout,
}: TrackOrderStatusSectionProps) {
  const displayCode = pickupCode ?? orderNumber ?? "";
  const formattedCode = /^[A-Z]{2}-\d{3}$/i.test(displayCode)
    ? displayCode.replace(/^([A-Z]{2})-(\d{3})$/i, "$1 - $2")
    : displayCode;

  const priorityBadgeText = (() => {
    const norm = (status || statusLabel || "").toLowerCase();
    if (norm.includes("ready") || norm.includes("complete")) {
      return "⚡ READY FOR PICKUP";
    }
    if (norm.includes("print")) {
      return "⚡ PRIORITY PRINTING";
    }
    if (norm.includes("finish")) {
      return "⚡ PRIORITY FINISHING";
    }
    return "⚡ PRIORITY #1";
  })();

  const statusDotClass = (() => {
    const norm = (status || statusLabel || "").toLowerCase();
    if (norm.includes("ready") || norm.includes("complete")) {
      return "bg-emerald-500 shadow-[0_0_8px_#10b981]";
    }
    if (norm.includes("print")) {
      return "bg-blue-500 shadow-[0_0_8px_#3b82f6]";
    }
    if (
      norm.includes("issue") ||
      norm.includes("fail") ||
      norm.includes("attention")
    ) {
      return "bg-rose-500 shadow-[0_0_8px_#ef4444]";
    }
    return "bg-amber-500 shadow-[0_0_8px_#f59e0b]";
  })();

  return (
    <div className="track-status-section-root w-full max-w-[520px] mx-auto px-3.5 pt-2 pb-1">
      {/* 1. Track Search Input (if provided) */}
      {onTrackSubmit && trackBoxCode !== undefined && (
        <form
          className="track-printing-form mb-3.5 w-full"
          onSubmit={onTrackSubmit}
        >
          <div className="track-input-wrapper">
            <span className="track-icon">📦</span>
            <input
              placeholder="Track your order (e.g. PA-001)"
              value={trackBoxCode}
              onChange={(e) => onTrackBoxCodeChange?.(e.target.value)}
              aria-label="Track your order code"
            />
            <button type="submit" className="track-button">
              Track
            </button>
          </div>
        </form>
      )}

      {/* 2. Brand Header (Instant Print + Lighting Bolt + Pricing & Info) */}
      <div className="track-brand-header flex items-center justify-between mb-3.5 px-1">
        <div className="flex items-center gap-3">
          {/* 44x44 container prevents left-edge clipping when bolt enlarges */}
          <div className="track-brand-bolt-container relative w-11 h-11 flex items-center justify-center shrink-0">
            {isPriority ? (
              <>
                <div
                  className="track-brand-bolt-glow absolute w-16 h-16 rounded-full pointer-events-none"
                  style={{
                    background:
                      "radial-gradient(circle, rgba(251,191,36,0.55) 0%, rgba(245,158,11,0.2) 48%, transparent 72%)",
                  }}
                  aria-hidden="true"
                />
                <svg
                  className="w-6 h-6 priority-bolt-active relative z-10"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    d="M13 2L3.5 13.5H11.5L10.5 22L20.5 10H12.5L13 2Z"
                    fill="#F59E0B"
                    stroke="#B45309"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </>
            ) : (
              <svg
                className="w-6 h-6 relative z-10"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  d="M13 2L3.5 13.5H11.5L10.5 22L20.5 10H12.5L13 2Z"
                  fill="#F59E0B"
                  stroke="#B45309"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </div>
          <div>
            <h1 className="track-brand-title text-[21px] font-extrabold text-[#0D233A] leading-none">
              Instant Print
            </h1>
            <span className="track-brand-subtitle text-[11px] font-bold text-slate-500 uppercase mt-1 block">
              {shopName || "PRINT_GO 🔥"}
            </span>
          </div>
        </div>

        {onOpenPricing && (
          <button
            type="button"
            onClick={onOpenPricing}
            className="track-pricing-btn px-3.5 py-1.5 rounded-full border border-[#1B7A43] text-[#1B7A43] bg-white text-xs font-bold hover:bg-emerald-50 transition-colors"
          >
            ⓘ Pricing & Info
          </button>
        )}
      </div>

      {/* 3. Status Card (Queued PA-037 / Electrified when Priority is active) */}
      {isPriority ? (
        <div className="queued-electric-shell">
          <div className="queued-card-inner relative z-10 bg-white rounded-[21.5px] p-4">
            <div className="queued-status-header flex items-center justify-between mb-1">
              <h2 className="queued-status-title text-[19px] font-extrabold text-[#0D233A] flex items-center gap-2">
                <span>{statusLabel}</span>
                <span
                  className={`inline-block w-2.5 h-2.5 rounded-full ${statusDotClass}`}
                  aria-hidden="true"
                />
              </h2>
              <span className="priority-pill-badge px-2.5 py-0.5 rounded-full text-[10.5px] font-extrabold uppercase bg-gradient-to-r from-amber-500 to-orange-500 text-slate-950 shadow-sm">
                {priorityBadgeText}
              </span>
            </div>
            <p className="queued-status-desc text-[13.5px] font-medium text-[#1E293B] mb-3.5">
              {statusMessage}
            </p>
            <div className="queued-code-box rounded-[14px] py-3.5 px-4 text-center bg-gradient-to-br from-[#FEF9C3] via-[#FEF08A] to-[#FDE047] border-2 border-amber-400 text-[#0D233A]">
              <span className="sr-only">
                {pickupCode
                  ? `Pickup code ${pickupCode}`
                  : `Order ${orderNumber}`}
              </span>
              <div
                aria-hidden="true"
                className="queued-code-value font-mono text-[28px] font-extrabold tracking-[0.06em] leading-none mb-1.5 text-[#0D233A]"
              >
                {formattedCode}
              </div>
              <div className="queued-code-sub text-[11.5px] font-bold text-[#92400E]">
                ⚡ Priority Print Active • Show this code at counter
              </div>
            </div>
            {renderPickupCallout?.()}
          </div>
        </div>
      ) : (
        <div className="rounded-[24px] p-[2.5px] bg-slate-200/90 shadow-sm">
          <div className="queued-card-inner relative z-10 bg-white rounded-[21.5px] p-4 border border-slate-100">
            <div className="queued-status-header flex items-center justify-between mb-1">
              <h2 className="queued-status-title text-[19px] font-extrabold text-[#0D233A] flex items-center gap-2">
                <span>{statusLabel}</span>
                <span
                  className={`inline-block w-2.5 h-2.5 rounded-full ${statusDotClass}`}
                  aria-hidden="true"
                />
              </h2>
            </div>
            <p className="queued-status-desc text-[13.5px] font-medium text-[#1E293B] mb-3.5">
              {statusMessage}
            </p>
            <div className="queued-code-box standard rounded-[14px] py-3.5 px-4 text-center bg-slate-50 border border-slate-200 text-[#0D233A]">
              <span className="sr-only">
                {pickupCode
                  ? `Pickup code ${pickupCode}`
                  : `Order ${orderNumber}`}
              </span>
              <div
                aria-hidden="true"
                className="queued-code-value font-mono text-[28px] font-extrabold tracking-[0.06em] leading-none mb-1.5 text-[#0D233A]"
              >
                {formattedCode}
              </div>
              <div className="queued-code-sub standard text-[11.5px] font-semibold text-slate-600">
                Show this code at the shop counter
              </div>
            </div>
            {renderPickupCallout?.()}
          </div>
        </div>
      )}
    </div>
  );
}

export default TrackOrderStatusSection;
