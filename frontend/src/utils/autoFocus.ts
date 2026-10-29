/**
 * Whether focusing a text field without being asked is welcome here.
 *
 * On a touch device, focus is what raises the on-screen keyboard, which covers
 * half the screen the user opened to read. So this asks about the *input*, not
 * the viewport width `useIsMobile` measures: a tablet in landscape is wider
 * than 768px and still has no keyboard until one is summoned, while a narrow
 * desktop window still has one. A primary pointer that hovers and is precise
 * is a mouse or trackpad, and a mouse comes with a keyboard.
 *
 * `false` where `matchMedia` is missing (jsdom): an unknown device is treated
 * as a touch one, since the cost of guessing wrong there is a keyboard popping
 * up uninvited, while on a desktop it is only one extra click.
 */
const DESKTOP_POINTER_QUERY = "(hover: hover) and (pointer: fine)";

export function canAutoFocusTextInput(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(DESKTOP_POINTER_QUERY).matches;
}

/**
 * Whether the user is already typing somewhere other than `own`. A link or
 * button keeping focus after the click that navigated here does not count —
 * that click is what asked for the composer.
 */
export function isEditingElsewhere(own: Element | null): boolean {
  const active = document.activeElement;
  if (!active || active === own || active === document.body) return false;
  if (active instanceof HTMLElement && active.isContentEditable) return true;
  if (active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement) return true;
  if (active instanceof HTMLInputElement) {
    return !["button", "checkbox", "radio", "submit", "reset", "image", "file", "range", "color"].includes(active.type);
  }
  return false;
}
