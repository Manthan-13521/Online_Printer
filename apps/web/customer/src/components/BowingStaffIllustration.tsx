export interface BowingStaffIllustrationProps {
  className?: string;
  size?: number;
}

/**
 * Static illustration of a polite, apologetic cartoon staff member bowing
 * with folded hands in a dark suit, glasses, and yellow tie.
 * Per UX specifications: This illustration is strictly STATIC (not animated).
 */
export function BowingStaffIllustration({
  className,
  size = 180,
}: BowingStaffIllustrationProps) {
  const width = size;
  const height = Math.round(size * 1.25);

  return (
    <div
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1rem",
        borderRadius: "1.25rem",
        background: "#ffffff",
        boxShadow: "0 4px 20px rgba(18, 59, 74, 0.06)",
        border: "1px solid #e2e8f0",
      }}
      aria-hidden="true"
    >
      <svg
        width={width}
        height={height}
        viewBox="0 0 160 200"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{ display: "block" }}
      >
        {/* Soft grounding shadow */}
        <ellipse
          cx="80"
          cy="192"
          rx="38"
          ry="6"
          fill="#cbd5e1"
          fillOpacity="0.45"
        />

        {/* Shoes */}
        <ellipse cx="68" cy="188" rx="10" ry="5" fill="#0f172a" />
        <ellipse cx="92" cy="188" rx="10" ry="5" fill="#0f172a" />

        {/* Trousers */}
        <path
          d="M62 135 L64 186 C64 188 72 188 72 186 L76 142 L80 142 L84 186 C84 188 92 188 92 186 L98 135 Z"
          fill="#1e293b"
        />
        {/* Trouser center seam */}
        <path
          d="M80 142 L80 178"
          stroke="#0f172a"
          strokeWidth="1.5"
          strokeLinecap="round"
        />

        {/* Suit Jacket Body (slight forward bow posture) */}
        <path
          d="M52 82 C52 74 62 70 80 70 C98 70 108 74 108 82 L103 138 C103 140 96 142 80 142 C64 142 57 140 57 138 Z"
          fill="#1e293b"
        />

        {/* Shirt Collar (V-opening) */}
        <path d="M72 70 L80 94 L88 70 Z" fill="#ffffff" />
        <path
          d="M71 70 L77 82 L80 76 L83 82 L89 70 Z"
          fill="#f8fafc"
          stroke="#e2e8f0"
          strokeWidth="0.5"
        />

        {/* Golden-Yellow Tie */}
        <path d="M77 77 L83 77 L82 82 L78 82 Z" fill="#d97706" />
        <path d="M78 82 L82 82 L84 106 L80 114 L76 106 Z" fill="#f59e0b" />
        <path d="M80 82 L80 112" stroke="#d97706" strokeWidth="0.75" />

        {/* Suit Lapels */}
        <path
          d="M62 72 L73 98 L69 116 L60 88 Z"
          fill="#334155"
          stroke="#1e293b"
          strokeWidth="0.5"
        />
        <path
          d="M98 72 L87 98 L91 116 L100 88 Z"
          fill="#334155"
          stroke="#1e293b"
          strokeWidth="0.5"
        />

        {/* Arms angled inward in polite bow */}
        {/* Left Arm */}
        <path
          d="M54 78 C47 88 46 108 52 126 C53 130 58 132 64 130 C68 128 68 122 66 116 C63 104 62 90 66 80 Z"
          fill="#1e293b"
        />
        {/* Right Arm */}
        <path
          d="M106 78 C113 88 114 108 108 126 C107 130 102 132 96 130 C92 128 92 122 94 116 C97 104 98 90 94 80 Z"
          fill="#1e293b"
        />

        {/* Clasped / Folded Hands (Polite Ojigi) */}
        <ellipse cx="80" cy="132" rx="12" ry="7" fill="#fed7aa" />
        {/* Fingers detail */}
        <path
          d="M73 130 C76 133 84 133 87 130"
          stroke="#ea580c"
          strokeWidth="1"
          strokeLinecap="round"
          strokeOpacity="0.4"
        />
        <path
          d="M74 133 C77 136 83 136 86 133"
          stroke="#ea580c"
          strokeWidth="1"
          strokeLinecap="round"
          strokeOpacity="0.4"
        />

        {/* Head & Neck */}
        <path d="M74 65 L74 72 L86 72 L86 65 Z" fill="#fed7aa" />

        {/* Ears */}
        <circle cx="56" cy="46" r="6" fill="#fed7aa" />
        <circle cx="104" cy="46" r="6" fill="#fed7aa" />
        <path
          d="M55 45 C55 47 57 48 58 47"
          stroke="#f97316"
          strokeWidth="0.75"
          strokeLinecap="round"
          strokeOpacity="0.5"
        />
        <path
          d="M105 45 C105 47 103 48 102 47"
          stroke="#f97316"
          strokeWidth="0.75"
          strokeLinecap="round"
          strokeOpacity="0.5"
        />

        {/* Face Base */}
        <rect x="58" y="24" width="44" height="44" rx="18" fill="#fed7aa" />

        {/* Blush Cheeks */}
        <ellipse
          cx="66"
          cy="53"
          rx="4.5"
          ry="2.5"
          fill="#fca5a5"
          fillOpacity="0.6"
        />
        <ellipse
          cx="94"
          cy="53"
          rx="4.5"
          ry="2.5"
          fill="#fca5a5"
          fillOpacity="0.6"
        />

        {/* Apologetic Eyebrows (slanted downward inward: /  \ ) */}
        <path
          d="M66 36 C69 34 74 36 75 38"
          stroke="#1e293b"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path
          d="M94 36 C91 34 86 36 85 38"
          stroke="#1e293b"
          strokeWidth="2"
          strokeLinecap="round"
        />

        {/* Spectacles (Round black frames) */}
        {/* Left Lens Frame */}
        <circle
          cx="70"
          cy="46"
          r="8"
          stroke="#0f172a"
          strokeWidth="2.2"
          fill="none"
        />
        {/* Right Lens Frame */}
        <circle
          cx="90"
          cy="46"
          r="8"
          stroke="#0f172a"
          strokeWidth="2.2"
          fill="none"
        />
        {/* Glasses Bridge */}
        <path
          d="M78 46 L82 46"
          stroke="#0f172a"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
        {/* Glasses Temples */}
        <path
          d="M62 45 L56 43"
          stroke="#0f172a"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <path
          d="M98 45 L104 43"
          stroke="#0f172a"
          strokeWidth="1.8"
          strokeLinecap="round"
        />

        {/* Apologetic Closed Eyes inside glasses (curved upward gentle arcs) */}
        <path
          d="M66 46 C68 49 72 49 74 46"
          stroke="#1e293b"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path
          d="M86 46 C88 49 92 49 94 46"
          stroke="#1e293b"
          strokeWidth="2"
          strokeLinecap="round"
        />

        {/* Small Polite Apologetic Mouth */}
        <path
          d="M77 58 C79 57 81 57 83 58"
          stroke="#c2410c"
          strokeWidth="1.5"
          strokeLinecap="round"
        />

        {/* Hair - Neat dark side-parted hairstyle */}
        <path
          d="M58 32 C58 20 68 14 80 14 C92 14 102 20 102 32 C102 33 103 36 103 38 C102 36 99 30 96 30 C92 30 87 34 80 30 C74 26 66 28 62 33 C60 35 58 37 58 38 Z"
          fill="#0f172a"
        />
        {/* Hair sideburns */}
        <path d="M58 32 L58 44 L61 40 Z" fill="#0f172a" />
        <path d="M102 32 L102 44 L99 40 Z" fill="#0f172a" />
      </svg>
    </div>
  );
}
