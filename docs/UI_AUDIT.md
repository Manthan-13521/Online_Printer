# PrintGo V2 Global UI/UX Consistency Audit

## 1. Skill Validation & Color Decisions

Per the `ui-ux-pro-max` guidelines on trust and accessibility, we have evaluated the new **Track Journey Palette**:

- **Deep Ink Navy (`#123B4A`)**: Tested as the primary foreground/text and header background. It passes WCAG AAA contrast ratio (~10.9:1) on light surfaces. It strongly communicates professionalism and trust (common in financial/academic institutions).
- **Warm Ivory (`#F7F4EC`)**: Used as the primary background surface (`bg-printgo-bg`). This reduces eye strain significantly compared to `#FFFFFF` while retaining high legibility. `#FFFFFF` is retained strictly for elevated cards/containers to ensure subtle depth.
- **Emerald Green (`#16754A`)**: Used as the primary action/accent color. It passes WCAG AA contrast (5.2:1) on Ivory and works excellently for CTAs, active states, and success notifications. Hover states use a slightly darkened Emerald (`#105D3A`) to provide tactile feedback.
- **Semantic Colors**: Red (`#dc2626`) and Amber (`#d97706`) are strictly reserved for destructive actions (e.g., deleting shop settings) and warnings (e.g., queue capacity full).

## 2. Customer Application Inventory (`apps/web/customer`)

- **Routing Architecture:** Handled primarily via `window.location` inspection inside a single `<App />` component.
- **Key Components:**
  - `App.tsx`: Manages the primary flow (`Upload -> Configure -> Settings -> Review -> Pay`).
  - `TrackJourney.tsx`: The approved Figma-based Track page (visual source of truth).
  - `TrackingPage.tsx` / `PublicTrackingPage.tsx`: Data wrappers for the Track page.
  - `PwaInstallBanner.tsx`: Native app installation prompt.
- **CSS Architecture:** Uses a single `styles.css` file containing Vanilla CSS rules.
- **Layout Issues Found:**
  - Previously used `#0066cc` and `#0e7490` interchangeably for primary buttons.
  - Header (`.hero`) lacked structural isolation.
  - Desktop form fields stretched to the bounds of the `.flow` grid without centralized containment.
- **Remediation Steps Taken:**
  - Standardized `styles.css` to the new 3-color palette.
  - Rebuilt the `.hero` class into a formalized Header using Warm Ivory, an Emerald top-border, and Deep Navy typography to maintain brand presence safely regardless of uploaded logo assets.

## 3. Admin Application Inventory (`apps/web/admin`)

- **Routing Architecture:** Internal React state-based navigation (Dashboard, Live Orders, Manual Orders, Pricing, Settings, Printers, History).
- **Key Components:**
  - `App.tsx`: Main router and auth wrapper.
  - `DashboardPage.tsx`: High-level queue analytics.
  - `LiveOrdersPage.tsx`: Order management list.
  - `ShopSettingsPage.tsx`: Cloudflare & API configuration.
- **CSS Architecture:** Mirror of the Customer app (Vanilla CSS in `styles.css`).
- **Layout Issues Found:**
  - Extensive use of `#eef6f7` backgrounds and `#0e7490` accents.
- **Remediation Steps Taken:**
  - Mapped and replaced all outdated colors in `styles.css` with the centralized Warm Ivory, Deep Ink Navy, and Emerald Green.
  - Verified semantic inline colors (Reds/Ambers) remain intact for critical system warnings.

## 4. Typography & Spacing Validation (via `printgo-design-system`)

- All interactive elements correctly maintain the minimum 44px touch target size (via `padding: 0.85rem` + 1rem font size = ~45px).
- The `.page-shell` handles desktop vs mobile padding effectively, ensuring zero horizontal overflow on mobile devices (`padding: 1.25rem` mobile, `2rem` desktop).
- Input fields and selects have `border-radius: 0.65rem` unifying with the Track Journey's soft corner aesthetic.
