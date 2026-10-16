export interface ShopUnavailableStateProps {
  error: string | null;
  onRetry: () => void;
}

export function ShopUnavailableState({
  error,
  onRetry,
}: ShopUnavailableStateProps) {
  return (
    <section
      className="step"
      style={{
        textAlign: "center",
        padding: "2.5rem 1.5rem",
        maxWidth: "480px",
        margin: "2rem auto",
      }}
      role="alert"
    >
      <div style={{ fontSize: "2.5rem", marginBottom: "0.75rem" }}>🔌</div>
      <h2
        style={{
          fontSize: "1.35rem",
          fontWeight: 800,
          color: "#1e293b",
          margin: "0 0 0.5rem",
        }}
      >
        Shop Temporarily Unavailable
      </h2>
      <p
        style={{
          margin: "0.5rem 0 1.5rem",
          color: "#64748b",
          fontSize: "0.95rem",
          lineHeight: "1.5",
        }}
      >
        {error ||
          "Could not connect to the shop system. Please check your internet connection and try again."}
      </p>
      <button
        type="button"
        className="primary-button fit"
        onClick={onRetry}
        style={{ margin: "0 auto" }}
      >
        Retry Connection
      </button>
    </section>
  );
}
