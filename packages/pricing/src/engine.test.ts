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
});
