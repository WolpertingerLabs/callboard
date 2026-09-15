import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, ChevronRight, ListTree, Loader2 } from "lucide-react";
import { getChatTree, type Chat, type ChatTreeNode, type ChatTreeResponse } from "../api";
import ChatListItem, { type ChatCardMenu } from "./ChatListItem";
import ChatSectionHeader from "./ChatSectionHeader";
import ProviderBadge from "./ProviderBadge";
import { isChatPinned, sectionByPinned } from "../utils/chatSections";
import { useChatSectionExpansion } from "../hooks/useChatSectionExpansion";

/**
 * The sidebar chat list.
 *
 * Chats are grouped by their parentage-tree root (metadata `rootChatId`,
 * aliasing legacy `parentChatId`/`forkedFrom` pointers). A chat without any
 * lineage — the common case — renders as a plain `ChatListItem` row, with no
 * chevron and nothing to expand, so a list of unrelated chats looks exactly
 * like an ungrouped one. Groups render their lineage ROOT **where that chat is
 * loaded** — then it is also the chat that appears at depth 0 when the group is
 * expanded — as the header row with a chevron, and fall back to the most
 * recently updated member when it is not (see `buildRows`, which owns both the
 * rule and the fallback; in the fallback the header is a child and the tree's
 * depth-0 node is some chat this list does not hold). Expanding fetches the
 * authoritative full tree from GET /api/chats/:id/tree (which includes members
 * outside the currently loaded page) and renders it depth-indented.
 *
 * The header row is the root and not the group's most recently updated member
 * because the row is a link as much as a label: clicking it opens the chat it
 * names. Fronting the busiest member meant a thread's row dropped you into
 * whichever subagent happened to have run last, several levels down a tree the
 * user had not asked to enter. One chat fronts the row, and it labels the row
 * and answers its click alike — a row whose title says one chat and whose click
 * opens another is lying about where it goes.
 *
 * A fetched tree is a snapshot: a chat spawned into an already-expanded group
 * (and every status change inside it) lands in the refreshed `chats` prop but
 * not in the fetched tree. `refreshToken` — bumped by the parent on every
 * chat-list refresh — is the signal to refetch the expanded groups so the
 * sidebar doesn't need a page reload to show them.
 */

interface Props {
  chats: Chat[];
  /** Bumped whenever the parent replaces the chat list; invalidates fetched trees. */
  refreshToken: number;
  activeChatId?: string;
  onChatClick: (chat: Chat) => void;
  onDelete: (chat: Chat) => void;
  onToggleBookmark: (chat: Chat, bookmarked: boolean) => void;
  /**
   * Pin or unpin, which moves a row between this list's two sections.
   *
   * Takes a LIST of chats because a row is not always one chat. Pinning a
   * group pins the chat that fronts it; unpinning one has to clear the pin
   * wherever in the group it was set, or the menu entry cannot undo the state
   * the row is displaying. For a lone chat both are the single-element case.
   *
   * The verdict itself is NOT a prop: unlike the dim, which needs the
   * separately fetched card rollup, the pin is on the chats' own metadata, so
   * there is no loading window in which reading it early would file the list
   * wrongly and then move every row when a second request lands.
   */
  onTogglePin: (chats: Chat[], pinned: boolean) => void;
  /** Ask the list to open its title editor for this chat. */
  onEditTitle?: (chat: Chat) => void;
  /** Card (ticket) actions for a row's kebab menu. */
  cardMenuFor: (chat: Chat) => ChatCardMenu;
  sessionStatusFor: (chatId: string) => { active: boolean; type: string } | undefined;
  /** Whether this row's card is archived — closed or hidden. A row on no card
   * is not archived; see `utils/chatDimming`. */
  isDimmed?: (chat: Chat) => boolean;
  /**
   * Multi-select props for one row, or undefined for a list that offers no
   * selection at all — in which case every row renders exactly as it did
   * before multi-select existed.
   *
   * A function of the chat rather than a set of ids: the list owns the
   * selection, its scope and its anchor, and the row needs none of that. See
   * `selectionProps` in ChatList.
   */
  selectionFor?: (chat: Chat) => RowSelection;
}

