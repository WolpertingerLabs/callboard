/**
 * Where a dictated transcript goes in the composer's text.
 *
 * Unlike `insertTextAt` (keywords, the commands modal), dictation never
 * replaces the selection: the user may have selected text for an unrelated
 * reason before reaching for the mic, and a transcript arriving seconds later
 * must not silently delete it. The transcript lands at the selection's end —
 * after whatever is selected — and the selection's text survives untouched.
 *
 * A space is added on either side where the neighbour is not already
 * whitespace, so dictating into the middle of a sentence does not glue words
 * together. A blank transcript changes nothing.
 */
export function insertDictation(value: string, selectionStart: number, selectionEnd: number, text: string): { value: string; caret: number } {
  const clamp = (n: number) => Math.max(0, Math.min(n, value.length));
  const at = clamp(Math.max(selectionStart, selectionEnd));
  const body = text.trim();
  if (!body) return { value, caret: at };
  const before = value.slice(0, at);
  const after = value.slice(at);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = after && !/^\s/.test(after) ? " " : "";
  const inserted = lead + body;
  return { value: before + inserted + trail + after, caret: at + inserted.length };
}
