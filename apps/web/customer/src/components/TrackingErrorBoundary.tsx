import { Component, type ErrorInfo, type ReactNode } from "react";

export interface TrackingErrorBoundaryProps {
  children: ReactNode;
  onReset?: () => void;
}

interface TrackingErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class TrackingErrorBoundary extends Component<
  TrackingErrorBoundaryProps,
  TrackingErrorBoundaryState
> {
  public override state: TrackingErrorBoundaryState = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(
    error: Error,
  ): TrackingErrorBoundaryState {
    return { hasError: true, error };
  }

  public override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(
      "Tracking render error caught by boundary:",
      error,
      errorInfo,
    );
  }

  public handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  public override render() {
    if (this.state.hasError) {
      return (
        <main className="page-shell tracking-shell">
          <section
            className="step"
            style={{ textAlign: "center", padding: "3rem 1.5rem" }}
          >
            <h2>Unable to Display Tracking</h2>
            <p className="muted" style={{ margin: "1rem 0", color: "#5E6A63" }}>
              Something unexpected occurred while rendering your order status.
              Your print job is safe and processing.
            </p>
            <div
              style={{
                display: "flex",
                gap: "0.75rem",
                justifyContent: "center",
                flexWrap: "wrap",
                marginTop: "1.25rem",
              }}
            >
              <button
                type="button"
                className="primary-button fit"
                onClick={this.handleRetry}
              >
                Reload Status
              </button>
              {this.props.onReset ? (
                <button
                  type="button"
                  className="secondary-button fit"
                  onClick={this.props.onReset}
                >
                  Back to Home
                </button>
              ) : null}
            </div>
          </section>
        </main>
      );
    }

    return this.props.children;
  }
}