/** What one row is told about the selection it is part of. */
export interface RowSelection {
  selectionMode: boolean;
  selected: boolean;
  selectable: boolean;
  onToggleSelect: (e: React.MouseEvent) => void;
  onLongPress?: () => void;
}

interface LineageInfo {
  rootKey: string;
  hasLineage: boolean;
}

/**
 * The live-work signals a row reports, rolled up over the group it stands for.
 *
 * IDENTITY is one chat's — the row's title, preview, click target, kebab and
 * pin all answer to `Row.chat`. ACTIVITY is the tree's, and that split is the
 * whole point of this type: a group row fronted by its root reports the root's
 * signals, and in Callboard's spawn model the root is the idle parent by
 * construction. Every signal here is one that only ever fires on a member
 * *other* than the root — a subagent calling `summon_user`, a job step waiting
 * on an approval, a child that has written output you have not read — so a
 * per-front-chat reading suppresses exactly the rows that need you, on exactly
 * the rows where a tree is doing work.
 *
 * Rolled up over the LOADED members, the same qualifier `pinnedMembers`
 * carries and for the same reason: this is a verdict over the chats the list
 * holds, not over the group as the server knows it.
 */
export interface RowActivity {
  /** The latest `updated_at` in the group — what the row's timestamp shows. */
  updatedAt: string;
  /** Any member with output past its OWN read mark; see `buildRows`. */
  hasUnread: boolean;
  summon?: { message: string; urgency: string; createdAt: string };
  /**
   * The member carrying `summon`. Dismissing writes to that chat, which on a
   * group row is not the chat the row is labelled with.
   */
  summonChatId?: string;
  jobAwaitingApproval: boolean;
  /**
   * Run and step of the member awaiting approval, so the "needs you" pill can
   * name the step that is actually waiting. Set only alongside
   * `jobAwaitingApproval`; a row's own job badge is otherwise its own.
   */
  jobRunId?: string;
  jobStepId?: string;
  chatStatus?: string;
  chatStatusEmoji?: string;
}

/** One visible entry: a lone chat, or a lineage group fronted by `chat`. */
export interface Row {
  chat: Chat;
  rootKey: string;
  isGroup: boolean;
  /**
   * Every chat from the `chats` prop filed under this row, in the order the
   * prop had them — i.e. most recently updated first. `chat` is always one of
   * them (see the fronting expression in `buildRows`), which is what lets the
   * row read the group's activity and its own "you are here" from one array.
   */
  members: Chat[];
  /** What the row reports about live work anywhere in `members`. */
  activity: RowActivity;
  /**
   * Chats from the `chats` prop this row stands for — 1 for a lone chat, the
   * group's size for a group. The section headers count chats, not rows, so a
   * group has to carry its own weight to the tally.
   *
   * Deliberately *not* "chats visible under this row": expanding a group
   * renders `trees[rootKey]`, the server's authoritative tree, which no client
   * filter has been applied to — expand a group under "Show triggered chats:
   * off" and more rows can appear than this counted. Following that would make
   * the header's number jump on every expand, and jump to a figure the section
   * above it does not share. The count answers "how many of the chats this
   * list loaded are filed here", which is stable.
   */
  size: number;
  /**
   * The loaded chats in this row's group that carry the pin — `[chat]` or `[]`
   * for a lone row, and for a group row every pinned member, not just the one
   * fronting it.
   *
   * **A group is pinned if ANY member is.** The alternative — only the header
   * row's own pin counts — silently breaks the feature under either fronting
   * rule. Pin a subagent's chat, the one you actually want to keep an eye on:
   * its group is fronted by the parent thread it was spawned from, so under a
   * header-only rule the pin has no effect at all — no row displays it and no
   * menu entry can clear it.
   *
   * Fronting by the root changes the SHAPE of that failure rather than its
   * size. The two rules break on different sets, and neither contains the
   * other: the old one (busiest member fronts) breaks whenever the pinned
   * member is not the most recently updated, so pinning a tree's quiet root
   * broke it and pinning its busiest child happened to work; the new one
   * breaks whenever the pinned member is not the root, which is the reverse
   * pair. What the root does buy is that it does not move around the way "most
   * recently updated member" did, so the failure would be stable rather than
   * intermittent — and (when the root is loaded, which is when it fronts at
   * all) a pin set on a non-root member is never the header's own. Pinning a
   * child therefore floats its whole group, which is the honest reading of a
   * list that renders one row per tree: that row IS the tree, and there is no
   * other row to move.
   *
   * "Loaded" is the real qualifier: this is a verdict over the rows the list
   * currently HOLDS, not over the group as the server knows it. Mostly that is
   * the same set — the list always requests `includeLineage`, so every member
   * of a group whose row is on the page comes back with it, and `includePinned`
   * brings back pinned chats from outside the page window on top of that.
   *
   * The exception, left unfixed on purpose because reaching it means having
   * pinned a triggered chat: `includeLineage`'s append re-applies
   * `excludeTriggered` and the bookmark filter, so a pinned member those hide
   * is not loaded and does not count here. The group then reads unpinned, Pin
   * adds a second pin to the header row, and a later Unpin clears only what it
   * can see. Turning "Show triggered chats" on makes the hidden pin visible
   * and clearable again.
   */
  pinnedMembers: Chat[];
}

