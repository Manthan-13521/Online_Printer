import {
  FILE_SIZE_2_MIB,
  FILE_SIZE_5_MIB,
  FILE_SIZE_10_MIB,
  FILE_SIZE_25_MIB,
  FILE_SIZE_SERVICE_CHARGE_BANDS,
  type ColorMode,
  type PaperSize,
  type SidesMode,
} from "@printgo/domain";
import { describe, expect, it } from "vitest";

import {
  calculatePrintPrice,
  calculatePriorityFee,
  calculateDiscount,
  isIdentificationRequired,
  PricingError,
  type PricingConfiguration,
} from "./index";

function configuration(
  maxPdfSizeBytes = FILE_SIZE_25_MIB,
): PricingConfiguration {
  const prices: Record<
    PaperSize,
    Record<ColorMode, Record<SidesMode, number>>
  > = {
    A4: {
      BW: { SINGLE: 200, DOUBLE: 180 },
      COLOR: { SINGLE: 1_000, DOUBLE: 900 },
    },
    A3: {
      BW: { SINGLE: 400, DOUBLE: 350 },
      COLOR: { SINGLE: 1_800, DOUBLE: 1_600 },
    },
  };
  const printRates = Object.entries(prices).flatMap(([paperSize, colors]) =>
    Object.entries(colors).flatMap(([colorMode, sides]) =>
      Object.entries(sides).map(([side, pricePerPagePaise]) => ({
        paperSize: paperSize as PaperSize,
        colorMode: colorMode as ColorMode,
        sides: side as SidesMode,
        pricePerPagePaise,
        enabled: true,
      })),
    ),
  );
  return {
    maxPdfSizeBytes,
    printRates,
    fileSizeServiceCharges: FILE_SIZE_SERVICE_CHARGE_BANDS.map(
      (band, index) => ({
        ...band,
        chargePaise: [300, 400, 600, 1_000][index] ?? 0,
        enabled: true,
      }),
    ),
  };
}

function expectCode(action: () => unknown, code: string) {
  expect(action).toThrowError(PricingError);
  try {
    action();
  } catch (caught: unknown) {
    expect(caught).toMatchObject({ code });
  }
}

