/**
 * Clipboard writes that survive a non-secure context.
 *
 * Callboard is routinely opened over plain HTTP on a LAN address, where
 * `navigator.clipboard` is either absent or rejects on write. The legacy
 * `execCommand("copy")` path still works there, so every copy affordance in the
 * UI goes through this helper rather than calling the Clipboard API directly.
 */

/** Selects `text` in an offscreen textarea and copies it with `execCommand`. */
function copyViaTextarea(text: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
}

/** Copies `text`, returning whether it landed on the clipboard. */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Clipboard API failed (non-secure context, permission denied, etc.)
      return copyViaTextarea(text);
    }
  }
  return copyViaTextarea(text);
}

/**
 * Puts `html` and `text` on the clipboard together, so a rich target (Slack,
 * Docs, email) pastes the formatting and a plain one (a terminal, a code
 * editor) still gets readable text.
 *
 * The fallback is the same `execCommand("copy")` route as above, with a one-shot
 * `copy` listener that overrides what lands on the clipboard — the only way to
 * set more than one type without the async Clipboard API.
 */
export async function copyRichToClipboard(html: string, text: string): Promise<boolean> {
  if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([text], { type: "text/plain" }),
        }),
      ]);
      return true;
    } catch {
      // Fall through to the copy-event route.
    }
  }
  return copyViaCopyEvent(html, text);
}

function copyViaCopyEvent(html: string, text: string): boolean {
  let filled = false;
  const onCopy = (e: ClipboardEvent) => {
    if (!e.clipboardData) return;
    e.clipboardData.setData("text/html", html);
    e.clipboardData.setData("text/plain", text);
    e.preventDefault();
    filled = true;
  };
  document.addEventListener("copy", onCopy);
  try {
    // Copy from a selected textarea even though the listener replaces its
    // contents: Safari doesn't fire `copy` without a non-empty selection.
    return copyViaTextarea(text) && filled;
  } finally {
    document.removeEventListener("copy", onCopy);
  }
}
