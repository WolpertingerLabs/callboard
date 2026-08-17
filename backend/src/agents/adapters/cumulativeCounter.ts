/**
 * One **cumulative-for-the-session** counter, differenced into per-turn steps.
 *
 * Several engines report running totals rather than per-response figures — a
 * turn's `usage` says what the whole session has spent so far. A debug panel
 * row is a *response*, so the row's number is the step since the previous turn,
 * and pasting the running total onto every row would make the last turn of a
 * chat claim the whole chat's usage.
 *
 * Three cases the naive `total - previous` gets wrong, all handled here:
 *
 * - **First report.** There is no previous total, so the total *is* the step so
 *   far. (Within one transcript that is turn 0; a resumed session whose earlier
 *   turns live in another file folds those into its first row, which is the best
 *   available and is not new behaviour.)
 * - **Counter reset.** A resumed session whose runtime restarted its counters
 *   reports a total *below* the previous one. That is a fresh baseline, not a
 *   negative charge.
 * - **A gap.** The counter is optional on some engines, so a turn can report the
 *   totals it has and omit this one. The next turn that *does* report it has a
 *   step spanning two or more turns, and attributing that to the later turn
 *   alone is exactly the plausible-looking wrong number this whole area exists
 *   to avoid — turn 1 reports 900, turn 2 omits, turn 3 reports 3000, and the
 *   row says 2100 for a response that read some unknown part of it.
 *
 *   {@link step} returns `undefined` for that row, which the panel renders as a
 *   dash: *nothing counted this response*. The cost is that the summary total
 *   then omits the unattributable span — a chat's "Cache read" chip can read
 *   less than the session actually read. That is the deliberate trade: a
 *   visible gap in a table of measurements beats an invisible misattribution in
 *   a row a user might quote. The baseline still advances, so one gap perturbs
 *   one row rather than every row after it.
 *
 *   **A gap at zero is not a gap.** A running total sitting at 0 that goes quiet
 *   has nothing to hide: for the counter to have missed something it would have
 *   had to count it, and then it would not still read 0. This is not a
 *   hypothetical nicety — Cline's own emitter is exactly this shape, sending
 *   `totalCacheReadTokens: $.cacheReadTokens === 0 ? undefined : …` (verified in
 *   `@cline/core/dist/index.js`), so it drops the field on every turn until the
 *   first cache hit. Without this branch the first turn that *did* read cache
 *   would be dashed as unattributable, turning a defensive guard into a
 *   regression on the common path.
 *
 * Not used for figures an engine reports **per turn already** (pi's) — those
 * need no differencing and differencing them would be the same bug inverted.
 */
export class CumulativeCounter {
  /** Latest running total seen, or null before the first report. */
  private previous: number | null = null;
  /** Did the immediately preceding turn report this counter? */
  private reportedLastTurn = false;

  /**
   * Record one turn's running total and return that turn's own step.
   *
   * Call **once per turn**, including for turns that did not report the counter
   * (pass `undefined`) — that is how a gap is detected at all.
   *
   * @returns the step attributable to this turn, or `undefined` when the turn
   *   reported nothing or when the step cannot be attributed to it alone.
   */
  step(total: number | null | undefined): number | undefined {
    if (typeof total !== "number" || !Number.isFinite(total)) {
      this.reportedLastTurn = false;
      return undefined;
    }
    const previous = this.previous;
    // A gap below a baseline of 0 hides nothing — see the class doc-comment.
    const afterGap = previous !== null && previous > 0 && !this.reportedLastTurn;
    this.previous = total;
    this.reportedLastTurn = true;

    if (previous === null) return total;
    if (total < previous) return total;
    if (afterGap) return undefined;
    return total - previous;
  }
}
