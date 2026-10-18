import type React from "react";
import type { CustomerConfigData } from "@printgo/api-contract";
import { resolveCustomerApiUrl } from "../api";

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
            {config?.logoUrl ? (
              <img
                src={resolveCustomerApiUrl(config.logoUrl)}
                alt="Shop logo"
                style={{ maxWidth: 144, maxHeight: 72, objectFit: "contain" }}
              />
            ) : (
              <h1 className="logo-text">
                {config?.shopName ?? "Online printing"}
              </h1>
            )}
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

      <div className="hero-content">
        <div className="hero-text">
          <h1 className="hero-title">Upload & Print Instantly</h1>
          <p className="hero-subtitle">
            Upload your PDF files and get high-quality prints without any manual
            interference.
          </p>
        </div>
        <div className="hero-decoration">
          <div className="decoration-text">
            Your files,
            <br />
            our print magic!
          </div>
        </div>
      </div>
    </header>
  );
}
