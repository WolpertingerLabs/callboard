import { useNavigate, useLocation } from "react-router-dom";
import { Settings, Bot, PanelLeftClose, PanelLeftOpen, AlertTriangle, Plus, LayoutGrid, type LucideIcon } from "lucide-react";
import type { CSSProperties } from "react";
import { HEADER_BUTTON_STYLE, HEADER_ROW_GAP } from "./headerButtonStyle";

export interface SidebarNavItem {
  title: string;
  icon: LucideIcon;
  path: string;
  isActive: (pathname: string) => boolean;
}

/**
 * The page links in the sidebar's segmented group, in display order.
 *
 * The one list both renderings of the sidebar read — the open header lays it
 * out as a row, the collapsed rail as a column. They used to be written out
 * twice, and the rail quietly lost Board; a link added here appears in both.
 */
export const SIDEBAR_NAV_ITEMS: readonly SidebarNavItem[] = [
  { title: "Board", icon: LayoutGrid, path: "/board", isActive: (p) => p === "/board" },
  { title: "Agents", icon: Bot, path: "/agents", isActive: (p) => p.startsWith("/agents") },
  { title: "Settings", icon: Settings, path: "/settings", isActive: (p) => p === "/settings" },
];

const RADIUS = 6;

/**
 * Rounds the outer corners of a segmented group and drops the borders its
 * buttons share, along whichever axis the group runs.
 */
function segmentStyle(index: number, count: number, vertical: boolean): CSSProperties {
  const first = index === 0;
  const last = index === count - 1;
  if (vertical) {
    return {
      borderTopLeftRadius: first ? RADIUS : 0,
      borderTopRightRadius: first ? RADIUS : 0,
      borderBottomLeftRadius: last ? RADIUS : 0,
      borderBottomRightRadius: last ? RADIUS : 0,
      ...(last ? {} : { borderBottomWidth: 0 }),
      ...(first ? {} : { borderTopWidth: 0 }),
    };
  }
  return {
    borderTopLeftRadius: first ? RADIUS : 0,
    borderBottomLeftRadius: first ? RADIUS : 0,
    borderTopRightRadius: last ? RADIUS : 0,
    borderBottomRightRadius: last ? RADIUS : 0,
    ...(last ? {} : { borderRightWidth: 0 }),
    ...(first ? {} : { borderLeftWidth: 0 }),
  };
}

interface SidebarControlsProps {
  /** `horizontal` is the open header; `vertical` is the collapsed rail. */
  orientation: "horizontal" | "vertical";
  onNewChat: () => void;
  claudeLoggedIn?: boolean;
  onShowClaudeModal?: () => void;
  /** Collapses the sidebar from the header, expands it from the rail. */
  onToggleSidebar?: () => void;
}

/**
 * The sidebar's button set — New Chat, the page links, the login warning and
 * the collapse/expand toggle, in that order — shared by the open header and the
 * collapsed rail so the two cannot drift apart.
 */
export default function SidebarControls({ orientation, onNewChat, claudeLoggedIn, onShowClaudeModal, onToggleSidebar }: SidebarControlsProps) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const vertical = orientation === "vertical";
  const ToggleIcon = vertical ? PanelLeftOpen : PanelLeftClose;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: vertical ? "column" : "row",
        alignItems: "center",
        gap: vertical ? 8 : HEADER_ROW_GAP,
      }}
    >
      <button
        onClick={onNewChat}
        style={{
          ...HEADER_BUTTON_STYLE,
          background: "var(--accent)",
          color: "var(--text-on-accent)",
          borderRadius: RADIUS,
        }}
        title="New Chat"
      >
        <Plus size={16} />
      </button>
      <div role="group" aria-label="Pages" style={{ display: "flex", flexDirection: vertical ? "column" : "row" }}>
        {SIDEBAR_NAV_ITEMS.map((item, index) => {
          const active = item.isActive(pathname);
          const Icon = item.icon;
          return (
            <button
              key={item.path}
              onClick={() => navigate(item.path)}
              aria-current={active ? "page" : undefined}
              style={{
                ...HEADER_BUTTON_STYLE,
                background: active ? "var(--accent)" : "var(--bg-secondary)",
                color: active ? "var(--chatlist-icon-nav-active)" : "var(--chatlist-icon-nav)",
                border: active ? "none" : "1px solid var(--chatlist-item-border)",
                ...segmentStyle(index, SIDEBAR_NAV_ITEMS.length, vertical),
              }}
              title={item.title}
            >
              <Icon size={16} />
            </button>
          );
        })}
      </div>
      {claudeLoggedIn === false && onShowClaudeModal && (
        <button
          onClick={onShowClaudeModal}
          style={{
            ...HEADER_BUTTON_STYLE,
            background: "var(--warning-bg)",
            color: "var(--warning)",
            borderRadius: RADIUS,
          }}
          title="Claude Code login required"
        >
          <AlertTriangle size={16} />
        </button>
      )}
      {onToggleSidebar && (
        <button
          onClick={onToggleSidebar}
          style={{
            ...HEADER_BUTTON_STYLE,
            background: "transparent",
            color: "var(--chatlist-icon)",
            borderRadius: RADIUS,
          }}
          title={vertical ? "Expand sidebar" : "Collapse sidebar"}
        >
          <ToggleIcon size={16} />
        </button>
      )}
    </div>
  );
}
