import type { FocusEvent } from "react";
import { isMaskedSecret } from "shared/types/index.js";

/**
 * A saved credential arrives masked (`••••` plus its last four), and Save sends
 * the mask back, which the daemon reads as "keep it". Selecting the mask on
 * focus makes typing or pasting replace it rather than append to it; clearing
 * the field and saving removes the saved value.
 */
export function selectMaskedSecret(e: FocusEvent<HTMLInputElement>): void {
  if (isMaskedSecret(e.target.value)) e.target.select();
}
