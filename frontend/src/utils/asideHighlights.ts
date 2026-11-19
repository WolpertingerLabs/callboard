/**
 * Where an aside's quoted passages are in the main transcript — what the
 * aside highlights paint (hooks/useAsideHighlights.ts).
 *
 * A quote is stored as the message's timestamp, its role and the selected
 * text (shared `AsideQuote`), not as DOM offsets: the transcript is re-rendered
 * from markdown on every load, so offsets would not survive. The passage is
 * found again by text inside the message's `[data-quote-content]` element.
 *
 * Text is matched with all whitespace removed on both sides. A quote is
 * `Selection.toString()` of rendered markdown, which puts `\n\n` between
 * paragraphs and list items where the DOM's text nodes have nothing at all, and
 * normalisation (utils/messageQuotes.ts) collapses blank lines and trims line
 * ends — every one of those is whitespace, and none of them is worth a miss.
 */
import type { AsideQuote } from "shared/types/index.js";
import type { ChatTreeNode, ChatTreeResponse, ParsedMessage } from "../api";
import { ASIDE_ROLE } from "./chatRewrite";
import { hasMarkerSlot } from "./forkMarkers";

/** One aside of the chat on screen, as the highlights and the aside list need it. */
export interface AsideEntry {
  chatId: string;
  title: string;
  status: ChatTreeNode["status"];
  provider: string;
  quotes: readonly AsideQuote[];
  createdAt: string;
  /** For its attention signals (utils/asideAttention.ts). */
  updatedAt: string;
  lastReadAt?: string;
  summon?: ChatTreeNode["summon"];
}

function findNode(node: ChatTreeNode, chatId: string): ChatTreeNode | null {
  if (node.chatId === chatId) return node;
  for (const child of node.children) {
    const hit = findNode(child, chatId);
    if (hit) return hit;
  }
  return null;
}

const NO_ASIDES: readonly AsideEntry[] = Object.freeze([]);

/**
 * The tree's target chat's direct asides, oldest first. Archived ones are
 * left out: archiving an aside is putting it away, and its highlights with it.
 */
export function asidesOf(tree: ChatTreeResponse | null): readonly AsideEntry[] {
  if (!tree) return NO_ASIDES;
  const children = findNode(tree.tree, tree.targetChatId)?.children ?? [];
  const asides = children
    .filter((child) => child.role === ASIDE_ROLE && !child.childArchived)
    .map((child) => ({
      chatId: child.chatId,
      title: child.title || "Aside",
      status: child.status,
      provider: child.provider,
      quotes: child.asideQuotes ?? [],
      createdAt: child.createdAt,
      updatedAt: child.updatedAt,
      ...(child.lastReadAt && { lastReadAt: child.lastReadAt }),
      ...(child.summon && { summon: child.summon }),
    }))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  return asides.length > 0 ? asides : NO_ASIDES;
}

/**
 * The transcript indices a quote may be in: the quotable messages with its
 * timestamp and role. Usually one; an engine turn split into several text
 * blocks shares one timestamp, and the passage may be in any of them.
 */
export function quoteCandidates(messages: readonly ParsedMessage[], quote: Pick<AsideQuote, "timestamp" | "role">): number[] {
  const out: number[] = [];
  messages.forEach((message, index) => {
    if (message.timestamp === quote.timestamp && message.role === quote.role && hasMarkerSlot(message)) out.push(index);
  });
  return out;
}

const WHITESPACE = /\s/;

const strip = (text: string) => text.replace(/\s+/g, "");

/**
 * Which of the whitespace-insensitive matches of `text` in `content` the
 * selection `range` is — 0 for the first. Read when the passage is selected,
 * so a passage that appears more than once in a message is found again in
 * the right place ({@link findQuoteRange}). Counts the matches that start
 * before the selection does.
 */
