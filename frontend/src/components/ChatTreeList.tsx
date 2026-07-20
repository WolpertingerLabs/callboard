import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, ChevronRight, ListTree, Loader2 } from "lucide-react";
import { getChatTree, type Chat, type ChatTreeNode, type ChatTreeResponse } from "../api";
import ChatListItem from "./ChatListItem";
import ProviderBadge from "./ProviderBadge";

/**
 * Tree-layout rendering of the sidebar chat list.
 *
 * Chats are grouped by their parentage-tree root (metadata `rootChatId`,
 * aliasing legacy `parentChatId`/`forkedFrom` pointers). Chats without any
 * lineage render exactly like the flat list. Groups render their most
 * recently updated loaded chat as the header row with a chevron; expanding
 * fetches the authoritative full tree from GET /api/chats/:id/tree (which
 * includes members outside the currently loaded page) and renders it
 * depth-indented.
 */

interface Props {
  chats: Chat[];
  activeChatId?: string;
  onChatClick: (chat: Chat) => void;
  onDelete: (chat: Chat) => void;
  onToggleBookmark: (chat: Chat, bookmarked: boolean) => void;
  onCreateCard: (chat: Chat) => void;
  onAddToCard: (chat: Chat) => void;
  sessionStatusFor: (chatId: string) => { active: boolean; type: string } | undefined;
}

interface LineageInfo {
  rootKey: string;
  hasLineage: boolean;
}

/** Defense cap against corrupt parent-pointer chains (mirrors the server). */
const MAX_LINEAGE_DEPTH = 50;

function parseMeta(chat: Chat): Record<string, any> {
  try {
    return JSON.parse(chat.metadata || "{}");
  } catch {
    return {};
  }
}

/**
 * Resolve a chat's lineage group key by walking parent pointers through the
 * loaded chats (the API loads a tree's full membership via includeLineage),
 * so multi-level chains — including legacy forkedFrom-only links without a
 * stamped rootChatId — converge on one key. When an ancestor isn't loaded,
 * falls back to the stamped rootChatId or the dangling parent id, which is
 * consistent for every loaded member reaching that same ancestor.
 */
function lineageOf(chat: Chat, byId: Map<string, Chat>): LineageInfo {
  const meta = parseMeta(chat);
  const hasLineage = !!(meta.rootChatId || meta.parentChatId || meta.forkedFrom);
  let current = chat;
  const visited = new Set<string>([chat.id]);
  for (let depth = 0; depth < MAX_LINEAGE_DEPTH; depth++) {
    const m = current === chat ? meta : parseMeta(current);
    const parentId = m.parentChatId || m.forkedFrom;
    if (!parentId || visited.has(parentId)) {
      return { rootKey: m.rootChatId || current.id, hasLineage };
    }
    const parent = byId.get(parentId);
    if (!parent) {
      return { rootKey: m.rootChatId || parentId, hasLineage };
    }
    visited.add(parentId);
    current = parent;
  }
  return { rootKey: current.id, hasLineage };
}

const STATUS_DOT: Record<ChatTreeNode["status"], string> = {
  ongoing: "var(--status-active)",
  waiting: "var(--warning)",
  stopped: "var(--text-muted)",
};

function TreeNodeRow({
  node,
  depth,
  activeChatId,
  onNavigate,
}: {
  node: ChatTreeNode;
  depth: number;
  activeChatId?: string;
  onNavigate: (chatId: string) => void;
}) {
  const isActive = node.chatId === activeChatId;
  const time = new Date(node.updatedAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const folderName = node.folder?.split("/").pop() || node.folder;

  return (
    <>
      <div
        onClick={() => onNavigate(node.chatId)}
        title={node.title || folderName}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 14px 6px",
          paddingLeft: 14 + depth * 14,
          cursor: "pointer",
          background: isActive ? "var(--chatlist-item-active-bg)" : "transparent",
          borderLeft: isActive ? "3px solid var(--chatlist-item-active-border)" : "3px solid transparent",
          borderBottom: "1px solid var(--chatlist-item-border)",
          minWidth: 0,
        }}
      >
        {depth > 0 && (
          <span
            aria-hidden
            style={{
              width: 10,
              height: 1,
              flexShrink: 0,
              background: "var(--chatlist-tree-line)",
            }}
          />
        )}
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
        <ProviderBadge provider={node.provider === "claude-code" ? undefined : node.provider} compact />
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
            fontSize: 13,
            fontWeight: 500,
            color: "var(--chatlist-item-title-text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
            flex: 1,
          }}
        >
          {node.title || folderName}
        </span>
        <span style={{ fontSize: 10, color: "var(--chatlist-item-time-text)", flexShrink: 0, whiteSpace: "nowrap" }}>{time}</span>
      </div>
      {node.children.map((child) => (
        <TreeNodeRow key={child.chatId} node={child} depth={depth + 1} activeChatId={activeChatId} onNavigate={onNavigate} />
      ))}
    </>
  );
}