/** Shared empty bucket, so an unpinned row allocates nothing per render. */
const NO_PINNED_MEMBERS: Chat[] = [];

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

/**
 * The visible rows of a chat list, in the order they render.
 *
 * Chats are grouped by lineage root, and each group appears at the position of
 * its most recently updated member — so this is the server's recency order
 * with the members of a tree folded into the row that fronts it.
 *
 * A group's POSITION and its IDENTITY answer to different members, and the
 * split is deliberate:
 *
 * - **Position** is the most recently updated member's, unchanged. A tree the
 *   user is working in stays near the top of the sidebar however deep in it
 *   the work is happening. Ordering by root recency instead would sink an
 *   actively worked thread to wherever its opening message left it.
 * - **Identity** — `row.chat`, which supplies the row's title, preview, kebab
 *   and click target — is the lineage ROOT, the same chat that renders at
 *   depth 0 when the group is expanded. A thread's row opens the thread.
 * - **Activity** — the timestamp and every live-work signal on the row — is
 *   the whole group's, rolled up in `row.activity`. Identity had to move to
 *   the root for the row to stop lying about where it goes; activity had to
 *   stay with the tree, because the root is the one member that by
 *   construction is never the one doing the work. See {@link RowActivity}.
 *
 * The fallback exists because `rootKey` is not always a chat this list holds:
 * `lineageOf` keys a group by a dangling parent id or a stamped `rootChatId`
 * whenever the ancestor chain leaves the loaded page (see there). Those keys
 * group members correctly but name no loaded chat, and a row has to be some
 * chat the list actually has — so when the root is not loaded, the most
 * recently updated member fronts the row, which is what every group did before
 * roots fronted anything.
 *
 * Exported because ChatList needs the same order for its shift+click ranges,
 * and "the same order" has to mean the same *function* over the same array,
 * not a second derivation that agrees today. A range read off a parallel
 * ordering eventually selects rows the user never saw, and that drift stays
 * invisible until someone changes how groups are folded. The one call in this
 * module is memoised on `chats`, and so is the one in ChatList — both from the
 * same `filteredChats` array.
 */
