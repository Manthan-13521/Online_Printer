import type {
  AdminPricingConfiguration,
  AdminPricingUpdateRequest,
  ShopSettings,
} from "@printgo/api-contract";
import {
  validatePricingConfiguration,
  type PricingConfiguration,
} from "@printgo/pricing";

import type { ConfigurationRepository } from "./repository";

export class ConfigurationError extends Error {
  constructor(readonly code: "CONFIGURATION_NOT_FOUND") {
    super(code);
    this.name = "ConfigurationError";
  }
}

export class ConfigurationService {
  constructor(
    private readonly repository: ConfigurationRepository,
    private readonly now: () => number = Date.now,
  ) {}

  async getSettings(): Promise<ShopSettings> {
    const settings = await this.repository.getSettings();
    if (!settings) throw new ConfigurationError("CONFIGURATION_NOT_FOUND");
    return settings;
  }

  /** Future upload/payment gates should call this instead of trusting a browser flag. */
  async isOnlinePrintingEnabled(): Promise<boolean> {
    return (await this.getSettings()).onlinePrintingEnabled;
  }

  async updateSettings(
    settings: ShopSettings,
    adminId: string,
  ): Promise<ShopSettings> {
    const current = await this.getSettings();
    await this.repository.updateSettings({
      settings,
      previousOnlinePrintingEnabled: current.onlinePrintingEnabled,
      adminId,
      nowMs: this.now(),
    });
    return this.getSettings();
  }

  async getPricing(): Promise<AdminPricingConfiguration> {
    const [settings, stored] = await Promise.all([
      this.getSettings(),
      this.repository.getPricing(),
    ]);
    const engineConfiguration: PricingConfiguration = {
      maxPdfSizeBytes: settings.maxPdfSizeBytes,
      printRates: stored.printRates,
      fileSizeServiceCharges: stored.fileSizeServiceCharges,
    };
    validatePricingConfiguration(engineConfiguration);
    return {
      maxPdfSizeBytes: settings.maxPdfSizeBytes,
      printRates: stored.printRates.map((rate) => ({
        paperSize: rate.paperSize,
        colorMode: rate.colorMode,
        sides: rate.sides,
        pricePerPagePaise: rate.pricePerPagePaise,
        enabled: rate.enabled,
      })),
      fileSizeServiceCharges: stored.fileSizeServiceCharges.map((charge) => ({
        minBytesExclusive: charge.minBytesExclusive,
        maxBytesInclusive: charge.maxBytesInclusive,
        chargePaise: charge.chargePaise,
      })),
      ...(stored.addonServices ? { addonServices: stored.addonServices } : {}),
      ...(stored.priorityPrinting
        ? { priorityPrinting: stored.priorityPrinting }
        : {}),
      ...(stored.discountRules ? { discountRules: stored.discountRules } : {}),
    };
  }

  async updatePricing(
    pricing: AdminPricingUpdateRequest,
    adminId: string,
  ): Promise<AdminPricingConfiguration> {
    const settings = await this.getSettings();
    validatePricingConfiguration({
      maxPdfSizeBytes: settings.maxPdfSizeBytes,
      printRates: pricing.printRates,
      fileSizeServiceCharges: pricing.fileSizeServiceCharges.map((charge) => ({
        ...charge,
        enabled: true,
      })),
    });
    await this.repository.updatePricing({
      ...pricing,
      adminId,
      nowMs: this.now(),
    });
    return this.getPricing();
  }

  async resetPickupCode(adminId: string): Promise<string> {
    return this.repository.resetPickupCode(adminId, this.now());
  }
}
