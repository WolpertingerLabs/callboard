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
