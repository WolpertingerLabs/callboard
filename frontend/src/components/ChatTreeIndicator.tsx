import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CornerLeftUp, ListTree, Plus } from "lucide-react";
import { getChatTree, type ChatTreeNode, type ChatTreeResponse } from "../api";
import ProviderBadge from "./ProviderBadge";

/**
 * Chat-header indicator for the chat parentage tree.
 *
 * Fetches GET /api/chats/:id/tree once per chat and renders:
 *  - a parent breadcrumb pill (navigates to the immediate parent), and
 *  - a "Tree (N)" pill opening a dropdown of the full tree (ancestors +
 *    descendants across engines) for quick switching between linked chats,
 *    plus a "New linked chat" action that starts a sibling/child chat in the
 *    same folder pre-linked to this one.
 *
 * Renders nothing for chats with no lineage and no descendants.
 */

interface Props {
  chatId: string;
  folder?: string;
  compact?: boolean;
}

interface FlatNode {
  node: ChatTreeNode;
  depth: number;
}

function flatten(node: ChatTreeNode, depth: number, out: FlatNode[]): FlatNode[] {
  out.push({ node, depth });
  for (const child of node.children) flatten(child, depth + 1, out);
  return out;
}

const STATUS_DOT: Record<ChatTreeNode["status"], string> = {
  ongoing: "var(--status-active)",
  waiting: "var(--warning)",
  stopped: "var(--text-muted)",
};

export default function ChatTreeIndicator({ chatId, folder, compact }: Props) {
  const navigate = useNavigate();
  const [tree, setTree] = useState<ChatTreeResponse | null>(null);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Fetched once per chat — the parent renders this component with
  // key={chatId}, so state resets naturally on chat switch.
  useEffect(() => {
    let cancelled = false;
    getChatTree(chatId)
      .then((result) => {
        if (!cancelled) setTree(result);
      })
      .catch(() => {
        // No stored record / no tree — render nothing.
      });
    return () => {
      cancelled = true;
    };
  }, [chatId]);

  // Close the dropdown on outside click.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const flat = useMemo(() => (tree ? flatten(tree.tree, 0, []) : []), [tree]);

  if (!tree || flat.length <= 1) return null;

  const parent = tree.ancestors.length > 0 ? tree.ancestors[tree.ancestors.length - 1] : null;

  const pillStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    fontSize: 11,
    fontWeight: 500,
    padding: "2px 6px",
    borderRadius: 4,
    background: "var(--surface)",
    color: "var(--text-muted)",
    border: "1px solid var(--border)",
    cursor: "pointer",
    flexShrink: 0,
    maxWidth: 160,
    overflow: "hidden",
    whiteSpace: "nowrap",
  };

  return (
    <div ref={containerRef} style={{ position: "relative", display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
      {parent && (
        <button
          onClick={() => navigate(`/chat/${parent.chatId}`)}
          style={pillStyle}
          title={`Parent chat: ${parent.title || parent.chatId}${parent.role ? ` (${parent.role})` : ""}`}
        >
          <CornerLeftUp size={11} style={{ flexShrink: 0 }} />
          {!compact && <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{parent.title || "Parent"}</span>}
        </button>
      )}
      <button onClick={() => setOpen(!open)} style={pillStyle} title={`Chat tree: ${flat.length} linked chats`}>
        <ListTree size={11} style={{ flexShrink: 0 }} />
        {compact ? flat.length : `Tree (${flat.length})`}
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            zIndex: 50,
            minWidth: 280,
            maxWidth: 380,
            maxHeight: 400,
            overflowY: "auto",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            boxShadow: "var(--shadow-md)",
            padding: "4px 0",
          }}
        >
          {flat.map(({ node, depth }) => {
            const isCurrent = node.chatId === chatId;
            return (
              <div
                key={node.chatId}
                onClick={() => {
                  setOpen(false);
                  if (!isCurrent) navigate(`/chat/${node.chatId}`);
                }}
                title={node.title || node.folder}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "5px 12px",
                  paddingLeft: 12 + depth * 14,
                  cursor: isCurrent ? "default" : "pointer",
                  background: isCurrent ? "var(--chatlist-item-active-bg)" : "transparent",
                  minWidth: 0,
                }}
              >
                <span
                  title={`Status: ${node.status}`}
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    flexShrink: 0,
                    background: STATUS_DOT[node.status] || "var(--text-muted)",
                  }}
                />
                <ProviderBadge provider={node.provider === "claude-code" ? undefined : node.provider} acpProviderId={node.acpProviderId} compact />
                {node.role && (
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 600,
                      padding: "1px 5px",
                      borderRadius: 4,
                      background: "var(--chatlist-badge-status-bg)",
                      color: "var(--chatlist-badge-status-text)",
                      flexShrink: 0,
                    }}
                  >
                    {node.role}
                  </span>
                )}
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: isCurrent ? 600 : 400,
                    color: "var(--text)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    minWidth: 0,
                  }}
                >
                  {node.title || node.folder.split("/").pop() || node.chatId}
                </span>
              </div>
            );
          })}
          {folder && (
            <div
              onClick={() => {
                setOpen(false);
                navigate(`/chat/new?folder=${encodeURIComponent(folder)}`, {
                  state: { parentChatId: chatId, chatRole: "linked" },
                });
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "6px 12px",
                cursor: "pointer",
                borderTop: "1px solid var(--border)",
                marginTop: 4,
                color: "var(--accent-text)",
                fontSize: 12,
                fontWeight: 500,
              }}
              title="Start a new chat linked under this one (pick any engine in the new chat panel)"
            >
              <Plus size={12} />
              New linked chat
            </div>
          )}
        </div>
      )}
    </div>
  );
}
