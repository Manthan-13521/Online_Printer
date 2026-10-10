export type CapabilityFeature = "bw" | "color" | "duplex" | "a4" | "a3";

export type CapabilityLifecycleState =
  | "DETECTED"
  | "REQUIRES_VERIFICATION"
  | "VERIFIED"
  | "ENABLED"
  | "TEMPORARILY_UNAVAILABLE";

export interface PrinterCapabilityFeatures {
  bw: boolean;
  color: boolean;
  duplex: boolean;
  a4: boolean;
  a3: boolean;
}

export interface CapabilityVerificationRecord {
  verified: PrinterCapabilityFeatures;
  enabled: PrinterCapabilityFeatures;
  verifiedAtMs?: number | null | undefined;
  verifiedByAdminId?: string | null | undefined;
  fingerprint?: string | null | undefined;
  notes?: string | null | undefined;
  requiresReview?: boolean | undefined;
}

export const DEFAULT_CAPABILITY_FEATURES: Readonly<PrinterCapabilityFeatures> =
  Object.freeze({
    bw: true,
    color: false,
    duplex: false,
    a4: true,
    a3: false,
  });

/**
 * Creates a default capability record based on optional detected hints.
 * Driver/WMI detection is treated as a hint: it requires deliberate operator confirmation.
 */
export function createDefaultCapabilityRecord(
  detected?: Partial<PrinterCapabilityFeatures>,
): CapabilityVerificationRecord {
  const verified: PrinterCapabilityFeatures = {
    bw: true, // Standard B&W is assumed for backward-compatibility on existing hardware
    color: false,
    duplex: false,
    a4: true,
    a3: false,
  };

  const enabled: PrinterCapabilityFeatures = {
    bw: true,
    color: Boolean(detected?.color),
    duplex: Boolean(detected?.duplex),
    a4: true,
    a3: Boolean(detected?.a3),
  };

  return {
    verified,
    enabled,
    verifiedAtMs: null,
    verifiedByAdminId: null,
    fingerprint: null,
    requiresReview: false,
  };
}

/**
 * Computes a deterministic printer hardware fingerprint from its Windows queue,
 * driver name, and port name.
 */
export function computePrinterFingerprint(
  windowsPrinterName: string,
  portName?: string | null,
  driverName?: string | null,
): string {
  const normalizedQueue = (windowsPrinterName || "").trim().toLowerCase();
  const normalizedPort = (portName || "").trim().toLowerCase();
  const normalizedDriver = (driverName || "").trim().toLowerCase();
  return `${normalizedQueue}::${normalizedPort}::${normalizedDriver}`;
}

/**
 * Checks whether the current printer state matches the recorded verification fingerprint.
 * If the port or driver changed materially, verification must be marked for review.
 */
export function isHardwareFingerprintMismatched(
  storedFingerprint: string | null | undefined,
  currentFingerprint: string,
): boolean {
  if (!storedFingerprint) return false;
  return (
    storedFingerprint.trim().toLowerCase() !==
    currentFingerprint.trim().toLowerCase()
  );
}

export interface OrderCapabilityRequirements {
  paperSize: string;
  colorMode: "BW" | "COLOR";
  sides: "SINGLE" | "DOUBLE";
}

export interface CapabilityCheckResult {
  supported: boolean;
  missingFeature?: "color" | "duplex" | "a4" | "a3" | "bw";
  reason?: string;
}

/**
 * Strictly verifies whether a printer's capability features can satisfy an order's requirements.
 * Fail closed against silent downgrades.
 */