export function buildRows(chats: Chat[]): Row[] {
  const byId = new Map<string, Chat>(chats.map((c) => [c.id, c]));
  const infoById = new Map<string, LineageInfo>();
  // The group's membership, in the prop's order. Also the row's size: a
  // separate counter alongside this list could only ever disagree with it.
  const groupMembers = new Map<string, Chat[]>();
  const groupLineage = new Map<string, boolean>();
  // Collected per group, not per chat: a pin set on any member files the
  // whole group — see Row.pinnedMembers for why the header row's own flag
  // is not enough.
  const groupPinned = new Map<string, Chat[]>();
  for (const chat of chats) {
    const info = lineageOf(chat, byId);
    infoById.set(chat.id, info);
    const members = groupMembers.get(info.rootKey);
    if (members) members.push(chat);
    else groupMembers.set(info.rootKey, [chat]);
    if (info.hasLineage) groupLineage.set(info.rootKey, true);
    if (isChatPinned(chat)) {
      const pinned = groupPinned.get(info.rootKey);
      if (pinned) pinned.push(chat);
      else groupPinned.set(info.rootKey, [chat]);
    }
  }
  const seen = new Set<string>();
  const result: Row[] = [];
  for (const chat of chats) {
    const { rootKey, hasLineage } = infoById.get(chat.id)!;
    if (seen.has(rootKey)) continue;
    seen.add(rootKey);
    // Always set: this row's own chat filed itself into the bucket above.
    const members = groupMembers.get(rootKey)!;
    const size = members.length;
    const isGroup = size > 1 || hasLineage || groupLineage.get(rootKey) === true;
    // `chat` — the first member seen, i.e. the most recently updated one — has
    // already fixed this row's position by being the iteration that created it.
    // Which chat FRONTS it is a separate question, answered by the root when
    // the root is loaded and by `chat` when it is not.
    //
    // The lineage check is not redundant with the id lookup: a chat whose id
    // happens to equal a group key can be filed in a different group than the
    // one it keys (a parent-pointer cycle resolves that way), and fronting a
    // row with a chat that is not one of its members would double-count it
    // against the row ChatList's selection expects to find it in.
    const root = byId.get(rootKey);
    const front = isGroup && root && infoById.get(root.id)!.rootKey === rootKey ? root : chat;
    result.push({
      chat: front,
      rootKey,
      isGroup,
      members,
      activity: rollUpActivity(members),
      size,
      pinnedMembers: groupPinned.get(rootKey) ?? NO_PINNED_MEMBERS,
    });
  }
  return result;
}

/**
 * The group's live work, as one row's worth of signals.
 *
 * Every rule here is "the loudest member wins", never "the front chat's", and
 * for a one-member row each reduces to exactly the reading `ChatListItem` does
 * from a chat's own metadata — which is what lets a lone row and a group row
 * share one code path in the component. See {@link RowActivity}.
 *
 * Ties go to the earlier member, which is the more recently updated one:
 * `members` is in the server's recency order, and equal `updated_at` values
 * are ordinary rather than a corner case — a parent and the child it just
 * spawned are routinely written in the same second.
 */
function rollUpActivity(members: Chat[]): RowActivity {
  const at = (iso: string) => new Date(iso).getTime();
  let updatedAt = members[0].updated_at;
  let hasUnread = false;
  let summon: RowActivity["summon"];
  let summonChatId: string | undefined;
  let summonUrgent = false;
  let summonAt = -Infinity;
  let jobAwaitingApproval = false;
  let jobRunId: string | undefined;
  let jobStepId: string | undefined;
  let chatStatus: string | undefined;
  let chatStatusEmoji: string | undefined;
  let chatStatusAt = -Infinity;

  for (const member of members) {
    const meta = parseMeta(member);
    const memberAt = at(member.updated_at);
    if (memberAt > at(updatedAt)) updatedAt = member.updated_at;
    // Each member against its OWN read mark: one member you have read does not
    // clear the dot for a sibling you have not, and a member with no mark at
    // all is not unread — the same rule the row applies to a lone chat.
    if (meta.lastReadAt && memberAt > at(meta.lastReadAt)) hasUnread = true;
    if (meta.summon) {
      // Urgent outranks recent — the urgent one is the one that pulses — and
      // urgency is binary here, exactly as the badge reads it.
      const urgent = meta.summon.urgency === "urgent";
      const createdAt = at(meta.summon.createdAt);
      if (!summon || (urgent && !summonUrgent) || (urgent === summonUrgent && createdAt > summonAt)) {
        summon = meta.summon;
        summonChatId = member.id;
        summonUrgent = urgent;
        summonAt = createdAt;
      }
    }
    // ANY member, and not noisy: `jobRunNeedsYou` is set on the run's
    // representative row only (see ChatListItem), so at most one member of a
    // group carries it per run.
    if (!jobAwaitingApproval && meta.jobRunId && meta.jobRunNeedsYou === true) {
      jobAwaitingApproval = true;
      jobRunId = meta.jobRunId;
      jobStepId = meta.jobStepId || undefined;
    }
    if (meta.chatStatus && memberAt > chatStatusAt) {
      chatStatus = meta.chatStatus;
      chatStatusEmoji = meta.chatStatusEmoji || undefined;
      chatStatusAt = memberAt;
    }
  }

  return { updatedAt, hasUnread, summon, summonChatId, jobAwaitingApproval, jobRunId, jobStepId, chatStatus, chatStatusEmoji };
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
          title={`Status: ${node.nativeAgent?.lifecycle ?? node.status}`}
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
          {node.nativeAgent && <small title={node.nativeAgent.controlNote}> · {node.nativeAgent.lifecycle} · read-only</small>}
        </span>
        <span style={{ fontSize: 10, color: "var(--chatlist-item-time-text)", flexShrink: 0, whiteSpace: "nowrap" }}>{time}</span>
      </div>
      {node.children.map((child) => (
        <TreeNodeRow key={child.chatId} node={child} depth={depth + 1} activeChatId={activeChatId} onNavigate={onNavigate} />
      ))}
    </>
  );
}

