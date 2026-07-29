/**
 * The one gate every theme write goes through.
 *
 * There are four ways a theme reaches disk — `generate_theme` and `update_theme`
 * over MCP, `POST /api/themes` and `PUT /api/themes/:name` over HTTP — and until
 * this module existed only the first was checked. That is close to the opposite
 * of useful: `update_theme` is the tool an agent asked to "make the warning
 * colour a bit more orange" actually reaches for, it merged whatever it was
 * handed straight into the stored file, and it sat in the same tool list as the
 * guarded one. Worse, it was the natural recovery path *from* the guarded one —
 * when `generate_theme` refused a theme, hand-authoring the same colours through
 * `update_theme` stored them unexamined.
 *
 * So the gate is here, not at a call site, and it does three things in order:
 *
 * 1. **Filter** the incoming variables to `THEME_VARIABLE_NAMES`. A write naming
 *    `--chatlist-badge-triggered-bg` would pin a derived variable to a flat
 *    value and cut it off from the primitive it exists to follow — the same
 *    severed cascade `keep()` was added to the generate path to prevent.
 * 2. **Correct** what a lightness move can bring up to AA.
 * 3. **Refuse** anything still below it.
 *
 * ── The one deliberate asymmetry ────────────────────────────────────
 *
 * Step 3 has an opt-out, `allowBelowAA`, and it is reachable **only over HTTP**.
 * The MCP tools do not offer it and are not able to set it.
 *
 * The distinction being drawn is authorship, and it is the same one that makes a
 * stored theme reported-never-repaired: a person editing their own theme file,
 * through an API they had to name a flag to reach, is exercising ownership over
 * their own data, and a contrast checker that overrules them is answering a
 * question nobody asked. An agent calling `update_theme` has no such standing —
 * it is not the author, the user will not see the values it chose, and "the tool
 * let me" is precisely how a 2.1:1 pairing lands on disk with everyone acting
 * reasonably. The flag exists so that the human case can be served *without*
 * leaving the agent case open, which is the only reason it is a flag and not a
 * default.
 *
 * `allowBelowAA` skips correction too, not just the refusal. A hand-authored
 * value that gets quietly moved is a worse outcome than one that gets stored as
 * written and reported — the whole point of the opt-out is that the author meant
 * it. What comes back is the audit, for the caller to show.
 */
import type { ThemeVariables, ThemeContrastFailure, ThemeContrastReport } from "shared/types/index.js";
import { auditThemeVars, correctThemeContrast } from "./theme-contrast.js";
import type { Correction } from "./theme-contrast.js";
import { THEME_VARIABLE_NAMES } from "./theme-variables.js";

const ALLOWED = new Set(THEME_VARIABLE_NAMES);

/**
 * The rule step 3 enforces, and why it is finally the literal one.
 *
 * This used to read "introduces nothing, worsens nothing": a pairing the
 * stylesheet itself failed was the write's fault only if the write made it
 * worse. That was not a softening of the standard, it was the only satisfiable
 * standard available. A theme inherits every variable it does not define, so a
 * write of two variables is measured against a hundred it never touched — and
 * with the built-in palette failing 24 of its 104 pairings, refusing a write for
 * `session-badge-cli` at the stylesheet's own 2.54:1 would have made *every*
 * partial write impossible, while telling the author to fix a colour they could
 * not reach: both sides of that pairing live in the derived layer, which no
 * theme can name.
 *
 * The palette pass closed 20 of the 24. The accent pass closed the last four by
 * moving the brand colour, which was the only lever they had. With the
 * stylesheet at zero, the exemption has nothing left to exempt — a failing
 * pairing under a partial write is now, without exception, something the write
 * did. So the filter is gone and every failure is refused.
 *
 * This is a real tightening and it is load-bearing on the palette staying
 * clean: `theme-contrast.test.ts`'s "leaves nothing below AA, in either mode"
 * is the assertion that keeps it satisfiable, and the one below pins the link
 * from this side. Reintroducing a sub-AA pairing into index.css would make
 * every partial theme write refuse — which is the correct alarm, not a
 * regression to work around by restoring the baseline.
 */
