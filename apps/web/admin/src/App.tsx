import type { AdminProfile } from "@printgo/api-contract";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@printgo/validation";
import {
  useEffect,
  useId,
  useState,
  type FormEvent,
  type MouseEvent,
} from "react";

import {
  adminApi,
  AdminApiError,
  friendlyAdminError,
  setAdminToken,
} from "./api";
import { PricingPage } from "./PricingPage";
import { PrinterPage } from "./PrinterPage";
import { ShopSettingsPage } from "./ShopSettingsPage";
import { LiveOrdersPage } from "./LiveOrdersPage";
import { DashboardPage } from "./DashboardPage";
import { ManualOrdersPage } from "./ManualOrdersPage";
import { OrderHistoryPage } from "./OrderHistoryPage";
import { StoragePrivacySection } from "./StoragePrivacySection";

export interface NavItem {
  label: string;
  path: string;
  icon: string;
}

export const mainNavigation: NavItem[] = [
  { label: "Dashboard", path: "/admin", icon: "dashboard" },
  { label: "Live Orders", path: "/admin/live-orders", icon: "live-orders" },
  {
    label: "Cash & Manual Orders",
    path: "/admin/manual-orders",
    icon: "cash-manual",
  },
  {
    label: "Order History",
    path: "/admin/order-history",
    icon: "order-history",
  },
  { label: "Printer", path: "/admin/printer", icon: "printer" },
];

export const settingsNavigation: NavItem[] = [
  { label: "Pricing", path: "/admin/pricing", icon: "pricing" },
  {
    label: "Shop Settings",
    path: "/admin/shop-settings",
    icon: "shop-settings",
  },
  { label: "Security", path: "/admin/security", icon: "security" },
];

const allKnownRoutes: NavItem[] = [
  ...mainNavigation,
  ...settingsNavigation,
  { label: "Failed Jobs", path: "/admin/failed-jobs", icon: "alert" },
];

function NavIcon({ name }: { name: string }) {
  switch (name) {
    case "dashboard":
      return (
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <polyline points="9 22 9 12 15 12 15 22" />
        </svg>
      );
    case "live-orders":
      return (
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
          <polyline points="10 9 9 9 8 9" />
        </svg>
      );
    case "cash-manual":
      return (
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="2" y="5" width="20" height="14" rx="2" />
          <line x1="2" y1="10" x2="22" y2="10" />
          <circle cx="7" cy="15" r="1.5" />
          <line x1="12" y1="15" x2="17" y2="15" />
        </svg>
      );
    case "order-history":
      return (
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
      );
    case "printer":
      return (
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="6 9 6 2 18 2 18 9" />
          <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
          <rect x="6" y="14" width="12" height="8" />
        </svg>
      );
    case "settings":
      return (
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      );
    case "pricing":
      return (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
          <line x1="7" y1="7" x2="7.01" y2="7" />
        </svg>
      );
    case "shop-settings":
      return (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3 3h18v4H3z" />
          <path d="M3 7l2 14h14l2-14" />
          <path d="M10 11v6" />
          <path d="M14 11v6" />
        </svg>
      );
    case "security":
      return (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
      );
    default:
      return null;
  }
}

function cachedAppName(): string {
  try {
    return window.localStorage.getItem("printgo.appName")?.trim() || "PrintGo";
  } catch {
    return "PrintGo";
  }
}

