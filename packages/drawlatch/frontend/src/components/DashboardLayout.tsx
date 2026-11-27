import { useCallback, useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import {
  LayoutDashboard,
  Cable,
  Users,
  Radio,
  Activity,
  KeyRound,
  ScrollText,
  Lock,
  LogOut,
  Menu,
  Vault,
  X,
  type LucideIcon,
} from "lucide-react";
import { api, isDaemonDown, VAULT_REQUESTS_CHANGED } from "../api";
import { useDaemon } from "../contexts/DaemonContext";
import { useIsMobile } from "../hooks/useIsMobile";
import { logout } from "../auth";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/connections", label: "Connections", icon: Cable },
  { to: "/callers", label: "Callers", icon: Users },
  { to: "/ingestors", label: "Listeners", icon: Radio },
  { to: "/sessions", label: "Sessions", icon: Activity },
  { to: "/secrets", label: "Secrets", icon: KeyRound },
  { to: "/vault", label: "Vault", icon: Vault },
  { to: "/logs", label: "Events", icon: ScrollText },
];

/** Pending vault access requests, for the nav badge (polled, and refreshed on change). */
function usePendingVaultRequests(daemon: string): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (daemon !== "up") {
      // A count from before the daemon went away is stale.
      setCount(0);
      return;
    }
    let live = true;
    const load = async () => {
      const res = await api.vaultStatus();
      if (live && !isDaemonDown(res)) setCount(res.pendingRequests);
    };
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    const onChange = () => void load();
    window.addEventListener(VAULT_REQUESTS_CHANGED, onChange);
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener(VAULT_REQUESTS_CHANGED, onChange);
    };
  }, [daemon]);
  return count;
}

interface SidebarBodyProps {
  onLogout: () => void;
  onNavigate?: () => void;
}

function SidebarBody({ onLogout, onNavigate }: SidebarBodyProps) {
  const { daemon, meta } = useDaemon();
  const navigate = useNavigate();
  const pendingVault = usePendingVaultRequests(daemon);
  const [loggingOut, setLoggingOut] = useState(false);

  const statusLabel =
    daemon === "up" ? "Daemon running" : daemon === "down" ? "Daemon offline" : "Checking…";
  const version = daemon === "up" && meta?.version ? `v${meta.version}` : "";

  async function handleLogout(): Promise<void> {
    if (loggingOut) return;
    setLoggingOut(true);
    await logout();
    onNavigate?.();
    onLogout();
    navigate("/", { replace: true });
  }

  return (
    <>
      <div className="sidebar-brand">
        <span className="sidebar-brand-mark" aria-hidden="true" />
        <span className="sidebar-brand-text">Drawlatch</span>
      </div>

      <div
        className="sidebar-status"
        title={[statusLabel, version, daemon === "up" ? meta?.configPath : ""]
          .filter(Boolean)
          .join(" · ")}
        role="status"
        aria-live="polite"
      >
        <span
          className={`status-dot ${daemon === "up" ? "up" : daemon === "down" ? "down" : ""}`}
          aria-hidden="true"
        />
        {/* Hidden visually on the icon-only tablet sidebar, still read out. */}
        <span className="sidebar-status-text">
          <span className="sidebar-status-label">{statusLabel}</span>
          {version && <span className="sidebar-status-version">{version}</span>}
        </span>
      </div>

      <nav className="sidebar-nav" aria-label="Main">
        {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => {
          const badge = to === "/vault" && pendingVault > 0 ? pendingVault : 0;
          // The label is hidden on the icon-only tablet sidebar, so the link
          // carries its name itself (and the badge's meaning).
          const name = badge
            ? `${label}: ${badge} pending access request${badge === 1 ? "" : "s"}`
            : label;
          return (
            <NavLink
              key={to}
              to={to}
              end={end}
              onClick={onNavigate}
              className={({ isActive }) =>
                `sidebar-nav-link${isActive ? " active" : ""}`
              }
              title={name}
              aria-label={name}
            >
              <Icon size={16} aria-hidden="true" />
              <span className="sidebar-nav-label">{label}</span>
              {badge > 0 && (
                <span className="sidebar-nav-badge" aria-hidden="true">
                  {badge}
                </span>
              )}
            </NavLink>
          );
        })}
      </nav>

      <div className="sidebar-footer">
        <NavLink
          to="/settings/password"
          onClick={onNavigate}
          className={({ isActive }) =>
            `sidebar-nav-link${isActive ? " active" : ""}`
          }
          title="Change password"
          aria-label="Change password"
        >
          <Lock size={16} aria-hidden="true" />
          <span className="sidebar-nav-label">Change password</span>
        </NavLink>
        <button
          type="button"
          className="sidebar-nav-link sidebar-logout"
          onClick={handleLogout}
          disabled={loggingOut}
          title="Log out"
          aria-label={loggingOut ? "Signing out" : "Log out"}
        >
          <LogOut size={16} aria-hidden="true" />
          <span className="sidebar-nav-label">
            {loggingOut ? "Signing out…" : "Log out"}
          </span>
        </button>
      </div>
    </>
  );
}

