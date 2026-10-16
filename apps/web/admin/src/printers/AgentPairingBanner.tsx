export interface AgentPairingBannerProps {
  pairCode: string;
  pairExpiresAt: string | null;
  connectionLink: string | null;
  copiedCode: boolean;
  copiedLink: boolean;
  onDismiss: () => void;
  onCopyPairCode: () => void;
  onCopyConnectionLink: () => void;
}

export function AgentPairingBanner({
  pairCode,
  pairExpiresAt,
  connectionLink,
  copiedCode,
  copiedLink,
  onDismiss,
  onCopyPairCode,
  onCopyConnectionLink,
}: AgentPairingBannerProps) {
  return (
    <section
      className="panel"
      style={{
        border: "2px solid var(--accent, #0066cc)",
        backgroundColor: "var(--bg-subtle, #f5f5f5)",
      }}
    >
      <div className="action-row">
        <div>
          <h3 style={{ margin: 0, fontSize: "1.1rem" }}>Agent Pairing Code</h3>
          <p className="muted" style={{ margin: "0.25rem 0 0 0" }}>
            Run PrintGo Agent on your shop Windows computer and connect with
            this code.
          </p>
        </div>
        <button className="text-button" onClick={onDismiss} type="button">
          Dismiss
        </button>
      </div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "1rem",
          margin: "1rem 0",
        }}
      >
        <a
          className="primary-button"
          href={connectionLink ?? undefined}
          aria-disabled={!connectionLink}
          style={{ textDecoration: "none", display: "inline-block" }}
        >
          ⚡ Connect This PC Automatically
        </a>
        <span
          style={{
            fontFamily: "monospace",
            fontSize: "1.75rem",
            fontWeight: "bold",
            letterSpacing: "0.2em",
            backgroundColor: "var(--bg-card, #ffffff)",
            padding: "0.25rem 0.75rem",
            borderRadius: "6px",
            border: "1px dashed var(--border, #cbd5e1)",
            cursor: "pointer",
            userSelect: "all",
          }}
          title="Click to copy pairing code"
          onClick={onCopyPairCode}
        >
          {pairCode}
        </span>
        <button
          className="secondary-button"
          onClick={onCopyPairCode}
          type="button"
        >
          {copiedCode ? "Code Copied!" : "Copy Code"}
        </button>
        <button
          className="secondary-button"
          onClick={onCopyConnectionLink}
          type="button"
        >
          {copiedLink ? "Link Copied!" : "Copy Full Link"}
        </button>
      </div>
      <p className="field-help" style={{ margin: 0 }}>
        This code expires in 10 minutes (
        {pairExpiresAt ? new Date(pairExpiresAt).toLocaleTimeString() : "soon"})
        and can only be used once.
      </p>
    </section>
  );
}
