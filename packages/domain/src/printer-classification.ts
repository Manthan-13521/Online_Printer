/**
 * Classifies printers based on name, port, and driver to determine
 * whether a printer is a virtual/software queue or a physical production printer.
 *
 * Hard Invariant: Virtual printers (OneNote, Microsoft Print to PDF, XPS, Fax, etc.)
 * must NEVER receive paid customer jobs.
 */

const VIRTUAL_NAME_PATTERNS = [
  /onenote/i,
  /print\s*to\s*pdf/i,
  /adobe\s*pdf/i,
  /cutepdf/i,
  /foxit.*pdf/i,
  /bullzip/i,
  /primopdf/i,
  /pdfcreator/i,
  /dopdf/i,
  /nitro.*pdf/i,
  /xps\s*document\s*writer/i,
  /^fax$/i,
  /\bfax\b/i,
  /generic\s*\/\s*text\s*only/i,
  /root\s*print\s*queue/i,
];

const VIRTUAL_PORT_PATTERNS = [
  /^portprompt:?$/i,
  /^file:?$/i,
  /^nul:?$/i,
  /onenote/i,
  /\.pdf$/i,
  /\.xps$/i,
  /^shrfax:?$/i,
  /^fax:?$/i,
];

const VIRTUAL_DRIVER_PATTERNS = [
  /onenote/i,
  /print\s*to\s*pdf/i,
  /xps\s*document/i,
  /\bfax\b/i,
  /generic\s*\/\s*text\s*only/i,
  /root\s*print\s*queue/i,
  /software\s*driver/i,
];

export interface PrinterClassificationInput {
  name: string;
  portName?: string | null;
  driverName?: string | null;
}

export interface PrinterClassification {
  isVirtual: boolean;
  isEligibleForProductionPrint: boolean;
  reason?: string;
}

/**
 * Returns whether a printer is a virtual/software destination.
 */
export function isVirtualPrinter(
  name: string,
  portName?: string | null,
  driverName?: string | null,
): boolean {
  return classifyPrinter({
    name,
    portName: portName ?? null,
    driverName: driverName ?? null,
  }).isVirtual;
}

/**
 * Classifies a printer by inspecting its Windows queue Name, PortName, and DriverName.
 */
export function classifyPrinter(
  input: PrinterClassificationInput,
): PrinterClassification {
  const name = input.name.trim();
  const port = input.portName?.trim() ?? "";
  const driver = input.driverName?.trim() ?? "";

  // 1. Check Name against known virtual printer signatures
  for (const pattern of VIRTUAL_NAME_PATTERNS) {
    if (pattern.test(name)) {
      return {
        isVirtual: true,
        isEligibleForProductionPrint: false,
        reason: `Printer name '${name}' matches virtual software queue pattern.`,
      };
    }
  }

  // 2. Check Port against known virtual/software port signatures
  if (port) {
    for (const pattern of VIRTUAL_PORT_PATTERNS) {
      if (pattern.test(port)) {
        return {
          isVirtual: true,
          isEligibleForProductionPrint: false,
          reason: `Port '${port}' is a virtual or prompt-based port.`,
        };
      }
    }
  }

  // 3. Check Driver against known software drivers
  if (driver) {
    for (const pattern of VIRTUAL_DRIVER_PATTERNS) {
      if (pattern.test(driver)) {
        return {
          isVirtual: true,
          isEligibleForProductionPrint: false,
          reason: `Driver '${driver}' is a virtual software driver.`,
        };
      }
    }
  }

  // Eligible physical/network printer
  return {
    isVirtual: false,
    isEligibleForProductionPrint: true,
  };
}
