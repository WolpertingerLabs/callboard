import { useLocation } from "react-router-dom";
import { useRef, useState, useCallback, useEffect } from "react";
import { useIsMobile } from "../hooks/useIsMobile";
import ChatList from "../pages/ChatList";
import FolderList from "../pages/FolderList";
import JobList from "../pages/JobList";
import Chat from "../pages/Chat";
import Settings from "../pages/Settings";
import AgentList from "../pages/agents/AgentList";
import CreateAgent from "../pages/agents/CreateAgent";
import AgentDashboard from "../pages/agents/AgentDashboard";
import {
  getSidebarCollapsed,
  saveSidebarCollapsed,
  getSidebarViewMode,
  saveSidebarViewMode,
  getSidebarWidth,
  saveSidebarWidth,
  SIDEBAR_MIN_WIDTH,
  type SidebarViewMode,
} from "../utils/localStorage";

/** Largest the expanded sidebar may be dragged: 60% of the window, capped at 700px. */
function maxSidebarWidth(): number {
  return Math.min(window.innerWidth * 0.6, 700);
}

interface SplitLayoutProps {
  onLogout: () => void;
  claudeLoggedIn?: boolean;
  onShowClaudeModal?: () => void;
}

export default function SplitLayout({ onLogout, claudeLoggedIn, onShowClaudeModal }: SplitLayoutProps) {
  const isMobile = useIsMobile();
  const location = useLocation();
  const chatListRefreshRef = useRef<(() => void) | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => getSidebarCollapsed());
  const [viewMode, setViewMode] = useState<SidebarViewMode>(() => getSidebarViewMode());
  const [sidebarWidth, setSidebarWidth] = useState(() => getSidebarWidth());
  const [isResizing, setIsResizing] = useState(false);
  const layoutRef = useRef<HTMLDivElement | null>(null);

  // Drag-to-resize the expanded desktop sidebar. Listeners live on window so the
  // drag keeps tracking even when the cursor moves over the main pane / iframe-free
  // areas; cleaned up on mouseup. Width is clamped to [SIDEBAR_MIN_WIDTH, maxSidebarWidth()].
  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const layout = layoutRef.current;
    if (!layout) return;
    const left = layout.getBoundingClientRect().left;
    setIsResizing(true);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    const onMove = (ev: MouseEvent) => {
      const next = Math.max(SIDEBAR_MIN_WIDTH, Math.min(ev.clientX - left, maxSidebarWidth()));
      setSidebarWidth(next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      setIsResizing(false);
      setSidebarWidth((w) => {
        saveSidebarWidth(w);
        return w;
      });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  // Keep the stored width within bounds if the window is resized smaller.
  useEffect(() => {
    const onResize = () => {
      setSidebarWidth((w) => {
        const clamped = Math.max(SIDEBAR_MIN_WIDTH, Math.min(w, maxSidebarWidth()));
        if (clamped !== w) saveSidebarWidth(clamped);
        return clamped;
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const changeViewMode = useCallback((mode: SidebarViewMode) => {
    saveSidebarViewMode(mode);
    setViewMode(mode);
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      saveSidebarCollapsed(next);
      return next;
    });
  }, []);

  // Check if we're on the settings page (including sub-tab routes like /settings/api)
  const isSettings = location.pathname === "/settings" || location.pathname.startsWith("/settings/");

  // Check if we're on the new chat page
  const isNewChat = location.pathname === "/chat/new";

  // Check if we're on a chat page (but not the "new" page)
  const chatMatch = !isNewChat && location.pathname.match(/^\/chat\/(.+)$/);
  const activeChatId = chatMatch ? chatMatch[1] : null;

  // Check if we're on agent pages
  const isAgentList = location.pathname === "/agents";
  const isCreateAgent = location.pathname === "/agents/new";
  // Match /agents/:alias (but not /agents or /agents/new)
  const isAgentDashboard = !isAgentList && !isCreateAgent && /^\/agents\/[^/]+/.test(location.pathname);

  const refreshChatList = () => {
    chatListRefreshRef.current?.();
  };

  // Mobile behavior - keep existing full-page navigation
  if (isMobile) {
    if (isSettings) {
      return <Settings onLogout={onLogout} />;
    }
    if (isAgentList) {
      return <AgentList />;
    }
    if (isCreateAgent) {
      return <CreateAgent />;
    }
    if (isAgentDashboard) {
      return <AgentDashboard />;
    }
    if (isNewChat) {
      return <Chat onChatListRefresh={refreshChatList} />;
    }
    if (activeChatId) {
      return <Chat onChatListRefresh={refreshChatList} />;
    }
    if (viewMode === "folders") {
      return (
        <FolderList
          onRefresh={(fn) => {
            chatListRefreshRef.current = fn;
          }}
          claudeLoggedIn={claudeLoggedIn}
          onShowClaudeModal={onShowClaudeModal}
          onViewModeChange={changeViewMode}
        />
      );
    }
    if (viewMode === "jobs") {
      return (
        <JobList
          onRefresh={(fn) => {
            chatListRefreshRef.current = fn;
          }}
          claudeLoggedIn={claudeLoggedIn}
          onShowClaudeModal={onShowClaudeModal}
          onViewModeChange={changeViewMode}
        />
      );
    }
    return (
      <ChatList
        onRefresh={(fn) => {
          chatListRefreshRef.current = fn;
        }}
        claudeLoggedIn={claudeLoggedIn}
        onShowClaudeModal={onShowClaudeModal}
        onViewModeChange={changeViewMode}
      />
    );
  }

  // Desktop behavior - split view
  return (
    <div
      ref={layoutRef}
      className="split-layout"
      style={{
        display: "flex",
        height: "100%",
        overflow: "hidden",
      }}
    >
      {/* Chat List Sidebar */}
      <div
        className={`split-sidebar${sidebarCollapsed ? " split-sidebar-collapsed" : ""}${isResizing ? " is-resizing" : ""}`}
        style={{
          width: sidebarCollapsed ? "56px" : sidebarWidth,
          minWidth: sidebarCollapsed ? "56px" : SIDEBAR_MIN_WIDTH,
          flexShrink: 0,
          borderRight: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          background: "var(--bg-sidebar)",
          overflow: "hidden",
        }}
      >
        {viewMode === "folders" ? (
          <FolderList
            activeChatId={activeChatId ?? undefined}
            onRefresh={(fn) => {
              chatListRefreshRef.current = fn;
            }}
            sidebarCollapsed={sidebarCollapsed}
            onToggleSidebar={toggleSidebar}
            claudeLoggedIn={claudeLoggedIn}
            onShowClaudeModal={onShowClaudeModal}
            onViewModeChange={changeViewMode}
          />
        ) : viewMode === "jobs" ? (
          <JobList
            activeChatId={activeChatId ?? undefined}
            onRefresh={(fn) => {
              chatListRefreshRef.current = fn;
            }}
            sidebarCollapsed={sidebarCollapsed}
            onToggleSidebar={toggleSidebar}
            claudeLoggedIn={claudeLoggedIn}
            onShowClaudeModal={onShowClaudeModal}
            onViewModeChange={changeViewMode}
          />
        ) : (
          <ChatList
            activeChatId={activeChatId ?? undefined}
            onRefresh={(fn) => {
              chatListRefreshRef.current = fn;
            }}
            sidebarCollapsed={sidebarCollapsed}
            onToggleSidebar={toggleSidebar}
            claudeLoggedIn={claudeLoggedIn}
            onShowClaudeModal={onShowClaudeModal}
            onViewModeChange={changeViewMode}
          />
        )}
      </div>

      {/* Resize handle — invisible until hover; only when the sidebar is expanded */}
      {!sidebarCollapsed && (
        <div
          className={`split-resize-handle${isResizing ? " is-resizing" : ""}`}
          onMouseDown={startResize}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
        />
      )}

      {/* Main Content Area */}
      <div
        className="split-main"
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          background: "var(--bg)",
        }}
      >
        {isSettings ? (
          <Settings onLogout={onLogout} />
        ) : isAgentList ? (
          <AgentList />
        ) : isCreateAgent ? (
          <CreateAgent />
        ) : isAgentDashboard ? (
          <AgentDashboard />
        ) : isNewChat ? (
          <Chat onChatListRefresh={refreshChatList} />
        ) : activeChatId ? (
          <Chat onChatListRefresh={refreshChatList} />
        ) : (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
              color: "var(--text-muted)",
              fontSize: 16,
            }}
          >
            Select a chat to start coding
          </div>
        )}
      </div>
    </div>
  );
}
