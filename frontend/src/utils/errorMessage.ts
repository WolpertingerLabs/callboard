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

/** The HTTP status an api.ts request rejected with, if it got as far as a response. */
export function httpStatusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}
