import { useCallback, useEffect, useRef, useState } from "react";
import { copyToClipboard } from "../utils/clipboard";

/**
 * Copy-to-clipboard with "Copied" feedback, built on `copyToClipboard` so it
 * keeps working over plain HTTP, where `navigator.clipboard` is absent or
 * rejects.
 *
 * Returns `[copied, copy, reset]`:
 * - `copied` is the text most recently copied, or `null`. Most callers only
 *   test `copied !== null`; a list of copy buttons compares it to its row's
 *   text to light up just that one.
 * - `copy(text)` resolves to whether the text landed. Feedback is shown only
 *   on success.
 * - `reset()` clears the feedback early.
 *
 * Feedback clears after `resetMs` (1.5s by default). Pass `null` to keep it
 * until `reset()` — for a one-time secret whose "Copied" should persist.
 */
export function useCopy(resetMs: number | null = 1500): [copied: string | null, copy: (text: string) => Promise<boolean>, reset: () => void] {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => clearTimer(timer), []);

  const copy = useCallback(
    async (text: string) => {
      const ok = await copyToClipboard(text);
      if (ok) {
        clearTimer(timer);
        setCopied(text);
        if (resetMs !== null) {
          timer.current = setTimeout(() => {
            timer.current = null;
            setCopied(null);
          }, resetMs);
        }
      }
      return ok;
    },
    [resetMs],
  );

  const reset = useCallback(() => {
    clearTimer(timer);
    setCopied(null);
  }, []);

  return [copied, copy, reset];
}

function clearTimer(timer: { current: ReturnType<typeof setTimeout> | null }) {
  if (timer.current !== null) {
    clearTimeout(timer.current);
    timer.current = null;
  }
}
