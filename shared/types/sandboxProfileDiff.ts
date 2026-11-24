/**
 * A line diff of two canonical profile recipes, for the proposal card and
 * Settings → Sandbox desktop's version history. Canonical recipes are
 * pretty-printed JSON with a fixed key order (`canonicalProfileRecipe`), so a
 * line diff shows exactly which fields changed.
 *
 * Plain LCS. Recipes are at most 64 KiB, but a diff past
 * {@link DIFF_CELL_LIMIT} cells falls back to "everything removed, everything
 * added" rather than spend the time: still correct, just less helpful.
 */
export type RecipeDiffLine = { op: "same" | "add" | "remove"; text: string };

export const DIFF_CELL_LIMIT = 4_000_000;

export function recipeLineDiff(before: string, after: string): RecipeDiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  // Trim the common head and tail first: most versions change a few lines.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const out: RecipeDiffLine[] = a.slice(0, head).map((text) => ({ op: "same", text }));
  if (midA.length * midB.length > DIFF_CELL_LIMIT) {
    out.push(...midA.map((text) => ({ op: "remove" as const, text })), ...midB.map((text) => ({ op: "add" as const, text })));
  } else {
    const n = midA.length;
    const m = midB.length;
    // lcs[i][j]: the LCS length of midA[i..] and midB[j..], in one flat array.
    const lcs = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        lcs[i * (m + 1) + j] = midA[i] === midB[j] ? lcs[(i + 1) * (m + 1) + j + 1]! + 1 : Math.max(lcs[(i + 1) * (m + 1) + j]!, lcs[i * (m + 1) + j + 1]!);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        out.push({ op: "same", text: midA[i]! });
        i++;
        j++;
      } else if (lcs[(i + 1) * (m + 1) + j]! >= lcs[i * (m + 1) + j + 1]!) out.push({ op: "remove", text: midA[i++]! });
      else out.push({ op: "add", text: midB[j++]! });
    }
    while (i < n) out.push({ op: "remove", text: midA[i++]! });
    while (j < m) out.push({ op: "add", text: midB[j++]! });
  }
  out.push(...a.slice(a.length - tail).map((text) => ({ op: "same" as const, text })));
  return out;
}

/** Whether a diff changes anything. */
export const recipeDiffChanged = (diff: readonly RecipeDiffLine[]) => diff.some((line) => line.op !== "same");
