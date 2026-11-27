/**
 * Copy text to the clipboard. Resolves `true` on success, `false` if the
 * browser refused.
 *
 * `navigator.clipboard` only exists in a secure context (https or
 * localhost), and the daemon is often reached over plain http on a LAN
 * address, so this falls back to a hidden textarea + `execCommand("copy")`.
 * Callers should say "Copy failed" on `false` rather than staying silent.
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied or not focused: try the fallback below.
    }
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  const active = document.activeElement as HTMLElement | null;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  // Off-screen but still selectable; fixed so it doesn't scroll anything.
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.left = "-9999px";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  let ok = false;
  try {
    ta.select();
    ta.setSelectionRange(0, text.length);
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  } finally {
    document.body.removeChild(ta);
    active?.focus?.();
  }
  return ok;
}
