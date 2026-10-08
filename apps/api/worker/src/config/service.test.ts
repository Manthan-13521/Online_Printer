import { describe, expect, it, vi } from "vitest";

import type {
  AdminPricingUpdateRequest,
  ShopSettings,
} from "@printgo/api-contract";
import {
  FILE_SIZE_SERVICE_CHARGE_BANDS,
  FILE_SIZE_10_MIB,
} from "@printgo/domain";

import type {
  ConfigurationRepository,
  StoredPricingConfiguration,
} from "./repository";
import { ConfigurationService } from "./service";

/* eslint-disable @typescript-eslint/unbound-method -- Vitest inspects repository method mocks without invoking them. */

const settings: ShopSettings = {
  shopName: "ABC Xerox",
  contactPhone: "+91 98765 43210",
  address: "Main Road",
  customerNotice: null,
  onlinePrintingEnabled: true,
  maxPdfSizeBytes: FILE_SIZE_10_MIB,
  identificationSheetEnabled: true,
  identificationSheetPlacement: "FIRST",
};

const storedPricing: StoredPricingConfiguration = {
  printRates: (["A4", "A3"] as const).flatMap((paperSize) =>
    (["BW", "COLOR"] as const).flatMap((colorMode) =>
      (["SINGLE", "DOUBLE"] as const).map((sides, index) => ({
        id: `${paperSize}-${colorMode}-${sides}`,
        paperSize,
        colorMode,
        sides,
        pricePerPagePaise: 100 + index,
        enabled: true,
      })),
    ),
  ),
  fileSizeServiceCharges: FILE_SIZE_SERVICE_CHARGE_BANDS.map((band, index) => ({
    id: `band-${index}`,
    ...band,
    chargePaise: index * 100,
    enabled: true,
    sortOrder: index + 1,
  })),
};

function repository(): ConfigurationRepository {
  let currentSettings = structuredClone(settings);
  let currentPricing = structuredClone(storedPricing);
  return {
    getSettings: vi.fn(() => Promise.resolve(structuredClone(currentSettings))),
    updateSettings: vi.fn<ConfigurationRepository["updateSettings"]>(
      (input) => {
        currentSettings = structuredClone(input.settings);
        return Promise.resolve();
      },
    ),
    getPricing: vi.fn(() => Promise.resolve(structuredClone(currentPricing))),
    updatePricing: vi.fn<ConfigurationRepository["updatePricing"]>((input) => {
      currentPricing = {
        printRates: input.printRates.map((rate, index) => ({
          id: currentPricing.printRates[index]?.id ?? `rate-${index}`,
          ...rate,
        })),
        fileSizeServiceCharges: input.fileSizeServiceCharges.map(
          (charge, index) => ({
            id:
              currentPricing.fileSizeServiceCharges[index]?.id ??
              `band-${index}`,
            ...charge,
            enabled: true,
            sortOrder: index + 1,
          }),
        ),
        ...(input.priorityPrinting
          ? { priorityPrinting: input.priorityPrinting }
          : {}),
      };
      return Promise.resolve();
    }),
    resetPickupCode: vi.fn(() => Promise.resolve("PA-001")),
  };
}

describe("ConfigurationService", () => {
  it("reads and updates the installation settings with audit context", async () => {
    const repo = repository();
    const service = new ConfigurationService(repo, () => 1234);
    const updated = {
      ...settings,
      shopName: "City Prints",
      onlinePrintingEnabled: false,
    };

    await expect(service.getSettings()).resolves.toEqual(settings);
    await expect(service.isOnlinePrintingEnabled()).resolves.toBe(true);
    await expect(service.updateSettings(updated, "admin-1")).resolves.toEqual(
      updated,
    );
    expect(repo.updateSettings).toHaveBeenCalledWith({
      settings: updated,
      previousOnlinePrintingEnabled: true,
      adminId: "admin-1",
      nowMs: 1234,
    });
  });

  it("returns public pricing without database identifiers", async () => {
    const service = new ConfigurationService(repository());
    const pricing = await service.getPricing();
    expect(pricing.maxPdfSizeBytes).toBe(FILE_SIZE_10_MIB);
    expect(pricing.printRates).toHaveLength(8);
    expect(pricing.fileSizeServiceCharges).toHaveLength(4);
    expect(pricing.printRates[0]).not.toHaveProperty("id");
    expect(pricing.fileSizeServiceCharges[0]).not.toHaveProperty("sortOrder");
  });

  it("validates a complete pricing replacement before one repository update", async () => {
    const repo = repository();
    const service = new ConfigurationService(repo, () => 5678);
    const current = await service.getPricing();
    const update: AdminPricingUpdateRequest = {
      printRates: current.printRates.map((rate) => ({
        ...rate,
        pricePerPagePaise: rate.pricePerPagePaise + 25,
      })),
      fileSizeServiceCharges: current.fileSizeServiceCharges.map((charge) => ({
        ...charge,
        chargePaise: charge.chargePaise + 50,
      })),
    };

    const result = await service.updatePricing(update, "admin-2");
    expect(result.printRates[0]?.pricePerPagePaise).toBe(
      update.printRates[0]?.pricePerPagePaise,
    );
    expect(repo.updatePricing).toHaveBeenCalledTimes(1);
    expect(repo.updatePricing).toHaveBeenCalledWith({
      ...update,
      adminId: "admin-2",
      nowMs: 5678,
    });
  });

  it("rejects an incomplete configuration without persisting any part", async () => {
    const repo = repository();
    const service = new ConfigurationService(repo);
    const current = await service.getPricing();

    await expect(
      service.updatePricing(
        {
          printRates: current.printRates.slice(0, 7),
          fileSizeServiceCharges: current.fileSizeServiceCharges,
        },
        "admin-2",
      ),
    ).rejects.toMatchObject({ code: "INVALID_PRICING_CONFIGURATION" });
    expect(repo.updatePricing).not.toHaveBeenCalled();
  });

  it("updates priority printing fee and enabled status", async () => {
    const repo = repository();
    const service = new ConfigurationService(repo, () => 7890);
    const current = await service.getPricing();
    const update: AdminPricingUpdateRequest = {
      printRates: current.printRates,
      fileSizeServiceCharges: current.fileSizeServiceCharges,
      priorityPrinting: {
        enabled: true,
        feePaise: 2000,
      },
    };

    const result = await service.updatePricing(update, "admin-1");
    expect(result.priorityPrinting).toEqual({
      enabled: true,
      feePaise: 2000,
    });
    expect(repo.updatePricing).toHaveBeenCalledWith({
      ...update,
      adminId: "admin-1",
      nowMs: 7890,
    });
  });
});
