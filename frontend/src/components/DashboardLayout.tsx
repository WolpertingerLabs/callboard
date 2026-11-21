import { useEffect, useState } from "react";
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
  { to: "/ingestors", label: "Ingestors", icon: Radio },
  { to: "/sessions", label: "Sessions", icon: Activity },
  { to: "/secrets", label: "Secrets", icon: KeyRound },
  { to: "/vault", label: "Vault", icon: Vault },
  { to: "/logs", label: "Logs", icon: ScrollText },
];

/** Pending vault access requests, for the nav badge (polled, and refreshed on change). */
function usePendingVaultRequests(daemon: string): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (daemon !== "up") return;
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
    daemon === "up"
      ? `daemon up · v${meta?.version ?? "?"}`
      : daemon === "down"
        ? "daemon offline"
        : "checking…";

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
        <span className="sidebar-brand-text">drawlatch</span>
      </div>

      <div className="sidebar-status" title={meta?.configPath ?? ""}>
        <span
          className={`status-dot ${daemon === "up" ? "up" : daemon === "down" ? "down" : ""}`}
          aria-hidden="true"
        />
        <span className="sidebar-status-text">{statusLabel}</span>
      </div>

      <nav className="sidebar-nav">
        {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            onClick={onNavigate}
            className={({ isActive }) =>
              `sidebar-nav-link${isActive ? " active" : ""}`
            }
            title={
              to === "/vault" && pendingVault > 0
                ? `${label}: ${pendingVault} pending access request${pendingVault === 1 ? "" : "s"}`
                : label
            }
          >
            <Icon size={16} aria-hidden="true" />
            <span className="sidebar-nav-label">{label}</span>
            {to === "/vault" && pendingVault > 0 && (
              <span className="sidebar-nav-badge" aria-label={`${pendingVault} pending`}>
                {pendingVault}
              </span>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="sidebar-footer">
        <NavLink
          to="/settings/password"
          onClick={onNavigate}
          className={({ isActive }) =>
            `sidebar-nav-link${isActive ? " active" : ""}`
          }
          title="Change password"
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

export default function DashboardLayout({ onLogout }: Props) {
  const isMobile = useIsMobile();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const showDrawer = isMobile && drawerOpen;

  // Lock body scroll while the drawer is open on mobile.
  useEffect(() => {
    if (!showDrawer) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [showDrawer]);

  if (isMobile) {
    return (
      <div className="app-shell app-shell-mobile">
        <header className="mobile-topbar">
          <button
            type="button"
            className="mobile-topbar-button"
            aria-label="Open navigation"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen(true)}
          >
            <Menu size={20} aria-hidden="true" />
          </button>
          <div className="mobile-topbar-title">
            <span className="sidebar-brand-mark" aria-hidden="true" />
            <span>drawlatch</span>
          </div>
        </header>

        <main className="main-content main-content-mobile">
          <Outlet />
        </main>

        {showDrawer && (
          <div
            className="mobile-drawer-overlay"
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            onClick={() => setDrawerOpen(false)}
          >
            <aside
              className="sidebar mobile-drawer"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                className="mobile-drawer-close"
                aria-label="Close navigation"
                onClick={() => setDrawerOpen(false)}
              >
                <X size={20} aria-hidden="true" />
              </button>
              <SidebarBody
                onLogout={onLogout}
                onNavigate={() => setDrawerOpen(false)}
              />
            </aside>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <SidebarBody onLogout={onLogout} />
      </aside>

      <main className="main-content">
        <Outlet />
      </main>
    </div>
  );
}