function usePathname(): [string, (path: string) => void] {
  const [pathname, setPathname] = useState(window.location.pathname);
  useEffect(() => {
    const update = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  return [
    pathname,
    (path) => {
      window.history.pushState({}, "", path);
      setPathname(path);
    },
  ];
}

function LoadingScreen() {
  return (
    <main className="loading-screen" aria-busy="true">
      <span className="spinner" aria-hidden="true" />
      <p>Opening {cachedAppName()}…</p>
    </main>
  );
}

function LoginScreen({
  notice,
  onAuthenticated,
}: {
  notice: string | null;
  onAuthenticated: (admin: AdminProfile) => void;
}) {
  const [loginIdentifier, setLoginIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const errorId = useId();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const response = await adminApi.login({ loginIdentifier, password });
      if (response.ok) onAuthenticated(response.data.admin);
    } catch (caught: unknown) {
      setError(friendlyAdminError(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-card" aria-labelledby="login-title">
        <div className="login-brand" aria-hidden="true">
          P
        </div>
        <p className="product-name">{cachedAppName()}</p>
        <p className="portal-name">Admin Portal</p>
        <h1 id="login-title">Sign in</h1>
        <p className="muted">Manage your shop's online printing workspace.</p>
        {notice ? (
          <p className="notice" role="status">
            {notice}
          </p>
        ) : null}
        {error ? (
          <p className="form-error" id={errorId} role="alert">
            {error}
          </p>
        ) : null}
        <form
          onSubmit={(event) => void submit(event)}
          aria-describedby={error ? errorId : undefined}
        >
          <label htmlFor="login">Login</label>
          <input
            autoComplete="username"
            autoFocus
            id="login"
            maxLength={100}
            onChange={(event) => setLoginIdentifier(event.target.value)}
            required
            value={loginIdentifier}
          />
          <label htmlFor="password">Password</label>
          <div className="password-field">
            <input
              autoComplete="current-password"
              id="password"
              maxLength={PASSWORD_MAX_LENGTH}
              minLength={PASSWORD_MIN_LENGTH}
              onChange={(event) => setPassword(event.target.value)}
              required
              type={showPassword ? "text" : "password"}
              value={password}
            />
            <button
              className="text-button"
              onClick={() => setShowPassword((value) => !value)}
              type="button"
            >
              {showPassword ? "Hide" : "Show"}
            </button>
          </div>
          <button
            className="primary-button"
            disabled={submitting}
            type="submit"
          >
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </section>
    </main>
  );
}

function SecurityPage({
  admin,
  onSignedOut,
}: {
  admin: AdminProfile;
  onSignedOut: (message: string) => void;
}) {
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"password" | "all" | "logout" | null>(null);

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setMessage(null);
    setModalError(null);
    if (newPassword !== confirmNewPassword) {
      setModalError("New passwords do not match.");
      return;
    }
    setBusy("password");
    try {
      const response = await adminApi.changePassword({
        currentPassword,
        newPassword,
        confirmNewPassword,
      });
      if (response.ok) {
        setCurrentPassword("");
        setNewPassword("");
        setConfirmNewPassword("");
        setShowPasswordModal(false);
        setMessage(response.data.message);
      }
    } catch (caught: unknown) {
      if (caught instanceof AdminApiError && caught.status === 401) {
        onSignedOut("Your session has expired. Please sign in again.");
        return;
      }
      setModalError(friendlyAdminError(caught));
    } finally {
      setBusy(null);
    }
  }

  async function revokeAll() {
    if (busy) return;
    setBusy("all");
    setError(null);
    try {
      await adminApi.revokeAllSessions();
      onSignedOut("All sessions have been signed out.");
    } catch (caught: unknown) {
      setError(friendlyAdminError(caught));
      setBusy(null);
    }
  }
  async function signOut() {
    if (busy) return;
    setBusy("logout");
    try {
      await adminApi.logout();
      onSignedOut("You have been signed out.");
    } catch (caught: unknown) {
      setError(friendlyAdminError(caught));
      setBusy(null);
    }
  }

  return (
    <div className="page-stack">
      <div>
        <p className="eyebrow">Account protection</p>
        <h1>Security</h1>
        <p className="page-intro">Keep your PrintGo admin account secure.</p>
      </div>
      {message ? (
        <p className="notice" role="status">
          {message}
        </p>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <section className="panel">
        <h2>Admin account</h2>
        <dl>
          <dt>Login</dt>
          <dd>{admin.loginIdentifier}</dd>
        </dl>
      </section>

      <StoragePrivacySection onSessionExpired={onSignedOut} />

      <section className="panel action-row">
        <div>
          <h2>Change password</h2>
          <p className="muted">
            Use {PASSWORD_MIN_LENGTH} to {PASSWORD_MAX_LENGTH} characters.
            Passphrases are welcome.
          </p>
        </div>
        <button
          className="secondary-button"
          onClick={() => {
            setShowPasswordModal(true);
            setModalError(null);
          }}
          type="button"
        >
          Change password
        </button>
      </section>

      <section className="panel action-row">
        <div>
          <h2>Sessions</h2>
          <p className="muted">Sign out this browser and every other device.</p>
        </div>
        <button
          className="secondary-button"
          disabled={busy !== null}
          onClick={() => void revokeAll()}
          type="button"
        >
          {busy === "all" ? "Signing out…" : "Log out all sessions"}
        </button>
      </section>
      <section className="panel action-row">
        <div>
          <h2>Sign out</h2>
          <p className="muted">End the session on this browser.</p>
        </div>
        <button
          className="secondary-button"
          disabled={busy !== null}
          onClick={() => void signOut()}
          type="button"
        >
          {busy === "logout" ? "Signing out…" : "Sign out"}
        </button>
      </section>

      {showPasswordModal ? (
        <div className="dialog-backdrop">
          <section
            aria-labelledby="change-password-dialog-title"
            aria-modal="true"
            className="confirm-dialog"
            role="dialog"
          >
            <h2 id="change-password-dialog-title">Change password</h2>
            <p className="muted">
              Use {PASSWORD_MIN_LENGTH} to {PASSWORD_MAX_LENGTH} characters.
              Passphrases are welcome.
            </p>
            {modalError ? (
              <p
                className="form-error"
                role="alert"
                style={{ marginTop: "0.75rem" }}
              >
                {modalError}
              </p>
            ) : null}
            <form
              className="security-form"
              onSubmit={(event) => void changePassword(event)}
              style={{ marginTop: "1rem" }}
            >
              <label htmlFor="current-password">Current password</label>
              <input
                id="current-password"
                type="password"
                autoComplete="current-password"
                required
                minLength={PASSWORD_MIN_LENGTH}
                maxLength={PASSWORD_MAX_LENGTH}
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
              />
              <label htmlFor="new-password">New password</label>
              <input
                id="new-password"
                type="password"
                autoComplete="new-password"
                required
                minLength={PASSWORD_MIN_LENGTH}
                maxLength={PASSWORD_MAX_LENGTH}
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
              />
              <label htmlFor="confirm-password">Confirm new password</label>
              <input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                required
                minLength={PASSWORD_MIN_LENGTH}
                maxLength={PASSWORD_MAX_LENGTH}
                value={confirmNewPassword}
                onChange={(event) => setConfirmNewPassword(event.target.value)}
              />
              <div
                className="dialog-actions"
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: "0.75rem",
                  marginTop: "1.25rem",
                }}
              >
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy === "password"}
                  onClick={() => setShowPasswordModal(false)}
                >
                  Cancel
                </button>
                <button
                  className="primary-button fit"
                  disabled={busy === "password"}
                  type="submit"
                  style={{ marginTop: 0 }}
                >
                  {busy === "password" ? "Changing…" : "Change password"}
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function PageContent({
  path,
  admin,
  onSignedOut,
  onNavigate,
}: {
  path: string;
  admin: AdminProfile;
  onSignedOut: (message: string) => void;
  onNavigate: (path: string) => void;
}) {
  const defaultRoute = mainNavigation[0] ?? {
    label: "Dashboard",
    path: "/admin",
    icon: "dashboard",
  };
  const item =
    allKnownRoutes.find((entry) => entry.path === path) ?? defaultRoute;
  if (item.path === "/admin/security")
    return <SecurityPage admin={admin} onSignedOut={onSignedOut} />;
  if (item.path === "/admin/pricing")
    return <PricingPage onSessionExpired={onSignedOut} />;
  if (item.path === "/admin/manual-orders")
    return <ManualOrdersPage onSessionExpired={onSignedOut} />;
  if (item.path === "/admin/printer")
    return <PrinterPage onSessionExpired={onSignedOut} />;
  if (item.path === "/admin/shop-settings")
    return <ShopSettingsPage onSessionExpired={onSignedOut} />;
  if (item.path === "/admin/live-orders")
    return <LiveOrdersPage onSessionExpired={onSignedOut} />;
  if (item.path === "/admin/order-history")
    return <OrderHistoryPage onSessionExpired={onSignedOut} />;
  if (item.path === "/admin")
    return (
      <DashboardPage onSessionExpired={onSignedOut} onNavigate={onNavigate} />
    );
  return (
    <div className="welcome">
      <p className="eyebrow">Coming in a scheduled phase</p>
      <h1>{item.label}</h1>
      <p>
        This area is not available yet. It will be added without placeholder
        data or settings.
      </p>
    </div>
  );
}

function AdminShell({
  admin,
  onSignedOut,
}: {
  admin: AdminProfile;
  onSignedOut: (message: string) => void;
}) {
  const [path, navigate] = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [shellError, setShellError] = useState<string | null>(null);
  const [appName, setAppName] = useState(cachedAppName);

  const isSettingsRoute = settingsNavigation.some((item) => item.path === path);
  const [settingsOpen, setSettingsOpen] = useState(isSettingsRoute);

  useEffect(() => {
    if (isSettingsRoute) {
      setSettingsOpen(true);
    }
  }, [isSettingsRoute]);

  useEffect(() => {
    const update = (event: Event) => {
      const detail = (event as CustomEvent<{ appName?: string }>).detail;
      if (detail?.appName?.trim()) setAppName(detail.appName.trim());
    };
    window.addEventListener("printgo:branding", update);
    return () => window.removeEventListener("printgo:branding", update);
  }, []);

  const activePath = allKnownRoutes.some((item) => item.path === path)
    ? path
    : "/admin";

  const go = (event: MouseEvent<HTMLAnchorElement>, target: string) => {
    event.preventDefault();
    navigate(target);
    setMenuOpen(false);
  };

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    setShellError(null);
    try {
      await adminApi.logout();
      onSignedOut("You have been signed out.");
    } catch (caught: unknown) {
      setShellError(friendlyAdminError(caught));
      setSigningOut(false);
    }
  }

  return (
    <div className="admin-shell">
      <header className="topbar">
        <button
          className="menu-button"
          aria-expanded={menuOpen}
          aria-controls="admin-navigation"
          onClick={() => setMenuOpen((value) => !value)}
          type="button"
        >
          Menu
        </button>
        <a
          className="brand-link"
          href="/admin"
          onClick={(event) => go(event, "/admin")}
        >
          {appName.toUpperCase() === "PRINTGO" ? "PRINT_GO🔥" : appName}
        </a>
        <div className="account-actions">
          <span>{admin.loginIdentifier}</span>
          <button
            disabled={signingOut}
            onClick={() => void signOut()}
            type="button"
          >
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
      </header>
      <aside
        className={menuOpen ? "sidebar open" : "sidebar"}
        id="admin-navigation"
      >
        <nav aria-label="Admin navigation">
          <ul className="sidebar-nav-list">
            {mainNavigation.map((item) => (
              <li key={item.path}>
                <a
                  aria-current={activePath === item.path ? "page" : undefined}
                  className="sidebar-nav-link"
                  href={item.path}
                  onClick={(event) => go(event, item.path)}
                >
                  <span className="sidebar-nav-icon">
                    <NavIcon name={item.icon} />
                  </span>
                  <span className="sidebar-nav-label">{item.label}</span>
                </a>
              </li>
            ))}
            <li className="sidebar-nav-group">
              <button
                aria-expanded={settingsOpen}
                aria-controls="sidebar-settings-submenu"
                className={`sidebar-nav-link sidebar-group-toggle ${
                  isSettingsRoute ? "group-active" : ""
                }`}
                onClick={() => setSettingsOpen((prev) => !prev)}
                type="button"
              >
                <span className="sidebar-nav-icon">
                  <NavIcon name="settings" />
                </span>
                <span className="sidebar-nav-label">Settings</span>
                <span
                  className="sidebar-group-chevron"
                  style={{
                    marginLeft: "auto",
                    display: "inline-flex",
                    alignItems: "center",
                    transform: settingsOpen ? "rotate(180deg)" : "rotate(0deg)",
                    transition: "transform 0.2s ease",
                  }}
                  aria-hidden="true"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </span>
              </button>
              {settingsOpen ? (
                <ul id="sidebar-settings-submenu" className="sidebar-submenu">
                  {settingsNavigation.map((subItem) => (
                    <li key={subItem.path}>
                      <a
                        aria-current={
                          activePath === subItem.path ? "page" : undefined
                        }
                        className="sidebar-subnav-link"
                        href={subItem.path}
                        onClick={(event) => go(event, subItem.path)}
                      >
                        <span className="sidebar-subnav-icon">
                          <NavIcon name={subItem.icon} />
                        </span>
                        <span>{subItem.label}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          </ul>
        </nav>
      </aside>
      {menuOpen ? (
        <button
          className="scrim"
          aria-label="Close navigation"
          onClick={() => setMenuOpen(false)}
          type="button"
        />
      ) : null}
      <main className="page-content">
        {shellError ? (
          <p className="form-error shell-error" role="alert">
            {shellError}
          </p>
        ) : null}
        <PageContent
          path={activePath}
          admin={admin}
          onSignedOut={onSignedOut}
          onNavigate={navigate}
        />
      </main>
    </div>
  );
}

export function App() {
  const [state, setState] = useState<{
    status: "loading" | "signed-out" | "signed-in";
    admin?: AdminProfile;
    notice?: string;
  }>({ status: "loading" });
  useEffect(() => {
    let active = true;
    void adminApi
      .me()
      .then((response) => {
        if (active && response.ok)
          setState({ status: "signed-in", admin: response.data.admin });
      })
      .catch(() => {
        if (active) {
          setAdminToken(null);
          setState({ status: "signed-out" });
        }
      });
    return () => {
      active = false;
    };
  }, []);
  if (state.status === "loading") return <LoadingScreen />;
  if (state.status === "signed-out" || !state.admin)
    return (
      <LoginScreen
        notice={state.notice ?? null}
        onAuthenticated={(admin) => setState({ status: "signed-in", admin })}
      />
    );
  return (
    <AdminShell
      admin={state.admin}
      onSignedOut={(notice) => {
        setAdminToken(null);
        setState({ status: "signed-out", notice });
      }}
    />
  );
}