interface Props {
  onLogout: () => void;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function DashboardLayout({ onLogout }: Props) {
  const isMobile = useIsMobile();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const showDrawer = isMobile && drawerOpen;
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);

  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  // Widening past the breakpoint turns the drawer back into the sidebar.
  useEffect(() => {
    if (!isMobile) setDrawerOpen(false);
  }, [isMobile]);

  // While the drawer is open: lock scroll, move focus in, keep Tab inside,
  // close on Escape, and hand focus back to the menu button afterwards.
  useEffect(() => {
    if (!showDrawer) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setDrawerOpen(false);
        return;
      }
      if (e.key !== "Tab" || !sidebarRef.current) return;
      const items = Array.from(
        sidebarRef.current.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((el) => el.getClientRects().length > 0);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && sidebarRef.current.contains(active);
      if (e.shiftKey && (active === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);

    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
      // Unless the user has already moved focus somewhere else on the page.
      const active = document.activeElement;
      if (!active || active === document.body || sidebarRef.current?.contains(active)) {
        menuButtonRef.current?.focus({ preventScroll: true });
      }
    };
  }, [showDrawer]);

  // One tree at every width (the drawer is the sidebar, restyled in CSS), so
  // crossing 768px never remounts <Outlet/> and loses an open dialog or form.
  return (
    <div className={`app-shell${showDrawer ? " drawer-open" : ""}`}>
      <header className="mobile-topbar">
        <button
          ref={menuButtonRef}
          type="button"
          className="mobile-topbar-button"
          aria-label="Open navigation"
          aria-controls="dl-sidebar"
          aria-expanded={showDrawer}
          onClick={() => setDrawerOpen(true)}
        >
          <Menu size={20} aria-hidden="true" />
        </button>
        <div className="mobile-topbar-title">
          <span className="sidebar-brand-mark" aria-hidden="true" />
          <span>Drawlatch</span>
        </div>
      </header>

      {showDrawer && <div className="drawer-backdrop" aria-hidden="true" onClick={closeDrawer} />}

      <aside
        ref={sidebarRef}
        id="dl-sidebar"
        className="sidebar"
        {...(showDrawer
          ? { role: "dialog", "aria-modal": true, "aria-label": "Navigation" }
          : { "aria-label": "Sidebar" })}
      >
        <button
          ref={closeButtonRef}
          type="button"
          className="mobile-drawer-close"
          aria-label="Close navigation"
          onClick={closeDrawer}
        >
          <X size={20} aria-hidden="true" />
        </button>
        <SidebarBody onLogout={onLogout} onNavigate={isMobile ? closeDrawer : undefined} />
      </aside>

      <main className="main-content">
        <Outlet />
      </main>
    </div>
  );
}
