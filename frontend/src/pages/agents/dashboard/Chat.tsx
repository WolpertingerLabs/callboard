import { useState, useRef, useEffect } from "react";
import { useOutletContext } from "react-router-dom";
import { Send, Bot, User } from "lucide-react";
import { useIsMobile } from "../../../hooks/useIsMobile";
import { mockMessages } from "./mockData";
import type { MockChatMessage } from "./mockData";
import type { AgentConfig } from "shared";

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const isToday =
    d.getDate() === now.getDate() &&
    d.getMonth() === now.getMonth() &&
    d.getFullYear() === now.getFullYear();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (isToday) return time;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

export default function Chat() {
  const { agent } = useOutletContext<{ agent: AgentConfig }>();
  const isMobile = useIsMobile();
  const [messages, setMessages] = useState<MockChatMessage[]>(mockMessages);
  const [input, setInput] = useState("");
  const [typing, setTyping] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = () => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, typing]);

  const mockReplies = [
    "I've looked into that and here's what I found. The data shows a clear trend we should discuss further.",
    "Done! I've updated the relevant systems. Let me know if you need anything else.",
    "That's a great question. Based on the information from our connected services, I'd recommend we take a closer look at the recent activity patterns.",
    "I've checked all connected channels and everything looks normal. No alerts or unusual activity to report.",
    "I'll set that up right away. You should see the changes reflected in the next few minutes.",
  ];

  const handleSend = () => {
    const text = input.trim();
    if (!text) return;

    const userMsg: MockChatMessage = {
      id: `m-${Date.now()}`,
      role: "user",
      content: text,
      timestamp: Date.now(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setTyping(true);

    // Mock auto-reply
    setTimeout(() => {
      const reply: MockChatMessage = {
        id: `m-${Date.now()}-reply`,
        role: "assistant",
        content: mockReplies[Math.floor(Math.random() * mockReplies.length)],
        timestamp: Date.now(),
      };
      setTyping(false);
      setMessages((prev) => [...prev, reply]);
    }, 1200 + Math.random() * 800);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* Messages */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflow: "auto",
          padding: isMobile ? "16px" : "24px 32px",
        }}
      >
        {messages.length === 0 ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
              gap: 12,
              color: "var(--text-muted)",
            }}
          >
            <Bot size={40} />
            <p style={{ fontSize: 15 }}>Start a conversation with {agent.name}</p>
          </div>
        ) : (
          <div style={{ maxWidth: 680, margin: "0 auto", display: "flex", flexDirection: "column", gap: 16 }}>
            {messages.map((msg) => {
              const isUser = msg.role === "user";
              return (
                <div
                  key={msg.id}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: isUser ? "flex-end" : "flex-start",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "flex-end", gap: 8, maxWidth: "85%" }}>
                    {!isUser && (
                      <div
                        style={{
                          width: 28,
                          height: 28,
                          borderRadius: "50%",
                          background: "color-mix(in srgb, var(--accent) 12%, transparent)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          flexShrink: 0,
                        }}
                      >
                        <Bot size={14} style={{ color: "var(--accent)" }} />
                      </div>
                    )}
                    <div
                      style={{
                        padding: "10px 14px",
                        borderRadius: isUser ? "14px 14px 4px 14px" : "14px 14px 14px 4px",
                        background: isUser ? "var(--accent)" : "var(--surface)",
                        color: isUser ? "#fff" : "var(--text)",
                        border: isUser ? "none" : "1px solid var(--border)",
                        fontSize: 14,
                        lineHeight: 1.6,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                      }}
                    >
                      {msg.content}
                    </div>
                    {isUser && (
                      <div
                        style={{
                          width: 28,
                          height: 28,
                          borderRadius: "50%",
                          background: "var(--bg-secondary)",
                          border: "1px solid var(--border)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          flexShrink: 0,
                        }}
                      >
                        <User size={14} style={{ color: "var(--text-muted)" }} />
                      </div>
                    )}
                  </div>
                  <span
                    style={{
                      fontSize: 11,
                      color: "var(--text-muted)",
                      marginTop: 4,
                      paddingLeft: isUser ? 0 : 36,
                      paddingRight: isUser ? 36 : 0,
                    }}
                  >
                    {formatTime(msg.timestamp)}
                  </span>
                </div>
              );
            })}

            {/* Typing indicator */}
            {typing && (
              <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
                <div
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: "50%",
                    background: "color-mix(in srgb, var(--accent) 12%, transparent)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  <Bot size={14} style={{ color: "var(--accent)" }} />
                </div>
                <div
                  style={{
                    padding: "10px 14px",
                    borderRadius: "14px 14px 14px 4px",
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    fontSize: 14,
                    color: "var(--text-muted)",
                  }}
                >
                  Thinking…
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Input bar */}
      <div
        style={{
          padding: isMobile ? "12px 16px" : "12px 32px",
          borderTop: "1px solid var(--border)",
          background: "var(--surface)",
          flexShrink: 0,
          paddingBottom: isMobile ? "calc(12px + var(--safe-bottom))" : 12,
        }}
      >
        <div
          style={{
            maxWidth: 680,
            margin: "0 auto",
            display: "flex",
            gap: 10,
            alignItems: "center",
          }}
        >
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={`Message ${agent.name}...`}
            style={{
              flex: 1,
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: "12px 14px",
              fontSize: 14,
            }}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim()}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 42,
              height: 42,
              borderRadius: 10,
              background: input.trim() ? "var(--accent)" : "var(--border)",
              color: "#fff",
              flexShrink: 0,
              transition: "background 0.15s",
            }}
          >
            <Send size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}
