export interface CustomerPrivacyFooterProps {
  appName?: string | undefined;
}

export function CustomerPrivacyFooter({
  appName = "PrintGo",
}: CustomerPrivacyFooterProps) {
  return (
    <footer
      className="customer-privacy-footer"
      style={{
        marginTop: "2.5rem",
        paddingTop: "1.5rem",
        borderTop: "1px solid #E1E5E2",
        textAlign: "center",
      }}
    >
      <p
        className="muted"
        style={{
          fontSize: "0.85rem",
          maxWidth: "520px",
          margin: "0 auto 0.5rem auto",
          lineHeight: "1.5",
        }}
      >
        🔒 <strong>Privacy &amp; Automatic Cleanup:</strong> Unpaid uploads are
        purged after 10 minutes. Completed print data is purged two hours after
        the entire order finishes.
      </p>
      <p className="muted" style={{ fontSize: "0.8rem", margin: 0 }}>
        Powered by <strong>{appName}</strong> · Secure Single-Shop Printing
      </p>
    </footer>
  );
}
