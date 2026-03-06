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

export interface ThemeListItem {
  /** Display name / filename (without extension). */
  name: string;
  /** ISO timestamp of creation. */
  createdAt: string;
  /** ISO timestamp of last update. */
  updatedAt: string;
}
