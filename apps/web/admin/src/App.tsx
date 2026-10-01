import type { AdminProfile } from "@printgo/api-contract";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@printgo/validation";
import {
  useEffect,
  useId,
  useState,
  type FormEvent,
  type MouseEvent,
} from "react";

import { adminApi, AdminApiError, friendlyAdminError } from "./api";
import { PricingPage } from "./PricingPage";
import { PrinterPage } from "./PrinterPage";
import { ShopSettingsPage } from "./ShopSettingsPage";
import { LiveOrdersPage } from "./LiveOrdersPage";
import { DashboardPage } from "./DashboardPage";

const navigation = [
  { label: "Dashboard", path: "/admin" },
  { label: "Live Orders", path: "/admin/live-orders" },
  { label: "Order History", path: "/admin/order-history" },
  { label: "Failed Jobs", path: "/admin/failed-jobs" },
  { label: "Printer", path: "/admin/printer" },
  { label: "Pricing", path: "/admin/pricing" },
  { label: "Reports", path: "/admin/reports" },
  { label: "Shop Settings", path: "/admin/shop-settings" },
  { label: "Security", path: "/admin/security" },
] as const;

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
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"password" | "all" | "logout" | null>(null);

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setMessage(null);
    setError(null);
    if (newPassword !== confirmNewPassword) {
      setError("New passwords do not match.");
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
        setMessage(response.data.message);
      }
    } catch (caught: unknown) {
      if (caught instanceof AdminApiError && caught.status === 401) {
        onSignedOut("Your session has expired. Please sign in again.");
        return;
      }
      setError(friendlyAdminError(caught));
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
      <section className="panel">
        <h2>Change password</h2>
        <p className="muted">
          Use {PASSWORD_MIN_LENGTH} to {PASSWORD_MAX_LENGTH} characters.
          Passphrases are welcome.
        </p>
        <form
          className="security-form"
          onSubmit={(event) => void changePassword(event)}
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
          <button
            className="primary-button fit"
            disabled={busy !== null}
            type="submit"
          >
            {busy === "password" ? "Changing…" : "Change password"}
          </button>
        </form>
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
  const item = navigation.find((entry) => entry.path === path) ?? navigation[0];
  if (item.path === "/admin/security")
    return <SecurityPage admin={admin} onSignedOut={onSignedOut} />;
  if (item.path === "/admin/pricing")
    return <PricingPage onSessionExpired={onSignedOut} />;
  if (item.path === "/admin/printer")
    return <PrinterPage onSessionExpired={onSignedOut} />;
  if (item.path === "/admin/shop-settings")
    return <ShopSettingsPage onSessionExpired={onSignedOut} />;
  if (item.path === "/admin/live-orders")
    return <LiveOrdersPage onSessionExpired={onSignedOut} />;
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
  useEffect(() => {
    const update = (event: Event) => {
      const detail = (event as CustomEvent<{ appName?: string }>).detail;
      if (detail?.appName?.trim()) setAppName(detail.appName.trim());
    };
    window.addEventListener("printgo:branding", update);
    return () => window.removeEventListener("printgo:branding", update);
  }, []);
  const activePath = navigation.some((item) => item.path === path)
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
          {appName}
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
          <ul>
            {navigation.map((item) => (
              <li key={item.path}>
                <a
                  aria-current={activePath === item.path ? "page" : undefined}
                  href={item.path}
                  onClick={(event) => go(event, item.path)}
                >
                  {item.label}
                </a>
              </li>
            ))}
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
        if (active) setState({ status: "signed-out" });
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
      onSignedOut={(notice) => setState({ status: "signed-out", notice })}
    />
  );
}
