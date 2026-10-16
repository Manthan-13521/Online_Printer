import type { AdminPrinterDetails } from "@printgo/api-contract";

export function formatSimpleCapabilities(
  caps: AdminPrinterDetails["capabilities"],
): string {
  if (!caps) return "B&W • A4 (Unverified)";
  const color = caps.colour ? "Color" : "B&W";
  const sides = caps.duplex ? "Duplex" : "1-sided";
  const paper = caps.paperSizes?.includes("A4")
    ? "A4"
    : caps.paperSizes?.[0] || "A4";
  return `${color} • ${paper} • ${sides} (Driver Detected)`;
}

export function friendlyPrinterMessage(
  code: string | null | undefined,
  detail: string | null | undefined,
): string {
  if (detail && detail.trim().length > 0) {
    if (detail.toLowerCase().includes("paper tray is empty")) {
      return "Paper tray is empty. Please load paper.";
    }
    return detail;
  }
  switch (code) {
    case "PAPER_OUT":
      return "Printer is out of paper. Please add paper.";
    case "PAPER_JAM":
      return "Paper jam detected. Please check the paper path.";
    case "DOOR_OPEN":
      return "Printer door or cover is open.";
    case "NO_TONER":
      return "Toner or ink is empty.";
    case "TONER_LOW":
      return "Toner or ink is low.";
    case "OFFLINE":
    case "PRINTER_OFFLINE":
      return "Printer is powered off or disconnected.";
    case "CONNECTION_LOST":
      return "Printer communication link lost. Please check cable or network.";
    case "SPOOLER_ERROR":
      return "Windows print spooler needs attention.";
    case "USER_INTERVENTION":
      return "Printer requires attention.";
    case "PRINTER_ERROR":
      return "Printer hardware reported an error.";
    default:
      return "Printer reported an issue.";
  }
}

export function isVirtualPrinter(p: AdminPrinterDetails): boolean {
  if (p.isVirtual) return true;
  const text = `${p.displayName} ${p.windowsPrinterName}`.toLowerCase();
  return /pdf|xps|fax|onenote|root print queue|generic \/ text|document writer/i.test(
    text,
  );
}
