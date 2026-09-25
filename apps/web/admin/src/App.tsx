const futureSections = [
  "Dashboard",
  "Live Orders",
  "Order History",
  "Failed Jobs",
  "Printer",
  "Pricing",
  "Reports",
  "Shop Settings",
  "Security",
] as const;

export function App() {
  return (
    <div className="app-shell">
      <header>
        <p className="brand">PrintGo</p>
        <p className="context">Shop administration</p>
      </header>
      <aside aria-label="Admin navigation preview">
        <p className="aside-heading">Planned workspace</p>
        <ul>
          {futureSections.map((section) => (
            <li key={section}>{section}</li>
          ))}
        </ul>
      </aside>
      <main>
        <p className="eyebrow">Foundation ready</p>
        <h1>Admin tools are coming in scheduled phases</h1>
        <p>
          Authentication and operational screens are intentionally not part of
          Phase 0. This responsive shell establishes the application boundary.
        </p>
      </main>
    </div>
  );
}
