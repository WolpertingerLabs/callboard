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
