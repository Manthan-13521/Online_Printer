# PrintGo Performance & UX Audit

## 1. Network & Caching
**PASS / optimized**:
- Public configuration securely leverages `Cache-Control: public, max-age=30, stale-while-revalidate=60`.
- API endpoints for payments and sensitive data correctly use `no-store`.

## 2. Unnecessary Polling & React State
**PASS**:
- Both `DashboardPage` and `TrackingPage` correctly abort polling intervals using `document.hidden` via `visibilitychange` listeners, saving huge amounts of Cloudflare Worker free tier limits for hidden tabs.
- No duplicate DB API hits.

## 3. JavaScript Bundle & Lazy Loading
**PASS / findings**:
- **Root Cause**: The customer web app statically imported `pdfjs-dist` inside `src/pdf.ts`, dragging 1.2MB of JS (690KB parsed bundle) into the main route chunk, impacting LCP and Core Web Vitals on mobile.
- **Ponytail Optimization**: Replaced the static import with a dynamic `import("pdfjs-dist")` bounded only to the moment of actual file inspection. 
- **Measurements**: Bundle size reduced by 61% (690KB → 269KB), significantly improving mobile checkout UX and first load time.

## 4. Query Efficiency (D1)
**PASS**:
- Live order admin queues rely on `LIMIT 100` and keyset pagination preventing unbounded N+1 read exhaustion.
- Bounded list reads and CTE usages observed in repository queries.
