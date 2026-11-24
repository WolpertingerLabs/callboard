/** Whether the primary pointer is coarse (a finger) — where focusing a text field pops the on-screen keyboard. */
export function isCoarsePointer(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
}