export interface PreparedThemeWrite {
  /** The variables to store. */
  dark: ThemeVariables;
  light: ThemeVariables;
  /** Names in the incoming write that are not part of the theme surface. */
  dropped: string[];
  /** Values the gate moved to reach AA. Empty when `allowBelowAA` was set. */
  corrections: Correction[];
  /**
   * Pairings still below AA after correction. Non-empty means the caller must
   * refuse — unless it opted out. Every one of them, now that the stylesheet
   * this is measured against has none of its own; see the note above.
   */
  unsatisfiable: ThemeContrastFailure[];
  /** The audit of what would be stored, for callers that report rather than refuse. */
  contrast: ThemeContrastReport;
}

export interface PrepareThemeWriteInput {
  /** The variables this write is supplying. Partial for an update. */
  dark?: ThemeVariables;
  light?: ThemeVariables;
  /** The theme being updated, if any. Its variables are merged under the incoming ones. */
  existing?: { dark: ThemeVariables; light: ThemeVariables };
  /**
   * Store what was written even if it does not reach AA, and do not correct it.
   * HTTP-only, and never set from a tool — see the module comment.
   */
  allowBelowAA?: boolean;
}

/**
 * Filter one mode's incoming variables to the theme surface.
 *
 * The *incoming* ones only. An existing stored theme is left exactly as it is,
 * including any out-of-surface key it already carries: this function runs on
 * writes, and silently deleting a user's stored values because they were merged
 * past on the way to a different edit is not a write anybody asked for.
 */
function filterToSurface(vars: ThemeVariables | undefined): { kept: ThemeVariables; dropped: string[] } {
  const kept: ThemeVariables = {};
  const dropped: string[] = [];
  for (const [name, value] of Object.entries(vars ?? {})) {
    if (ALLOWED.has(name)) kept[name] = value;
    else dropped.push(name);
  }
  return { kept, dropped };
}

export async function prepareThemeWrite(input: PrepareThemeWriteInput): Promise<PreparedThemeWrite> {
  const dark = filterToSurface(input.dark);
  const light = filterToSurface(input.light);
  const dropped = [...new Set([...dark.dropped, ...light.dropped])];

  const mergedDark = { ...(input.existing?.dark ?? {}), ...dark.kept };
  const mergedLight = { ...(input.existing?.light ?? {}), ...light.kept };

  if (input.allowBelowAA) {
    const contrast = auditThemeVars(mergedDark, mergedLight);
    return { dark: mergedDark, light: mergedLight, dropped, corrections: [], unsatisfiable: [], contrast };
  }

  const corrected = await correctThemeContrast(mergedDark, mergedLight);
  return {
    dark: corrected.dark,
    light: corrected.light,
    dropped,
    corrections: corrected.corrections,
    unsatisfiable: corrected.unsatisfiable,
    contrast: auditThemeVars(corrected.dark, corrected.light),
  };
}

/**
 * Turn failing pairings into something the caller can act on.
 *
 * Written for a *model* to read, because the caller that matters most is one:
 * `generate_theme` and `update_theme` are MCP tools, and telling an agent to
 * "see the server log" names the one place it provably cannot look. Every
 * retry it makes without this is blind, costs a full generation, and — before
 * the seed-search fix — was frequently not its fault to begin with.
 */
export function describeFailures(failures: ThemeContrastFailure[]): string {
  return failures
    .map((f) =>
      f.unmeasurable
        ? `${f.mode} ${f.where}: ${f.unmeasurable} is not a colour this checker can read — use #rrggbb, rgb(), rgba() or hsl()`
        : `${f.mode} ${f.fg} on ${f.bg} over ${f.backdrop} (${f.where}) is ${f.ratio}:1, needs ${f.required}:1`,
    )
    .join("; ");
}

/** One line per value the gate moved, in the same shape `describeFailures` reads. */
export function describeCorrections(corrections: Correction[]): string {
  return corrections.map((c) => `${c.mode} --${c.variable} ${c.from}→${c.to}`).join(", ");
}
