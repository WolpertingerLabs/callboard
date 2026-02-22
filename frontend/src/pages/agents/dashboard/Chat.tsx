import { useState, useEffect, useCallback } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import { MessageSquare, Plus, Bot, ExternalLink } from "lucide-react";
import { listChats, getAgentIdentityPrompt, type Chat as ChatType } from "../../../api";
import { useIsMobile } from "../../../hooks/useIsMobile";
import type { AgentConfig, DefaultPermissions } from "shared";

function formatTime(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const isToday = d.getDate() === now.getDate() && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (isToday) return time;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

export default function Chat() {
  const { agent } = useOutletContext<{ agent: AgentConfig }>();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [conversations, setConversations] = useState<ChatType[]>([]);
  const [loading, setLoading] = useState(true);

  const loadConversations = useCallback(async () => {
    try {
      // Fetch all chats and filter to this agent's conversations
      const response = await listChats(9999, 0);
      const agentChats = response.chats.filter((chat) => {
        try {
          const meta = JSON.parse(chat.metadata || "{}");
          return meta.agentAlias === agent.alias;
        } catch {
          return false;
        }
      });
      setConversations(agentChats);
    } catch (err) {
      console.error("Failed to load agent conversations:", err);
    } finally {
      setLoading(false);
    }
  }, [agent.alias]);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  const handleNewChat = async () => {
    if (!agent.workspacePath) return;

    const agentPermissions: DefaultPermissions = {
      fileRead: "allow",
      fileWrite: "allow",
      codeExecution: "allow",
      webAccess: "allow",
    };

    // Fetch compiled identity prompt
    let systemPrompt: string | undefined;
    try {
      systemPrompt = await getAgentIdentityPrompt(agent.alias);
    } catch {
      // Continue without if fetch fails
    }

    navigate(`/chat/new?folder=${encodeURIComponent(agent.workspacePath)}`, {
      state: { defaultPermissions: agentPermissions, systemPrompt, agentAlias: agent.alias },
    });
  };

  const handleOpenChat = (chatId: string) => {
    navigate(`/chat/${chatId}`);
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <div
        style={{
          padding: isMobile ? "16px" : "20px 24px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <h3 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Conversations</h3>
        <button
          onClick={handleNewChat}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            background: "var(--accent)",
            color: "#fff",
            padding: "8px 14px",
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 500,
          }}
        >
          <Plus size={14} />
          New Chat
        </button>
      </div>

      {/* Conversation List */}
      <div style={{ flex: 1, overflow: "auto" }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)" }}>Loading conversations...</div>
        ) : conversations.length === 0 ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
              gap: 12,
              color: "var(--text-muted)",
              padding: 40,
            }}
          >
            <Bot size={40} />
            <p style={{ fontSize: 15, margin: 0 }}>No conversations yet</p>
            <p style={{ fontSize: 13, margin: 0, textAlign: "center" }}>Start a new chat to talk with {agent.name}</p>
            <button
              onClick={handleNewChat}
              style={{
                marginTop: 8,
                display: "flex",
                alignItems: "center",
                gap: 6,
                background: "var(--accent)",
                color: "#fff",
                padding: "10px 20px",
                borderRadius: 8,
                fontSize: 14,
                fontWeight: 500,
              }}
            >
              <Plus size={16} />
              Start Chat
            </button>
          </div>
        ) : (
          <div style={{ padding: isMobile ? "8px" : "8px 12px" }}>
            {conversations.map((chat) => {
              let preview: string | undefined;
              try {
                const meta = JSON.parse(chat.metadata || "{}");
                preview = meta.preview;
              } catch {}

              const displayName = preview ? (preview.length > 80 ? preview.slice(0, 80) + "..." : preview) : "Chat session";

              return (
                <button
                  key={chat.id}
                  onClick={() => handleOpenChat(chat.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    width: "100%",
                    textAlign: "left",
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: 10,
                    padding: "14px 16px",
                    marginBottom: 6,
                    cursor: "pointer",
                    transition: "border-color 0.15s",
                  }}
                >
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: "50%",
                      background: "color-mix(in srgb, var(--accent) 10%, transparent)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                    }}
                  >
                    <MessageSquare size={16} style={{ color: "var(--accent)" }} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 500,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {displayName}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>{formatTime(chat.updated_at)}</div>
                  </div>
                  <ExternalLink size={14} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