export default function ChatTreeList({
  chats,
  refreshToken,
  activeChatId,
  onChatClick,
  onDelete,
  onToggleBookmark,
  onTogglePin,
  onEditTitle,
  cardMenuFor,
  sessionStatusFor,
  isDimmed,
  selectionFor,
}: Props) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [trees, setTrees] = useState<Record<string, ChatTreeResponse>>({});
  const [loading, setLoading] = useState<Set<string>>(new Set());

  // Group loaded chats by lineage root, preserving the server's recency order:
  // each group appears at the position of its most recently updated member,
  // fronted by its root where that chat is loaded. See `buildRows`.
  const rows = useMemo(() => buildRows(chats), [chats]);

  // Read current expansion/rows from the refresh effect without making it a
  // dependency — the effect must fire on refreshes, not on every expand click.
  const expandedRef = useRef(expanded);
  const rowsRef = useRef(rows);
  // Declared before the refresh effect so the refs are current by the time it
  // reads them in the same commit.
  useEffect(() => {
    expandedRef.current = expanded;
    rowsRef.current = rows;
  });

  // The chat list refreshed: every cached tree is now potentially stale.
  // Refetch the expanded ones in place (no spinner — the rows stay put and
  // swap content), and drop the collapsed ones so re-expanding refetches
  // instead of flashing a snapshot from minutes ago.
  useEffect(() => {
    if (refreshToken === 0) return; // initial render — nothing fetched yet
    const expandedNow = expandedRef.current;
    setTrees((prev) => {
      const kept: Record<string, ChatTreeResponse> = {};
      let dropped = false;
      for (const [rootKey, tree] of Object.entries(prev)) {
        if (expandedNow.has(rootKey)) kept[rootKey] = tree;
        else dropped = true;
      }
      return dropped ? kept : prev;
    });
    if (expandedNow.size === 0) return;

    let cancelled = false;
    const representativeOf = new Map(rowsRef.current.map((row) => [row.rootKey, row.chat.id]));
    for (const rootKey of expandedNow) {
      const representativeChatId = representativeOf.get(rootKey);
      if (!representativeChatId) continue; // group scrolled out of the loaded window
      getChatTree(representativeChatId)
        .then((tree) => {
          if (!cancelled) setTrees((prev) => ({ ...prev, [rootKey]: tree }));
        })
        .catch(() => {
          // Transient failure — the next refresh retries; keep showing the old tree.
        });
    }
    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

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

  // Each group is filed by its header row's chat — the one actually rendered
  // and labelled — so a group whose members straddle both buckets still
  // appears exactly once. Cheap enough to redo per render; `rows` above is the
  // memoized part.
  const sections = sectionByPinned(
    rows,
    (row) => row.pinnedMembers.length > 0,
    (row) => row.size,
  );

  /** Collapse state for those headers, persisted via localStorage. */
  const sectionExpansion = useChatSectionExpansion();

  const renderRow = ({ chat, rootKey, isGroup, members, activity, pinnedMembers }: Row) => {
    /**
     * Pin the chat this row is labelled with; unpin every member holding a pin.
     *
     * Deliberately identical in both branches below. A lone row is the
     * single-element case of the same rule — `pinnedMembers` is `[chat]` when
     * it is pinned — so there is no second semantic to keep in step, which is
     * exactly how the group branch came to be missing this handler entirely.
     */
    const pinProps = {
      pinned: pinnedMembers.length > 0,
      onTogglePin: (next: boolean) => onTogglePin(next ? [chat] : pinnedMembers, next),
    };

    if (!isGroup) {
      // No `activity`: a lone row stands for one chat, so the roll-up would be
      // that chat's own metadata read back to it. The component's own reading
      // is the definition the roll-up matches, not a second one to keep in
      // step — see `rollUpActivity`.
      return (
        <ChatListItem
          key={chat.id}
          chat={chat}
          isActive={chat.id === activeChatId}
          onClick={() => onChatClick(chat)}
          onDelete={() => onDelete(chat)}
          onToggleBookmark={(bookmarked) => onToggleBookmark(chat, bookmarked)}
          {...pinProps}
          onEditTitle={onEditTitle && (() => onEditTitle(chat))}
          cardMenu={cardMenuFor(chat)}
          sessionStatus={sessionStatusFor(chat.id)}
          dimmed={isDimmed?.(chat)}
          {...selectionFor?.(chat)}
        />
      );
    }

    const isExpanded = expanded.has(rootKey);
    const isLoading = loading.has(rootKey);
    const tree = trees[rootKey];
    /**
     * Active if a session is live ANYWHERE in the group, reported as the first
     * such member's — the badge says web-or-cli, and one row cannot say two
     * things. The root is the member least likely to be running, so reading
     * only the front chat would leave a tree with three agents working in it
     * looking idle. Falls back to the front chat's own, which is what carries
     * the *inactive* status through for the ordinary one-member case.
     */
    const groupSessionStatus = members.map((member) => sessionStatusFor(member.id)).find((status) => status?.active) ?? sessionStatusFor(chat.id);

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
              // The chat being read is somewhere in this tree, and this row is
              // the only row the tree has — highlighting only when the ROOT is
              // open would leave the sidebar with nothing marked at all for
              // every chat one level down. (`faded` keys off this too, so a
              // group on an archived card stops fading the moment you open any
              // member of it.)
              isActive={members.some((member) => member.id === activeChatId)}
              onClick={() => onChatClick(chat)}
              onDelete={() => onDelete(chat)}
              onToggleBookmark={(bookmarked) => onToggleBookmark(chat, bookmarked)}
              {...pinProps}
              onEditTitle={onEditTitle && (() => onEditTitle(chat))}
              cardMenu={cardMenuFor(chat)}
              sessionStatus={groupSessionStatus}
              // Identity above is the root's; the live-work signals are the
              // whole group's. See `RowActivity`.
              activity={activity}
              dimmed={isDimmed?.(chat)}
              {...selectionFor?.(chat)}
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
  };

  // `null` is the ordinary case — nothing pinned — and renders the flat list
  // with no headers at all, byte for byte what this component rendered before
  // pinning existed.
  if (sections) {
    return (
      <>
        {sections.map((section) => (
          <Fragment key={section.key}>
            <ChatSectionHeader
              label={section.label}
              count={section.count}
              expanded={sectionExpansion.isExpanded(section.key)}
              onToggle={() => sectionExpansion.toggle(section.key)}
            />
            {sectionExpansion.isExpanded(section.key) && section.items.map(renderRow)}
          </Fragment>
        ))}
      </>
    );
  }

  return <>{rows.map(renderRow)}</>;
}
