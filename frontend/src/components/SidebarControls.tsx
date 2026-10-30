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
 * Borders and corners for one button of a segmented group, along whichever axis
 * the group runs: outer corners rounded, the borders its buttons share dropped,
 * and no border at all on the active one.
 *
 * Every edge is set as a longhand on every render, never via `border` (or
 * `borderWidth`, also a shorthand). React only rewrites the properties whose
 * values changed, so when the active button moves, a changed `border` shorthand
 * resets all four widths to 1px while the unchanged `borderRightWidth: 0`
 * beside it is not re-applied — and the seam doubles.
 */
function segmentStyle(index: number, count: number, vertical: boolean, active: boolean): CSSProperties {
  const first = index === 0;
  const last = index === count - 1;
  const width = (shown: boolean) => (active || !shown ? 0 : 1);
  const edges = vertical
    ? { top: width(first), bottom: width(last), left: width(true), right: width(true) }
    : { top: width(true), bottom: width(true), left: width(first), right: width(last) };
  const corners = vertical
    ? { topLeft: first, topRight: first, bottomLeft: last, bottomRight: last }
    : { topLeft: first, bottomLeft: first, topRight: last, bottomRight: last };
  return {
    borderStyle: "solid",
    borderColor: "var(--chatlist-item-border)",
    borderTopWidth: edges.top,
    borderRightWidth: edges.right,
    borderBottomWidth: edges.bottom,
    borderLeftWidth: edges.left,
    borderTopLeftRadius: corners.topLeft ? RADIUS : 0,
    borderTopRightRadius: corners.topRight ? RADIUS : 0,
    borderBottomLeftRadius: corners.bottomLeft ? RADIUS : 0,
    borderBottomRightRadius: corners.bottomRight ? RADIUS : 0,
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
                ...segmentStyle(index, SIDEBAR_NAV_ITEMS.length, vertical, active),
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
