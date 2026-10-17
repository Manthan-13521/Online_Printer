import { BowingStaffIllustration } from "./BowingStaffIllustration";

export interface ShopUnavailableStateProps {
  error?: string | null;
  reason?: "SHOP_CLOSED" | "PRINTER_UNAVAILABLE" | "NETWORK_ERROR" | null;
  title?: string;
  onRetry: () => void;
  shopName?: string;
  contactPhone?: string | null;
  customerNotice?: string | null;
}

export function ShopUnavailableState({
  error,
  reason,
  title,
  onRetry,
  shopName,
  contactPhone,
  customerNotice,
}: ShopUnavailableStateProps) {
  // Determine appropriate heading, supporting text and button label based on actual reason
  let heading = "Shop Temporarily Unavailable";
  let supportingText =
    "We're sorry for the inconvenience. Please try again shortly.";
  let detailMessage: string | null = null;
  let buttonLabel = "Try Again";

  if (reason === "SHOP_CLOSED") {
    heading = title || "Sorry, we're currently closed.";
    supportingText =
      "We're sorry for the inconvenience. Please try again shortly.";
    detailMessage = "Online printing is currently unavailable";
    buttonLabel = "Try Again";
  } else if (reason === "PRINTER_UNAVAILABLE") {
    heading = title || "Sorry, printing is temporarily unavailable.";
    supportingText =
      "We're sorry for the inconvenience. Please try again shortly.";
    detailMessage =
      "Shop printers are currently offline or unavailable. Please check back in a few moments.";
    buttonLabel = "Try Again";
  } else if (reason === "NETWORK_ERROR" || (!reason && error)) {
    heading = title || "Shop Temporarily Unavailable";
    detailMessage =
      error ||
      "Could not connect to the shop system. Please check your internet connection and try again.";
    supportingText =
      "We're sorry for the inconvenience. Please try again shortly.";
    buttonLabel = "Retry Connection";
  }

  return (
    <section
      className="step shop-unavailable-card"
      style={{
        textAlign: "center",
        padding: "3rem 1.5rem",
        maxWidth: "520px",
        margin: "2rem auto",
        borderRadius: "1.25rem",
        background: "#ffffff",
        boxShadow: "0 10px 30px rgba(18, 59, 74, 0.08)",
        border: "1px solid #e1e5e2",
      }}
      role="alert"
    >
      {/* Static Japanese polite apology illustration (no animation per UX specs) */}
      <div style={{ marginBottom: "1.5rem" }}>
        <BowingStaffIllustration size={160} />
      </div>

      <h2
        style={{
          display: "block",
          fontSize: "1.45rem",
          fontWeight: 800,
          color: "#123b4a",
          margin: "0 0 0.65rem",
          letterSpacing: "-0.01em",
          lineHeight: 1.25,
        }}
      >
        {heading}
      </h2>

      <p
        style={{
          margin: "0 0 0.5rem",
          color: "#475569",
          fontSize: "1rem",
          lineHeight: "1.55",
          fontWeight: 500,
        }}
      >
        {supportingText}
      </p>

      {detailMessage && (
        <p
          style={{
            margin: "0.25rem 0 1.5rem",
            color: "#64748b",
            fontSize: "0.875rem",
            lineHeight: "1.5",
          }}
        >
          {detailMessage}
        </p>
      )}

      {customerNotice && (
        <div
          style={{
            background: "#f8fafc",
            border: "1px solid #cbd5e1",
            borderRadius: "8px",
            padding: "0.75rem 1rem",
            margin: "0 auto 1.5rem",
            fontSize: "0.875rem",
            color: "#334155",
            textAlign: "left",
          }}
        >
          <strong>Notice:</strong> {customerNotice}
        </div>
      )}

      {contactPhone && (
        <p
          style={{
            margin: "0 auto 1.5rem",
            fontSize: "0.875rem",
            color: "#64748b",
          }}
        >
          Need urgent printing? Contact {shopName || "the shop"} at{" "}
          <a
            href={`tel:${contactPhone}`}
            style={{
              color: "#16754a",
              fontWeight: 700,
              textDecoration: "underline",
            }}
          >
            {contactPhone}
          </a>
        </p>
      )}

      <button
        type="button"
        className="primary-button fit"
        onClick={onRetry}
        style={{
          margin: "0 auto",
          padding: "0.85rem 2rem",
          minHeight: "44px",
          minWidth: "160px",
          fontSize: "1rem",
          fontWeight: 700,
          borderRadius: "0.65rem",
          boxShadow: "0 2px 8px rgba(22, 117, 74, 0.25)",
        }}
      >
        {buttonLabel}
      </button>
    </section>
  );
}