export function checkOrderCapabilitiesSupport(
  features: PrinterCapabilityFeatures,
  requirements: OrderCapabilityRequirements,
): CapabilityCheckResult {
  if (requirements.colorMode === "COLOR" && !features.color) {
    return {
      supported: false,
      missingFeature: "color",
      reason: "Color printing is not supported or enabled on this printer.",
    };
  }

  if (requirements.colorMode === "BW" && !features.bw) {
    return {
      supported: false,
      missingFeature: "bw",
      reason:
        "Black & White printing is not supported or enabled on this printer.",
    };
  }

  if (requirements.sides === "DOUBLE" && !features.duplex) {
    return {
      supported: false,
      missingFeature: "duplex",
      reason:
        "Automatic double-sided (duplex) printing is not supported or enabled on this printer.",
    };
  }

  if (requirements.paperSize === "A4") {
    if (!features.a4) {
      return {
        supported: false,
        missingFeature: "a4",
        reason:
          "A4 paper printing is not supported or enabled on this printer.",
      };
    }
  } else if (requirements.paperSize === "A3") {
    if (!features.a3) {
      return {
        supported: false,
        missingFeature: "a3",
        reason:
          "A3 paper printing is not supported or enabled on this printer.",
      };
    }
  } else {
    return {
      supported: false,
      reason: `${requirements.paperSize} paper printing is not supported or enabled on this printer.`,
    };
  }

  return { supported: true };
}

export interface PrinterCapabilityRecordSource {
  capabilities_json?: string | null | undefined;
  verified_capabilities_json?: string | null | undefined;
  enabled_services_json?: string | null | undefined;
}

/**
 * Resolves the effective, authoritative capability features for a printer.
 * Prioritizes admin-verified and enabled capability records.
 * Never uses UNKNOWN or negative driver hints to positively authorize features.
 */
export function resolveEffectiveFeatures(
  printer: PrinterCapabilityRecordSource,
): PrinterCapabilityFeatures | null {
  if (printer.verified_capabilities_json && printer.enabled_services_json) {
    try {
      const verified = JSON.parse(
        printer.verified_capabilities_json,
      ) as CapabilityVerificationRecord;
      if (verified.requiresReview) {
        return null;
      }
      const enabled = JSON.parse(
        printer.enabled_services_json,
      ) as PrinterCapabilityFeatures;
      return {
        bw: Boolean(verified.verified.bw && enabled.bw),
        color: Boolean(verified.verified.color && enabled.color),
        duplex: Boolean(verified.verified.duplex && enabled.duplex),
        a4: Boolean(verified.verified.a4 && enabled.a4),
        a3: Boolean(verified.verified.a3 && enabled.a3),
      };
    } catch {
      // Fall through to legacy parsing
    }
  }

  // Legacy fallback: parse WMI capabilities_json if verified record not present
  if (printer.capabilities_json) {
    try {
      const caps = JSON.parse(printer.capabilities_json) as {
        colour?: boolean | "UNKNOWN";
        duplex?: boolean | "UNKNOWN";
        paperSizes?: string[];
      };
      const supportsA4 =
        !caps.paperSizes ||
        caps.paperSizes.length === 0 ||
        caps.paperSizes.includes("A4");
      const supportsA3 = Boolean(
        caps.paperSizes && caps.paperSizes.includes("A3"),
      );
      // Strictly boolean true! Never UNKNOWN or negative!
      const supportsColor = caps.colour === true;
      // Strictly boolean true! Never UNKNOWN, undefined, null, or 0!
      const supportsDuplex = caps.duplex === true;
      return {
        bw: true,
        color: supportsColor,
        duplex: supportsDuplex,
        a4: supportsA4,
        a3: supportsA3,
      };
    } catch {
      return null;
    }
  }

  return {
    bw: true,
    color: false,
    duplex: false,
    a4: true,
    a3: false,
  };
}

/**
 * Resolves the effective physical device identifier for a printer.
 * If physicalDeviceId is not explicitly configured, falls back to a shared lock for the agent
 * to ensure safe serial execution on unverified hardware.
 */
export function getEffectivePhysicalDeviceId(printer: {
  agentId: string;
  physicalDeviceId?: string | null;
}): string {
  const custom = printer.physicalDeviceId?.trim();
  return custom ? custom : `AGENT_LOCK_${printer.agentId}`;
}
