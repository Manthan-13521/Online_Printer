import { memo, useEffect, useState } from "react";

export function CashEmptyState() {
  return (
    <div className="orders-empty-state-card green-empty-state">
      <div className="empty-state-illustration" aria-hidden="true">
        <svg width="76" height="76" viewBox="0 0 100 100" fill="none">
          {/* Sparkles */}
          <path
            d="M50 10 L50 18 M30 18 L36 24 M70 18 L64 24"
            stroke="#f59e0b"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
          {/* Register base */}
          <rect
            x="24"
            y="56"
            width="52"
            height="26"
            rx="4"
            fill="#e2e8f0"
            stroke="#94a3b8"
            strokeWidth="2"
          />
          <line
            x1="28"
            y1="68"
            x2="72"
            y2="68"
            stroke="#94a3b8"
            strokeWidth="2"
          />
          {/* Display screen */}
          <rect
            x="30"
            y="30"
            width="40"
            height="26"
            rx="4"
            fill="#cbd5e1"
            stroke="#94a3b8"
            strokeWidth="2"
          />
          <rect x="35" y="35" width="30" height="14" rx="2" fill="#0f172a" />
          <rect x="39" y="40" width="14" height="4" rx="1" fill="#22c55e" />
          {/* Keypad dots */}
          <circle cx="36" cy="62" r="2" fill="#64748b" />
          <circle cx="44" cy="62" r="2" fill="#64748b" />
          <circle cx="52" cy="62" r="2" fill="#64748b" />
          <circle cx="60" cy="62" r="2" fill="#64748b" />
          {/* Drawer handle */}
          <rect x="44" y="74" width="12" height="3" rx="1.5" fill="#64748b" />
        </svg>
      </div>
      <h3 className="empty-state-heading">No more pending cash orders!</h3>
      <p className="empty-state-subtext">
        All cash orders have been confirmed.
        <br />
        New counter orders will appear here in real time.
      </p>
    </div>
  );
}

export function ManualEmptyState() {
  return (
    <div className="orders-empty-state-card blue-empty-state">
      <div className="empty-state-illustration" aria-hidden="true">
        <svg width="76" height="76" viewBox="0 0 100 100" fill="none">
          {/* Sparkles */}
          <path
            d="M50 10 L50 18 M30 18 L36 24 M70 18 L64 24"
            stroke="#f59e0b"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
          {/* Paper sheet */}
          <rect
            x="36"
            y="20"
            width="28"
            height="26"
            rx="2"
            fill="#ffffff"
            stroke="#94a3b8"
            strokeWidth="2"
          />
          <line
            x1="42"
            y1="26"
            x2="58"
            y2="26"
            stroke="#cbd5e1"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <line
            x1="42"
            y1="32"
            x2="54"
            y2="32"
            stroke="#cbd5e1"
            strokeWidth="2"
            strokeLinecap="round"
          />
          {/* Printer body */}
          <rect
            x="22"
            y="42"
            width="56"
            height="32"
            rx="6"
            fill="#e2e8f0"
            stroke="#94a3b8"
            strokeWidth="2"
          />
          {/* Output tray */}
          <rect
            x="32"
            y="62"
            width="36"
            height="18"
            rx="2"
            fill="#cbd5e1"
            stroke="#94a3b8"
            strokeWidth="2"
          />
          {/* Status light */}
          <circle cx="70" cy="50" r="2.5" fill="#3b82f6" />
        </svg>
      </div>
      <h3 className="empty-state-heading">No manual or finishing orders</h3>
      <p className="empty-state-subtext">
        All manual and finishing orders have been completed.
        <br />
        New orders will appear here in real time.
      </p>
    </div>
  );
}

export const RelativeTimeBadge = memo(function RelativeTimeBadge({
  lastRefreshedAt,
}: {
  lastRefreshedAt: number;
}) {
  const [relativeTime, setRelativeTime] = useState("just now");

  useEffect(() => {
    const update = () => {
      const diffSec = Math.floor((Date.now() - lastRefreshedAt) / 1000);
      if (diffSec < 15) {
        setRelativeTime("just now");
      } else if (diffSec < 60) {
        setRelativeTime(`${diffSec}s ago`);
      } else {
        const mins = Math.floor(diffSec / 60);
        setRelativeTime(`${mins}m ago`);
      }
    };
    update();
    const timer = setInterval(update, 5000);
    return () => clearInterval(timer);
  }, [lastRefreshedAt]);

  return <span className="last-updated-text">Last updated {relativeTime}</span>;
});
