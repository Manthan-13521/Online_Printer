# Phase 2: Figma Design Audit (Track Page)
**Target:** `~/Downloads/Cinematic Interactive Print Journey-2`

This is a 100% read-only discovery of the new UI/UX intended for PrintGo V2's tracking page.

## 1. Tech Stack & Dependencies
The Figma export generated a modern, standalone React frontend environment:
- **React 19** & **React DOM 19** (PrintGo currently uses React 18)
- **Tailwind CSS v4.0.0** (PrintGo currently uses Tailwind v3)
- **Framer Motion v14.0.0** (Used for complex entrance/exit animations)
- **Vite v8.0.5**
- **Lucide React** (for icons)

*Integration Note:* Since the export uses React 19 and Tailwind v4, we will need to gracefully backport the code to our React 18 + Tailwind v3 environment during integration, or selectively copy the styles.

## 2. Component Structure
The entire application logic and visual implementation are tightly consolidated into a single file: `src/App.tsx` (~22.3 KB, ~500 lines).

**Key Components in `App.tsx`:**
1. **`App` (Wrapper):** Manages a demo state loop. Uses `setTimeout` to progress automatically from stage 0 to 6.
2. **`TrackJourney`:** The core UI. Contains the header, the background S-curve SVG, and maps over the active stages.
3. **`AnimatedConnector`:** The dashed line segment between nodes. Uses CSS keyframes (`jumpDash`) and SVG `strokeDasharray` to simulate "flowing" data/progress.
4. **`StationNode`:** The individual circular waypoints (e.g., Uploading, Printing). Dynamically scales up and uses specialized internal SVGs when marked `active`.
5. **`AnimatedPaperGroup`:** An SVG group containing a `<path>` and `<animateMotion>` element. This creates a continuously floating piece of paper moving along the exact coordinates of the S-curve.
6. **`FinishedScreen`:** A distinct, full-screen takeover view utilizing `framer-motion` for a cinematic pop-in effect when the order is ready.
7. **Custom SVGs (`HeroPrinterVisual`, `FinishingVisual`, `ReadyVisual`):** Beautifully crafted inline SVGs with internal CSS/Framer motion logic to animate physical printer actions (e.g., paper ejecting).

## 3. The "Cinematic S-Curve" Motion Logic
The "S-Curve" is strictly mathematical and heavily relies on pure SVG properties, avoiding heavy JavaScript loops for performance.

- **Responsive Coordinates:** It uses hardcoded cubic bezier strings (`M ... C ...`). There is one set for Desktop (`DESKTOP_PATHS`) and one set for Mobile (`MOBILE_PATHS`).
- **Breakpoint Detection:** It relies on a React `useEffect` listening to `window.innerWidth < 1024` to toggle an `isMobile` boolean. This boolean determines whether to use the desktop or mobile bezier coordinates.
- **Node Positioning:** The `POSITIONS` constant maps each stage to absolute percentage values (`x: %, y: %`) inside the SVG wrapper.
- **Native SVG Animation:** Rather than leaning entirely on Framer Motion (which can be heavy on mobile CPUs), the floating paper uses native SVG `<animateMotion>` to glide along the exact bezier strings defined in the paths.

## 4. State & Data Modeling (Mock vs. Real)
- **Current Figma State:** The app uses a simple integer index (`stageIndex`) ranging from 0 to 6 representing: `UPLOADING`, `PROCESSING`, `QUEUED`, `PRINTING`, `FINISHING`, `READY`, `FINISHED`.
- **Data Object:** Uses a mock `DEMO_ORDER` object with hardcoded values for `fileName`, `pages`, `estimatedReady`, and `pickupCode`.

## 5. Integration Pathway (Phase 3 Preparation)
When we are ready to move to Phase 3 (Integration), we must:
1. **Strip the Demo Loop:** Remove the `setTimeout` simulation in `App.tsx`.
2. **Map Real Statuses:** Bind PrintGo's real `CustomerOrderStatus` enum (from `packages/domain/src/customer-order-status.ts`) to the new integer index (`stageIndex`). Note that we may have to map multiple internal backend statuses (like `SPOOLING`) to a single visual status (like `PROCESSING`).
3. **Connect the Polling Engine:** Inject our existing resilient `document.hidden` polling hook to drive the state progression.
4. **Pass Real Data:** Feed the actual data returned from `GET /api/customer/tracking/:jobCode` into the `OrderDetails` props (pages, file name, store, live pickup code).
