import type { CardSummary } from "../api";

/**
 * Distinct category labels across the given cards, alphabetical.
 *
 * Single source of truth for "what categories exist" — the board's group
 * headers and every category autocomplete read from here, so they can't drift
 * on dedupe or collation rules.
 */
export function uniqueCategories(cards: CardSummary[]): string[] {
  return [...new Set(cards.map((c) => c.category).filter((c): c is string => !!c))].sort((a, b) => a.localeCompare(b));
}
