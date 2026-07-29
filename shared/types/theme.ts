/**
 * Custom theme stored as a JSON file in ~/.callboard/themes/<name>.json.
 * Each theme provides CSS variable overrides for both dark and light modes.
 */
export interface ThemeVariables {
  [key: string]: string;
}

export interface CustomTheme {
  /** Display name of the theme. */
  name: string;
  /** Dark mode CSS variable overrides. */
  dark: ThemeVariables;
  /** Light mode CSS variable overrides. */
  light: ThemeVariables;
  /** ISO timestamp of creation. */
  createdAt: string;
  /** ISO timestamp of last update. */
  updatedAt: string;
}

/** One pairing that does not reach its WCAG AA threshold. */
export interface ThemeContrastFailure {
  mode: "dark" | "light";
  /** Stable pairing id, e.g. "chatlist-badge-triggered". */
  id: string;
  /** Where in the UI this pairing is painted. */
  where: string;
  /** Foreground expression, e.g. "var(--warning)". */
  fg: string;
  /** Background expression — often a translucent tint. */
  bg: string;
  /** The opaque surface the tint is composited onto. */
  backdrop: string;
  /** 4.5 for text, 3 for non-text indicators. */
  required: number;
  /** Measured ratio, or null when a variable in the chain could not be resolved. */
  ratio: number | null;
  /**
   * Set instead of a ratio: the expression that failed to resolve, followed by
   * the literal it resolved to when the two differ — `var(--warning) →
   * goldenrod`. Naming only the reference would leave a caller unable to tell an
   * unparseable value from an undefined variable, which are different repairs.
   */
  unmeasurable?: string;
}

/**
 * Contrast audit of a theme. Reporting only — a stored theme is user data and
 * is never rewritten on its owner's behalf.
 */
export interface ThemeContrastReport {
  /** Pairings measured (both modes). */
  checked: number;
  /** Worst first. */
  failures: ThemeContrastFailure[];
  /**
   * Theme-surface variables the theme never defines, and so inherits from the
   * stylesheet.
   *
   * This is the audit's *other* half, and it is the half a user is more likely
   * to be looking at. A theme that overrides `--status-triggered` but not
   * `--status-green` paints one sidebar dot in its own palette and the next in
   * the built-in one — visibly wrong, and worth exactly zero contrast failures,
   * because each colour is perfectly legible on its own. A panel that reported
   * only ratios would say nothing at all about it.
   *
   * Optional: absent from clients or responses built before this existed.
   */
  undefinedVariables?: {
    dark: string[];
    light: string[];
  };
}

export interface ThemeListItem {
  /** Display name / filename (without extension). */
  name: string;
  /** ISO timestamp of creation. */
  createdAt: string;
  /** ISO timestamp of last update. */
  updatedAt: string;
  /**
   * Contrast audit of the stored file. Optional: absent from clients or
   * responses built before the audit existed.
   */
  contrast?: ThemeContrastReport;
}
