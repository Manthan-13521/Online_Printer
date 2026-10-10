import { describe, expect, it } from "vitest";
import {
  checkOrderCapabilitiesSupport,
  computePrinterFingerprint,
  createDefaultCapabilityRecord,
  isHardwareFingerprintMismatched,
  resolveEffectiveFeatures,
  type PrinterCapabilityFeatures,
} from "./printer-capabilities.js";

describe("printer-capabilities domain logic", () => {
  it("computes deterministic hardware fingerprint", () => {
    const fp1 = computePrinterFingerprint(
      "Canon MF4700",
      "USB001",
      "Canon MF4700 Series",
    );
    const fp2 = computePrinterFingerprint(
      " canon mf4700 ",
      "usb001",
      "canon mf4700 series ",
    );
    expect(fp1).toBe(fp2);
    expect(fp1).toBe("canon mf4700::usb001::canon mf4700 series");
  });

  it("detects hardware fingerprint mismatch", () => {
    const original = computePrinterFingerprint(
      "Canon MF4700",
      "USB001",
      "Driver A",
    );
    const swapped = computePrinterFingerprint(
      "Canon MF4700",
      "USB002",
      "Driver A",
    );
    expect(isHardwareFingerprintMismatched(original, swapped)).toBe(true);
    expect(isHardwareFingerprintMismatched(original, original)).toBe(false);
    expect(isHardwareFingerprintMismatched(null, swapped)).toBe(false);
  });

  it("creates default capability record treating detected features as unverified", () => {
    const record = createDefaultCapabilityRecord({
      color: true,
      duplex: true,
      a3: true,
    });
    // Verified starts conservative (B&W single-sided A4 only)
    expect(record.verified.bw).toBe(true);
    expect(record.verified.color).toBe(false);
    expect(record.verified.duplex).toBe(false);
    expect(record.verified.a3).toBe(false);
    expect(record.verifiedAtMs).toBeNull();
    expect(record.requiresReview).toBe(false);

    // Enabled flags reflect configured/detected hints
    expect(record.enabled.color).toBe(true);
    expect(record.enabled.duplex).toBe(true);
    expect(record.enabled.a3).toBe(true);
  });

  it("validates order capabilities against printer features", () => {
    const features: PrinterCapabilityFeatures = {
      bw: true,
      color: false,
      duplex: true,
      a4: true,
      a3: false,
    };

    expect(
      checkOrderCapabilitiesSupport(features, {
        paperSize: "A4",
        colorMode: "BW",
        sides: "SINGLE",
      }).supported,
    ).toBe(true);

    expect(
      checkOrderCapabilitiesSupport(features, {
        paperSize: "A4",
        colorMode: "BW",
        sides: "DOUBLE",
      }).supported,
    ).toBe(true);

    // Color requested on mono printer fails closed
    const colorCheck = checkOrderCapabilitiesSupport(features, {
      paperSize: "A4",
      colorMode: "COLOR",
      sides: "SINGLE",
    });
    expect(colorCheck.supported).toBe(false);
    expect(colorCheck.missingFeature).toBe("color");

    // A3 requested on A4-only printer fails closed
    const a3Check = checkOrderCapabilitiesSupport(features, {
      paperSize: "A3",
      colorMode: "BW",
      sides: "SINGLE",
    });
    expect(a3Check.supported).toBe(false);
    expect(a3Check.missingFeature).toBe("a3");
  });

  describe("resolveEffectiveFeatures", () => {
    it("returns null when verified capabilities record has requiresReview=true", () => {
      const result = resolveEffectiveFeatures({
        verified_capabilities_json: JSON.stringify({
          verified: { bw: true, color: true, duplex: true, a4: true, a3: true },
          enabled: { bw: true, color: true, duplex: true, a4: true, a3: true },
          requiresReview: true,
        }),
        enabled_services_json: JSON.stringify({
          bw: true,
          color: true,
          duplex: true,
          a4: true,
          a3: true,
        }),
      });
      expect(result).toBeNull();
    });

    it("evaluates intersection of verified and enabled features", () => {
      const result = resolveEffectiveFeatures({
        verified_capabilities_json: JSON.stringify({
          verified: {
            bw: true,
            color: true,
            duplex: false,
            a4: true,
            a3: false,
          },
          enabled: { bw: true, color: false, duplex: true, a4: true, a3: true },
          requiresReview: false,
        }),
        enabled_services_json: JSON.stringify({
          bw: true,
          color: false,
          duplex: true,
          a4: true,
          a3: true,
        }),
      });
      expect(result).toEqual({
        bw: true,
        color: false, // verified true but enabled false -> false
        duplex: false, // verified false but enabled true -> false
        a4: true,
        a3: false,
      });
    });

    it("legacy capabilities strictly rejects UNKNOWN or missing values for color and duplex", () => {
      const result = resolveEffectiveFeatures({
        capabilities_json: JSON.stringify({
          colour: "UNKNOWN",
          duplex: "UNKNOWN",
          paperSizes: ["A4"],
        }),
      });
      expect(result).toEqual({
        bw: true,
        color: false,
        duplex: false,
        a4: true,
        a3: false,
      });
    });

    it("legacy capabilities requires strictly boolean true for color and duplex", () => {
      const result = resolveEffectiveFeatures({
        capabilities_json: JSON.stringify({
          colour: true,
          duplex: true,
          paperSizes: ["A4", "A3"],
        }),
      });
      expect(result).toEqual({
        bw: true,
        color: true,
        duplex: true,
        a4: true,
        a3: true,
      });
    });
  });
});