export function quoteOccurrence(content: Element, range: Range, text: string): number {
  const needle = strip(text);
  if (!needle) return 0;
  const doc = content.ownerDocument;
  const before = doc.createRange();
  before.selectNodeContents(content);
  // Up to where the selection starts, or nothing if it starts before the content.
  if (before.comparePoint(range.startContainer, range.startOffset) >= 0) before.setEnd(range.startContainer, range.startOffset);
  else before.collapse(true);
  const offset = strip(before.toString()).length;
  const haystack = strip(content.textContent ?? "");
  let count = 0;
  for (let at = haystack.indexOf(needle); at >= 0 && at < offset; at = haystack.indexOf(needle, at + 1)) count++;
  return count;
}

/**
 * The range of `text` inside `root`'s text, matched ignoring whitespace, or
 * null when it is not there (the message was edited away, compressed, or the
 * quote predates a re-render that changed its text).
 *
 * `occurrence` picks among repeats (see {@link quoteOccurrence}); a quote
 * without one (made before it was recorded), or one past the last match,
 * gets the first.
 */
export function findQuoteRange(root: Element, text: string, occurrence = 0): Range | null {
  const needle = text.replace(/\s+/g, "");
  if (!needle) return null;
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  // The haystack, whitespace removed, with each kept character's node and offset.
  let haystack = "";
  const nodes: Text[] = [];
  const offsets: number[] = [];
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const value = node.data;
    for (let i = 0; i < value.length; i++) {
      const ch = value[i]!;
      if (WHITESPACE.test(ch)) continue;
      haystack += ch;
      nodes.push(node);
      offsets.push(i);
    }
  }
  const first = haystack.indexOf(needle);
  if (first < 0) return null;
  let at = first;
  for (let n = 0; n < occurrence; n++) {
    const next = haystack.indexOf(needle, at + 1);
    if (next < 0) {
      at = first;
      break;
    }
    at = next;
  }
  const end = at + needle.length - 1;
  const range = doc.createRange();
  range.setStart(nodes[at]!, offsets[at]!);
  range.setEnd(nodes[end]!, offsets[end]! + 1);
  return range;
}

/** What one locating pass found, and what it read to find it. */
export interface LocatedAsides {
  /** Each aside's ranges, by aside id; asides with none are left out. */
  ranges: Map<string, Range[]>;
  /** The quotable-content elements the ranges are in — a change elsewhere cannot move them. */
  contents: Set<Element>;
  /** Some quote was not found: a change anywhere (a bubble rendering late) may bring it. */
  missing: boolean;
}

/**
 * Each aside's ranges in the transcript rendered under `container`. Quotes
 * that cannot be found are skipped. The quotable-content elements are indexed
 * by message once per pass, not looked up per quote.
 */
export function locateAsides(container: Element, messages: readonly ParsedMessage[], asides: readonly AsideEntry[]): LocatedAsides {
  const contentByIndex = new Map<number, Element>();
  for (const wrapper of container.querySelectorAll("[data-message-index]")) {
    const content = wrapper.querySelector("[data-quote-content]");
    if (content) contentByIndex.set(Number(wrapper.getAttribute("data-message-index")), content);
  }
  const ranges = new Map<string, Range[]>();
  const contents = new Set<Element>();
  let missing = false;
  for (const aside of asides) {
    const found: Range[] = [];
    for (const quote of aside.quotes) {
      let hit = false;
      for (const index of quoteCandidates(messages, quote)) {
        const content = contentByIndex.get(index);
        const range = content && findQuoteRange(content, quote.text, quote.occurrence);
        if (range) {
          found.push(range);
          contents.add(content);
          hit = true;
          break;
        }
      }
      if (!hit) missing = true;
    }
    if (found.length > 0) ranges.set(aside.chatId, found);
  }
  return { ranges, contents, missing };
}

/** {@link locateAsides}' ranges alone. */
export function locateAsideRanges(container: Element, messages: readonly ParsedMessage[], asides: readonly AsideEntry[]): Map<string, Range[]> {
  return locateAsides(container, messages, asides).ranges;
}