describe("authoritative print pricing", () => {
  it("calculates printing, service charge, and total in integer paise", () => {
    expect(
      calculatePrintPrice(
        {
          pageCount: 10,
          copies: 1,
          fileSizeBytes: FILE_SIZE_2_MIB,
          paperSize: "A4",
          colorMode: "BW",
          sides: "SINGLE",
        },
        configuration(),
      ),
    ).toMatchObject({
      printingAmountPaise: 2_000,
      serviceChargePaise: 300,
      totalAmountPaise: 2_300,
      currency: "INR",
    });
  });

  it("includes copies and selects colour, duplex, and A3 rates independently", () => {
    expect(
      calculatePrintPrice(
        {
          pageCount: 10,
          copies: 3,
          fileSizeBytes: 1,
          paperSize: "A4",
          colorMode: "BW",
          sides: "SINGLE",
        },
        configuration(),
      ).printingAmountPaise,
    ).toBe(6_000);
    expect(
      calculatePrintPrice(
        {
          pageCount: 1,
          copies: 1,
          fileSizeBytes: 1,
          paperSize: "A4",
          colorMode: "COLOR",
          sides: "SINGLE",
        },
        configuration(),
      ).printingAmountPaise,
    ).toBe(1_000);
    expect(
      calculatePrintPrice(
        {
          pageCount: 1,
          copies: 1,
          fileSizeBytes: 1,
          paperSize: "A4",
          colorMode: "BW",
          sides: "DOUBLE",
        },
        configuration(),
      ).printingAmountPaise,
    ).toBe(180);
    expect(
      calculatePrintPrice(
        {
          pageCount: 1,
          copies: 1,
          fileSizeBytes: 1,
          paperSize: "A3",
          colorMode: "BW",
          sides: "SINGLE",
        },
        configuration(),
      ).printingAmountPaise,
    ).toBe(400);
  });

  it.each([
    [1, 300],
    [FILE_SIZE_2_MIB, 300],
    [FILE_SIZE_2_MIB + 1, 400],
    [FILE_SIZE_5_MIB, 400],
    [FILE_SIZE_5_MIB + 1, 600],
    [FILE_SIZE_10_MIB, 600],
    [FILE_SIZE_10_MIB + 1, 1_000],
    [FILE_SIZE_25_MIB, 1_000],
  ])(
    "uses the exact service band at %i bytes",
    (fileSizeBytes, serviceChargePaise) => {
      expect(
        calculatePrintPrice(
          {
            pageCount: 1,
            copies: 1,
            fileSizeBytes,
            paperSize: "A4",
            colorMode: "BW",
            sides: "SINGLE",
          },
          configuration(),
        ).serviceChargePaise,
      ).toBe(serviceChargePaise);
    },
  );

  it("rejects the global and configured maximum boundaries", () => {
    expectCode(
      () =>
        calculatePrintPrice(
          {
            pageCount: 1,
            copies: 1,
            fileSizeBytes: FILE_SIZE_25_MIB + 1,
            paperSize: "A4",
            colorMode: "BW",
            sides: "SINGLE",
          },
          configuration(),
        ),
      "PDF_TOO_LARGE",
    );
    expect(
      calculatePrintPrice(
        {
          pageCount: 1,
          copies: 1,
          fileSizeBytes: FILE_SIZE_10_MIB,
          paperSize: "A4",
          colorMode: "BW",
          sides: "SINGLE",
        },
        configuration(FILE_SIZE_10_MIB),
      ),
    ).toBeTruthy();
    expectCode(
      () =>
        calculatePrintPrice(
          {
            pageCount: 1,
            copies: 1,
            fileSizeBytes: FILE_SIZE_10_MIB + 1,
            paperSize: "A4",
            colorMode: "BW",
            sides: "SINGLE",
          },
          configuration(FILE_SIZE_10_MIB),
        ),
      "PDF_TOO_LARGE",
    );
  });

  it("fails closed for disabled and missing rates", () => {
    const disabled = configuration();
    disabled.printRates[0]!.enabled = false;
    expectCode(
      () =>
        calculatePrintPrice(
          {
            pageCount: 1,
            copies: 1,
            fileSizeBytes: 1,
            paperSize: "A4",
            colorMode: "BW",
            sides: "SINGLE",
          },
          disabled,
        ),
      "PRINT_RATE_UNAVAILABLE",
    );
    const missing = configuration();
    missing.printRates = missing.printRates.slice(1);
    expectCode(
      () =>
        calculatePrintPrice(
          {
            pageCount: 1,
            copies: 1,
            fileSizeBytes: 1,
            paperSize: "A4",
            colorMode: "BW",
            sides: "SINGLE",
          },
          missing,
        ),
      "INVALID_PRICING_CONFIGURATION",
    );
  });

  it.each([
    [{ pageCount: 0 }, "INVALID_PAGE_COUNT"],
    [{ copies: 0 }, "INVALID_COPY_COUNT"],
    [{ copies: -1 }, "INVALID_COPY_COUNT"],
    [{ copies: 101 }, "INVALID_COPY_COUNT"],
    [{ copies: 1_000_000 }, "INVALID_COPY_COUNT"],
    [{ copies: 1.5 }, "INVALID_COPY_COUNT"],
    [{ fileSizeBytes: 0 }, "INVALID_FILE_SIZE"],
    [{ paperSize: "LETTER" }, "INVALID_PAPER_SIZE"],
    [{ colorMode: "COLOUR" }, "INVALID_COLOR_MODE"],
    [{ sides: "TRIPLE" }, "INVALID_SIDES_MODE"],
  ])("rejects invalid order input with %s", (override, code) => {
    const input = {
      pageCount: 1,
      copies: 1,
      fileSizeBytes: 1,
      paperSize: "A4",
      colorMode: "BW",
      sides: "SINGLE",
      ...override,
    };
    expectCode(
      () => calculatePrintPrice(input as never, configuration()),
      code,
    );
  });

  it("rejects negative configuration, a missing service band, and unsafe overflow", () => {
    const negative = configuration();
    negative.printRates[0]!.pricePerPagePaise = -1;
    expectCode(
      () =>
        calculatePrintPrice(
          {
            pageCount: 1,
            copies: 1,
            fileSizeBytes: 1,
            paperSize: "A4",
            colorMode: "BW",
            sides: "SINGLE",
          },
          negative,
        ),
      "INVALID_PRICING_CONFIGURATION",
    );
    const disabledBand = configuration();
    disabledBand.fileSizeServiceCharges[0]!.enabled = false;
    expectCode(
      () =>
        calculatePrintPrice(
          {
            pageCount: 1,
            copies: 1,
            fileSizeBytes: 1,
            paperSize: "A4",
            colorMode: "BW",
            sides: "SINGLE",
          },
          disabledBand,
        ),
      "FILE_SIZE_BAND_MISSING",
    );
    expectCode(
      () =>
        calculatePrintPrice(
          {
            pageCount: Number.MAX_SAFE_INTEGER,
            copies: 2,
            fileSizeBytes: 1,
            paperSize: "A4",
            colorMode: "BW",
            sides: "SINGLE",
          },
          configuration(),
        ),
      "PRICE_OVERFLOW",
    );
  });

  describe("priority fee calculation", () => {
    it("returns 0 if priority is not requested or disabled", () => {
      expect(
        calculatePriorityFee({
          isPriorityRequested: false,
          priorityPrintingEnabled: true,
          priorityFeePaise: 5000,
        }),
      ).toBe(0);
      expect(
        calculatePriorityFee({
          isPriorityRequested: true,
          priorityPrintingEnabled: false,
          priorityFeePaise: 5000,
        }),
      ).toBe(0);
    });

    it("returns priority fee when requested and enabled", () => {
      expect(
        calculatePriorityFee({
          isPriorityRequested: true,
          priorityPrintingEnabled: true,
          priorityFeePaise: 5000,
        }),
      ).toBe(5000);
    });

    it("throws on invalid fee", () => {
      expect(() =>
        calculatePriorityFee({
          isPriorityRequested: true,
          priorityPrintingEnabled: true,
          priorityFeePaise: -10,
        }),
      ).toThrow();
    });
  });

  describe("discount rules calculation", () => {
    const rules = [
      { minSubtotalPaise: 50000, discountPercent: 5, enabled: true }, // Above ₹500 -> 5%
      { minSubtotalPaise: 100000, discountPercent: 10, enabled: true }, // Above ₹1000 -> 10%
      { minSubtotalPaise: 200000, discountPercent: 15, enabled: true }, // Above ₹2000 -> 15%
    ];

    it("returns 0 discount if below all thresholds", () => {
      const res = calculateDiscount(40000, rules); // ₹400
      expect(res.discountAmountPaise).toBe(0);
      expect(res.discountThresholdPaise).toBeNull();
      expect(res.discountPercent).toBeNull();
    });

    it("applies 5% when above ₹500 but below ₹1000", () => {
      const res = calculateDiscount(60000, rules); // ₹600 -> 5% is ₹30
      expect(res.discountAmountPaise).toBe(3000);
      expect(res.discountThresholdPaise).toBe(50000);
      expect(res.discountPercent).toBe(5);
    });

    it("applies highest qualifying threshold (10%) and does NOT stack", () => {
      const res = calculateDiscount(120000, rules); // ₹1200 -> 10% is ₹120 (not 15%)
      expect(res.discountAmountPaise).toBe(12000);
      expect(res.discountThresholdPaise).toBe(100000);
      expect(res.discountPercent).toBe(10);
    });

    it("applies highest tier (15%) above ₹2000", () => {
      const res = calculateDiscount(250000, rules); // ₹2500 -> 15% is ₹375
      expect(res.discountAmountPaise).toBe(37500);
      expect(res.discountThresholdPaise).toBe(200000);
      expect(res.discountPercent).toBe(15);
    });

    it("ignores disabled rules", () => {
      const withDisabled = [
        { minSubtotalPaise: 50000, discountPercent: 5, enabled: true },
        { minSubtotalPaise: 100000, discountPercent: 10, enabled: false }, // Disabled
      ];
      const res = calculateDiscount(150000, withDisabled);
      expect(res.discountPercent).toBe(5);
      expect(res.discountAmountPaise).toBe(7500);
    });
  });

  describe("identification requirements", () => {
    it("returns false when mode is OFF", () => {
      expect(
        isIdentificationRequired({
          mode: "OFF",
          thresholdPaise: 50000,
          onlineAmountPaise: 100000,
        }),
      ).toBe(false);
    });

    it("returns true when mode is ALWAYS", () => {
      expect(
        isIdentificationRequired({
          mode: "ALWAYS",
          thresholdPaise: 50000,
          onlineAmountPaise: 100,
        }),
      ).toBe(true);
    });

    it("evaluates threshold when mode is ABOVE_THRESHOLD", () => {
      expect(
        isIdentificationRequired({
          mode: "ABOVE_THRESHOLD",
          thresholdPaise: 50000,
          onlineAmountPaise: 49900,
        }),
      ).toBe(false);
      expect(
        isIdentificationRequired({
          mode: "ABOVE_THRESHOLD",
          thresholdPaise: 50000,
          onlineAmountPaise: 50000,
        }),
      ).toBe(true);
      expect(
        isIdentificationRequired({
          mode: "ABOVE_THRESHOLD",
          thresholdPaise: 50000,
          onlineAmountPaise: 60000,
        }),
      ).toBe(true);
    });
  });
});
