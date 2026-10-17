export interface FloatingLoadingIndicatorProps {
  size?: "xs" | "sm" | "md" | "lg";
  variant?: "dark" | "green" | "white" | "subtle";
  showBadge?: boolean;
  className?: string;
  label?: string;
}

/**
 * Reusable subtle floating loading indicator for PrintGo.
 * Features a stylized hourglass icon with gentle vertical floating motion.
 * Respects prefers-reduced-motion and provides accessible contrast.
 */
export function FloatingLoadingIndicator({
  size = "sm",
  variant = "green",
  showBadge = true,
  className = "",
  label,
}: FloatingLoadingIndicatorProps) {
  const pixelDimensions = {
    xs: { icon: 14, badge: 22 },
    sm: { icon: 18, badge: 28 },
    md: { icon: 24, badge: 38 },
    lg: { icon: 34, badge: 52 },
  }[size];

  const badgeBg = {
    dark: "#123b4a",
    green: "#16754a",
    white: "#ffffff",
    subtle: "#e2e8f0",
  }[variant];

  const strokeColor = {
    dark: "#ffffff",
    green: "#ffffff",
    white: "#16754a",
    subtle: "#123b4a",
  }[variant];

  const iconSvg = (
    <svg
      width={pixelDimensions.icon}
      height={pixelDimensions.icon}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="pg-floating-svg"
      aria-hidden="true"
    >
      {/* Outer hourglass contour with modern curved waist */}
      <path
        d="M6 3H18M6 21H18M7 3C7 9 11 11.5 12 12C11 12.5 7 15 7 21M17 3C17 9 13 11.5 12 12C13 12.5 17 15 17 21"
        stroke={strokeColor}
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Top and bottom subtle sand detail */}
      <path
        d="M9.5 6.5H14.5"
        stroke={strokeColor}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeOpacity="0.85"
      />
      <path
        d="M9 18.5C9.5 17 11 16.5 12 16.5C13 16.5 14.5 17 15 18.5"
        stroke={strokeColor}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeOpacity="0.85"
      />
    </svg>
  );

  return (
    <span
      className={`pg-floating-indicator pg-floating-indicator--${size} pg-floating-indicator--${variant} ${className}`}
      role={label ? "status" : undefined}
      aria-label={label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        lineHeight: 1,
        verticalAlign: "middle",
      }}
    >
      {showBadge ? (
        <span
          className="pg-floating-badge"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: pixelDimensions.badge,
            height: pixelDimensions.badge,
            borderRadius: Math.round(pixelDimensions.badge * 0.28),
            backgroundColor: badgeBg,
            boxShadow:
              variant === "white"
                ? "0 1px 3px rgba(0,0,0,0.1), 0 1px 2px rgba(0,0,0,0.06)"
                : "0 2px 6px rgba(18, 59, 74, 0.2)",
            border: variant === "white" ? "1px solid #cbd5e1" : "none",
            flexShrink: 0,
          }}
        >
          <span className="pg-floating-icon">{iconSvg}</span>
        </span>
      ) : (
        <span className="pg-floating-icon">{iconSvg}</span>
      )}
      {label && <span className="pg-floating-label">{label}</span>}
    </span>
  );
}
