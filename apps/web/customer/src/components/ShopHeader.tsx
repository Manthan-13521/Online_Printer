import type React from "react";
import type { CustomerConfigData } from "@printgo/api-contract";

export interface ShopHeaderProps {
  config: CustomerConfigData | null;
  trackBoxCode: string;
  onTrackBoxCodeChange: (code: string) => void;
  onTrackSubmit: (e: React.FormEvent) => void;
  onOpenPricing: () => void;
}

export function ShopHeader({
  config,
  trackBoxCode,
  onTrackBoxCodeChange,
  onTrackSubmit,
  onOpenPricing,
}: ShopHeaderProps) {
  return (
    <header className="hero">
      <div className="hero-top-container">
        <form className="track-printing-form" onSubmit={onTrackSubmit}>
          <div className="track-input-wrapper">
            <span className="track-icon">📦</span>
            <input
              placeholder="Track your order (e.g. PA-001)"
              value={trackBoxCode}
              onChange={(e) => onTrackBoxCodeChange(e.target.value)}
            />
            <button type="submit" className="track-button">
              Track
            </button>
          </div>
        </form>

        <div className="hero-brand-pricing-row">
          <div className="hero-branding">
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.15rem",
              }}
            >
              <h1 className="logo-text hero-catchy-title">⚡ Instant Print</h1>
              {config?.shopName && (
                <span
                  className="hero-shop-name"
                  style={{
                    fontSize: "0.825rem",
                    fontWeight: 600,
                    color: "#64748b",
                    letterSpacing: "0.01em",
                  }}
                >
                  {config.shopName}
                </span>
              )}
            </div>
          </div>

          <div className="hero-actions">
            <button
              type="button"
              className="pricing-info-button"
              onClick={onOpenPricing}
            >
              ⓘ Pricing & Info
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}
