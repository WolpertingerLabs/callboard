/**
 * Everything a card face knows that isn't markup.
 *
 * A tile and a list row show the same facts about the same card and answer the
 * same gestures; only their layout differs. This module is the shared half, so
 * the two faces cannot drift on what "Active" means or on when a click counts
 * as a selection — reimplementing the activation contract per face is exactly
 * where the bug would be.
 */

import { useState, useEffect } from "react";
import type { CardSummary, CardRollupState } from "../../api";
import { needsYouLabel, activeLabel } from "./pendingLabels";
import { cardFolders, type CardFolder } from "../../utils/cardFolders";
import { useSelectionActivation, type UseSelectionActivationResult } from "../../hooks/useSelectionActivation";

/** Module-private: `statusLine` below is the only reader, and the only one there has ever been. */
const ROLLUP_LABELS: Record<CardRollupState, string> = {
  needs_you: "Needs you",
  job_running: "Job running",
  active: "Active",
  idle: "Idle",
};

/** Rollup-state colors — themable via the --board-* section of index.css. */
export const ROLLUP_COLORS: Record<CardRollupState, string> = {
  needs_you: "var(--board-rollup-needs-you)",
  job_running: "var(--board-rollup-job-running)",
  active: "var(--board-rollup-active)",
  idle: "var(--board-rollup-idle)",
};

/**
 * `Date.now()`, re-read once a second, but only for cards that have something
 * counting down. The gate is a real perf guard, not a micro-optimisation: it
 * is what keeps a board of idle cards re-rendering no more than it did before
 * countdowns existed, and it matters more in list mode where more faces are on
 * screen at once.
 */
export function useCardCountdown(card: CardSummary): number {
  const hasCountdown =
    card.lifecycle !== "closed" &&
    (card.memberChats.some((c) => c.activity?.expiresAt !== undefined) ||
      card.memberRuns.some((r) => r.nextWakeAt && (r.status === "sleeping" || r.status === "waiting_event")));

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasCountdown) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasCountdown]);

  return now;
}

/** The one-line state a card face leads with. */
export function statusLine(card: CardSummary, now: number): string {
  // `closed` is the wire value; "Archived" is what it reads as.
  if (card.lifecycle === "closed") return "Archived";
  if (card.rollup === "needs_you") return needsYouLabel(card);
  if (card.rollup === "idle") return ROLLUP_LABELS.idle;
  return activeLabel(card, now);
}

/**
 * Live folders only. `cardFolders` already distinguishes the two states, and
 * the distinction is the useful half: "someone is blocked on you in that
 * worktree" is a different fact from "something is running there".
 */
export const FOLDER_LIVE_COLORS: Record<"waiting" | "ongoing", string> = {
  waiting: "var(--board-rollup-needs-you)",
  ongoing: "var(--board-rollup-active)",
};

export interface CardFolderSummary {
  /**
   * Ordered root-first; empty when paths are off, or the card's member rows
   * are gone. On an archived card every entry's `live` is already stripped, so
   * no consumer has to remember to ask about the lifecycle a second time.
   */
  folders: CardFolder[];
  /** Distinct folders OTHER than the root's — zero on 97% of cards, where nothing renders. */
  extraCount: number;
  /**
   * The most urgent live state among those other folders; undefined when none
   * of them is live.
   *
   * The state of the OTHER folders, deliberately, not the card's rollup. A
   * card whose root needs you but whose second folder is merely ticking over
   * would otherwise paint its `+N` in "needs you" — a glyph claiming someone
   * is blocked over there when nobody is, which is the one thing this glyph
   * exists to say.
   */
  extrasLive?: "waiting" | "ongoing";
}

/**
 * The collapsed folder story both faces tell: one path, plus a `+N` that is
 * coloured when the action is somewhere other than the path on show.
 *
 * That colour rule is the whole reason this is shared rather than inlined
 * twice. It is the one glyph that says "the work has moved", which is the
 * failure mode of showing the root path alone — a tile and a row disagreeing
 * about when it lights up would make the board lie on one of them.
 */
export function cardFolderSummary(card: CardSummary, showPath: boolean): CardFolderSummary {
  // Computing it is one pass over an array the face already holds, but there
  // is no reason to make that pass for a board with paths switched off.
  const all = showPath ? cardFolders(card) : [];
  // An archived card has no live anything, whatever its member rows still say —
  // the rule `statusLine` applies to the rollup, applied to the folders.
  //
  // Stripped off the folders themselves rather than gated at each reader,
  // because there is more than one reader: the `+N` on the collapsed face and
  // the dot and accessible name of every entry in the row's expansion. Gating
  // only the first left a card closed while a member session was blocked
  // showing `+1` in meta grey and, one line below, an amber dot announcing
  // "needs you". One home for the rule, so the two cannot disagree.
  const folders: CardFolder[] = all.some((f) => f.live) && card.lifecycle === "closed" ? all.map(({ live: _live, ...rest }) => rest) : all;
  // `cardFolders` already ranks waiting above ongoing, so the first live one
  // among the extras is the most urgent of them.
  const extrasLive = folders.slice(1).find((f) => f.live)?.live;
  return {
    folders,
    extraCount: Math.max(0, folders.length - 1),
    ...(extrasLive && { extrasLive }),
  };
}

export interface UseCardActivationOptions {
  card: CardSummary;
  /** Every field below is optional: with none passed the face behaves exactly as it did before multi-select existed. */
  selectionMode?: boolean;
  selectable?: boolean;
  onClick: () => void;
  /** Receives the event so the board can read shift/meta/ctrl for range and toggle. */
  onToggleSelect?: (e: React.MouseEvent) => void;
  onLongPress?: () => void;
}

export type UseCardActivationResult = UseSelectionActivationResult;

/**
 * The whole click/press/select contract of a card face, independent of its
 * layout — a card-shaped front door onto `useSelectionActivation`.
 *
 * The rules themselves live in that hook, and deliberately not here: the
 * sidebar's chat list answers the same gestures over rows that are not cards,
 * and the one thing this signature adds is where the checkbox's accessible
 * name comes from. Keeping the wrapper means `CardTile` and `CardRow` — and
 * the parity suite that holds them to one contract — see exactly the API they
 * always did.
 */
export function useCardActivation({ card, ...rest }: UseCardActivationOptions): UseCardActivationResult {
  return useSelectionActivation({ label: card.title, ...rest });
}
