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

/**
 * A reviewer's diff of two canonical recipes: every field but `setup` as
 * pretty-printed JSON, and `setup` on its own, line by line. In the
 * canonical JSON the setup script is one escaped string, so a one-line change
 * to it would show as one giant removed line and one giant added one; this
 * shows the script's own lines.
 */
export interface RecipeReviewDiff {
  fields: RecipeDiffLine[];
  setup: RecipeDiffLine[];
}
function splitRecipe(canonical: string): { fields: string; setup: string } {
  try {
    const parsed = JSON.parse(canonical) as Record<string, unknown>;
    const setup = typeof parsed.setup === "string" ? parsed.setup : "";
    delete parsed.setup;
    return { fields: JSON.stringify(parsed, null, 2), setup };
  } catch {
    return { fields: canonical, setup: "" };
  }
}
export function recipeReviewDiff(before: string, after: string): RecipeReviewDiff {
  const a = splitRecipe(before);
  const b = splitRecipe(after);
  const lines = (script: string) => (script ? script.replace(/\n$/, "").split("\n") : []);
  const [from, to] = [lines(a.setup), lines(b.setup)];
  const setup: RecipeDiffLine[] = !from.length
    ? to.map((text) => ({ op: "add", text }))
    : !to.length
      ? from.map((text) => ({ op: "remove", text }))
      : recipeLineDiff(from.join("\n"), to.join("\n"));
  return { fields: recipeLineDiff(a.fields, b.fields), setup };
}

/** A diff with long unchanged runs folded: `context` lines kept around each change, the rest one `fold` marker. */
export type FoldedDiffLine = RecipeDiffLine | { op: "fold"; count: number };
export function foldRecipeDiff(lines: readonly RecipeDiffLine[], context = 3): FoldedDiffLine[] {
  const keep = lines.map(() => false);
  lines.forEach((line, i) => {
    if (line.op === "same") return;
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) keep[j] = true;
  });
  const out: FoldedDiffLine[] = [];
  for (let i = 0; i < lines.length; ) {
    if (keep[i]) {
      out.push(lines[i]!);
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && !keep[j]) j++;
    // Folding one line saves nothing.
    if (j - i <= 1) out.push(...lines.slice(i, j));
    else out.push({ op: "fold", count: j - i });
    i = j;
  }
  return out;
}
