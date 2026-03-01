import { useLocation } from "react-router-dom";
import { useRef, useState, useCallback } from "react";
import { useIsMobile } from "../hooks/useIsMobile";
import ChatList from "../pages/ChatList";
import Chat from "../pages/Chat";
import Queue from "../pages/Queue";
import Settings from "../pages/Settings";
import AgentList from "../pages/agents/AgentList";
import CreateAgent from "../pages/agents/CreateAgent";
import AgentDashboard from "../pages/agents/AgentDashboard";
import { getSidebarCollapsed, saveSidebarCollapsed } from "../utils/localStorage";

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

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      saveSidebarCollapsed(next);
      return next;
    });
  }, []);

  // Check if we're on the settings page
  const isSettings = location.pathname === "/settings";

  // Check if we're on the queue/drafts page
  const isQueue = location.pathname === "/queue";

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
    if (isQueue) {
      return <Queue />;
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
    return (
      <ChatList
        onRefresh={(fn) => {
          chatListRefreshRef.current = fn;
        }}
        claudeLoggedIn={claudeLoggedIn}
        onShowClaudeModal={onShowClaudeModal}
      />
    );
  }

  // Desktop behavior - split view
  return (
    <div
      className="split-layout"
      style={{
        display: "flex",
        height: "100%",
        overflow: "hidden",
      }}
    >
      {/* Chat List Sidebar */}
      <div
        className={`split-sidebar${sidebarCollapsed ? " split-sidebar-collapsed" : ""}`}
        style={{
          width: sidebarCollapsed ? "56px" : "25%",
          minWidth: sidebarCollapsed ? "56px" : "300px",
          borderRight: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          background: "var(--bg)",
          overflow: "hidden",
        }}
      >
        <ChatList
          activeChatId={activeChatId ?? undefined}
          onRefresh={(fn) => {
            chatListRefreshRef.current = fn;
          }}
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={toggleSidebar}
          claudeLoggedIn={claudeLoggedIn}
          onShowClaudeModal={onShowClaudeModal}
        />
      </div>

      {/* Main Content Area */}
      <div
        className="split-main"
        style={{
          width: sidebarCollapsed ? "calc(100% - 56px)" : "75%",
          display: "flex",
          flexDirection: "column",
          background: "var(--bg)",
        }}
      >
        {isSettings ? (
          <Settings onLogout={onLogout} />
        ) : isQueue ? (
          <Queue />
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
