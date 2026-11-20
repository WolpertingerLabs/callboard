/**
 * Which nodes of a fetched chat tree the sidebar actually renders.
 *
 * `TreeNodeRow` used to decide this inline while recursing. It lives here so
 * the three things that depend on it agree: what is drawn, whether a node gets
 * a collapse toggle (it has something to hide), and what a collapsed node's
 * working count covers (what the collapse hid).
 */

import type { ChatTreeNode } from "../api";
import { treeContains } from "./childArchive";
import { ASIDE_ROLE } from "./chatRewrite";
import { nodeSignals, sumAttention, type AsideAttention, type AsideSignals } from "./asideAttention";

export interface TreeVisibility {
  /** Whether archived children render at all (`Props.showArchivedChildren`). */
  showArchived: boolean;
  activeChatId?: string;
  /** Asides fold into their parent's count (`Props.foldAsides`; off while searching). */
  foldAsides: boolean;
}

/**
 * An archived child the list is not showing. It takes its whole subtree with
 * it — except when it holds the open chat: archiving the chat you are reading
 * must not take its node out from under you.
 */
export function isHiddenArchivedChild(child: ChatTreeNode, opts: TreeVisibility): boolean {
  return child.childArchived === true && !opts.showArchived && !treeContains(child, opts.activeChatId);
}

/**
 * An aside folded into its parent's row (see `Row.asideCount`), unless it has
 * children of its own to hang off it, or is the chat open. "Of its own" means
 * visible: an archived child the list is not showing does not count.
 */
export function isFoldedAside(child: ChatTreeNode, opts: TreeVisibility): boolean {
  return (
    opts.foldAsides && child.role === ASIDE_ROLE && !child.children.some((c) => opts.showArchived || !c.childArchived) && child.chatId !== opts.activeChatId
  );
}

/** The asides folded into `node`'s row — what its `AsideCount` counts. */
export function foldedAsideChildren(node: ChatTreeNode, opts: TreeVisibility): ChatTreeNode[] {
  return node.children.filter((child) => isFoldedAside(child, opts) && (opts.showArchived || !child.childArchived));
}

/**
 * The children `node` renders as rows of their own.
 *
 * `underArchived` is whether `node` itself is, or sits under, an archived
 * child. Then only a child holding the open chat survives (unless archived
 * children are shown) — its node is shown for the same reason as above, and
 * its siblings stay hidden as they would be anyway.
 */
export function visibleChildren(node: ChatTreeNode, underArchived: boolean, opts: TreeVisibility): ChatTreeNode[] {
  return node.children.filter(
    (child) =>
      (opts.showArchived || !underArchived || treeContains(child, opts.activeChatId)) && !isFoldedAside(child, opts) && !isHiddenArchivedChild(child, opts),
  );
}

/**
 * Whether a node's chat is working: the live session registry says so (it
 * moves the moment a session starts, without waiting for the tree to be
 * refetched), OR the fetched snapshot does. Either, not one over the other: a
 * native sub-agent's node is never in the live registry, so the snapshot's
 * `ongoing` is the only word on it.
 */
export function nodeIsRunning(node: ChatTreeNode, isRunning?: (chatId: string) => boolean): boolean {
  return !!isRunning?.(node.chatId) || node.status === "ongoing";
}

/**
 * The signals of everything collapsing `node` hides: every rendered
 * descendant at any depth, plus the asides folded into those descendants'
 * rows. Not `node` itself, and not `node`'s own folded asides — its
 * `AsideCount` stays on screen when it is collapsed and already carries them.
 * Archived subtrees the list is not showing are not counted, as they are not
 * drawn.
 */
export function hiddenBelow(node: ChatTreeNode, underArchived: boolean, opts: TreeVisibility, isRunning?: (chatId: string) => boolean): AsideSignals[] {
  const out: AsideSignals[] = [];
  const walk = (parent: ChatTreeNode, parentUnderArchived: boolean) => {
    for (const child of visibleChildren(parent, parentUnderArchived, opts)) {
      out.push(nodeSignals(child, nodeIsRunning(child, isRunning)));
      for (const aside of foldedAsideChildren(child, opts)) out.push(nodeSignals(aside, nodeIsRunning(aside, isRunning)));
      walk(child, parentUnderArchived || child.childArchived === true);
    }
  };
  walk(node, underArchived);
  return out;
}

/** What a collapsed `node` hides that needs the user — see {@link hiddenBelow}. */
export function attentionBelow(node: ChatTreeNode, underArchived: boolean, opts: TreeVisibility, isRunning?: (chatId: string) => boolean): AsideAttention {
  return sumAttention(hiddenBelow(node, underArchived, opts, isRunning));
}

/** Working chats among what collapsing `node` hides. */
export function countRunningBelow(node: ChatTreeNode, underArchived: boolean, opts: TreeVisibility, isRunning?: (chatId: string) => boolean): number {
  return attentionBelow(node, underArchived, opts, isRunning).running;
}