export default function ChatTreeList({ chats, activeChatId, onChatClick, onDelete, onToggleBookmark, onCreateCard, onAddToCard, sessionStatusFor }: Props) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [trees, setTrees] = useState<Record<string, ChatTreeResponse>>({});
  const [loading, setLoading] = useState<Set<string>>(new Set());

  // Group loaded chats by lineage root, preserving the flat list's order:
  // each group appears at the position of its most recently updated member.
  const rows = useMemo(() => {
    const byId = new Map<string, Chat>(chats.map((c) => [c.id, c]));
    const infoById = new Map<string, LineageInfo>();
    const groupSizes = new Map<string, number>();
    const groupLineage = new Map<string, boolean>();
    for (const chat of chats) {
      const info = lineageOf(chat, byId);
      infoById.set(chat.id, info);
      groupSizes.set(info.rootKey, (groupSizes.get(info.rootKey) || 0) + 1);
      if (info.hasLineage) groupLineage.set(info.rootKey, true);
    }
    const seen = new Set<string>();
    const result: { chat: Chat; rootKey: string; isGroup: boolean }[] = [];
    for (const chat of chats) {
      const { rootKey, hasLineage } = infoById.get(chat.id)!;
      if (seen.has(rootKey)) continue;
      seen.add(rootKey);
      const isGroup = (groupSizes.get(rootKey) || 0) > 1 || hasLineage || groupLineage.get(rootKey) === true;
      result.push({ chat, rootKey, isGroup });
    }
    return result;
  }, [chats]);

  const toggleExpand = useCallback(
    async (rootKey: string, representativeChatId: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(rootKey)) next.delete(rootKey);
        else next.add(rootKey);
        return next;
      });
      if (expanded.has(rootKey) || trees[rootKey]) return;
      setLoading((prev) => new Set(prev).add(rootKey));
      try {
        // Any member id resolves to the same tree — the server walks to the root.
        const tree = await getChatTree(representativeChatId);
        setTrees((prev) => ({ ...prev, [rootKey]: tree }));
      } catch {
        // Chat may have no stored record — collapse back silently.
        setExpanded((prev) => {
          const next = new Set(prev);
          next.delete(rootKey);
          return next;
        });
      } finally {
        setLoading((prev) => {
          const next = new Set(prev);
          next.delete(rootKey);
          return next;
        });
      }
    },
    [expanded, trees],
  );

  const handleNavigate = useCallback((chatId: string) => navigate(`/chat/${chatId}`), [navigate]);

  return (
    <>
      {rows.map(({ chat, rootKey, isGroup }) => {
        if (!isGroup) {
          return (
            <ChatListItem
              key={chat.id}
              chat={chat}
              isActive={chat.id === activeChatId}
              onClick={() => onChatClick(chat)}
              onDelete={() => onDelete(chat)}
              onToggleBookmark={(bookmarked) => onToggleBookmark(chat, bookmarked)}
              onCreateCard={() => onCreateCard(chat)}
              onAddToCard={() => onAddToCard(chat)}
              sessionStatus={sessionStatusFor(chat.id)}
            />
          );
        }

        const isExpanded = expanded.has(rootKey);
        const isLoading = loading.has(rootKey);
        const tree = trees[rootKey];

        return (
          <div key={rootKey} style={{ background: isExpanded ? "var(--chatlist-tree-group-bg)" : undefined }}>
            <div style={{ display: "flex", alignItems: "stretch", minWidth: 0 }}>
              <button
                onClick={() => toggleExpand(rootKey, chat.id)}
                title={isExpanded ? "Collapse chat tree" : "Expand chat tree"}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 2,
                  padding: "0 2px 0 8px",
                  background: "none",
                  border: "none",
                  borderBottom: "1px solid var(--chatlist-item-border)",
                  color: "var(--chatlist-icon)",
                  cursor: "pointer",
                  flexShrink: 0,
                }}
              >
                {isLoading ? (
                  <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} />
                ) : isExpanded ? (
                  <ChevronDown size={13} />
                ) : (
                  <ChevronRight size={13} />
                )}
                <ListTree size={12} />
              </button>
              <div style={{ flex: 1, minWidth: 0 }}>
                <ChatListItem
                  chat={chat}
                  isActive={chat.id === activeChatId}
                  onClick={() => onChatClick(chat)}
                  onDelete={() => onDelete(chat)}
                  onToggleBookmark={(bookmarked) => onToggleBookmark(chat, bookmarked)}
                  onCreateCard={() => onCreateCard(chat)}
                  onAddToCard={() => onAddToCard(chat)}
                  sessionStatus={sessionStatusFor(chat.id)}
                />
              </div>
            </div>
            {isExpanded && tree && (
              <div style={{ borderBottom: "1px solid var(--chatlist-item-border)" }}>
                <TreeNodeRow node={tree.tree} depth={0} activeChatId={activeChatId} onNavigate={handleNavigate} />
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
