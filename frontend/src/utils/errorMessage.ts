/**
 * The message to show for a caught value: its `message` when it is an `Error`
 * with a non-empty one, otherwise `fallback`.
 *
 * `catch` binds `unknown` — a rejected promise can carry anything — so this is
 * what replaces both `catch (err: any) { … err.message || "…" }` and the inline
 * `err instanceof Error ? err.message : "…"`. An empty message counts as none:
 * a blank error banner tells the user less than the fallback does.
 */
export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}
