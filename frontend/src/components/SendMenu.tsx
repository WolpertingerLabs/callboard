import { useEffect, useRef, useState, type RefObject } from "react";
import { ArrowUp, MessageSquareQuote } from "lucide-react";
import MenuRow, { MenuRoleContext } from "./MenuRow";
import { escapeIsInScope } from "../utils/escapeScope";

/**
 * The composer's send menu: Send, and the other ways to send what the
 * composer holds. Opened from the chevron beside Send, by right-clicking Send,
 * or by a long press on it (touch).
 *
 * Presentation only. Which variants exist and whether each can be used right
 * now is the caller's (`sendVariants` on PromptInput). Sending is
 * PromptInput's, which hands the prompt and files to `onSendVariant` and
 * clears nothing itself: the page's handler does, once it knows what was
 * taken (see `onSendVariant` on PromptInput's Props).
 */

/**
 * The ways to send other than plain Send. Adding one: a name here, a spec in
 * {@link SEND_VARIANT_SPECS}, its place in {@link SEND_VARIANT_ORDER} — the
 * menu rows, the shortcut, the mobile hamburger entries and PromptInput's
 * async send all follow from those.
 */
export type SendVariant = "aside";

/** Whether a variant can be used right now; `reason` says why not, and is shown on the disabled row. */
export interface SendVariantState {
  enabled: boolean;
  reason?: string;
}

/** The variants a chat offers. A variant left out is not offered at all (no row); none at all, and there is no menu. */
export type SendVariants = Partial<Record<SendVariant, SendVariantState>>;

/** The modifiers a variant's shortcut is read from, on an Enter keydown. */
type EnterModifiers = Pick<KeyboardEvent, "altKey" | "shiftKey" | "metaKey" | "ctrlKey">;

interface SendVariantSpec {
  label: string;
  /** What it does, shown under the label while it is enabled. */
  description: string;
  icon: React.ReactNode;
  /** Shortcut hint as shown on Apple platforms and elsewhere. */
  shortcut: { apple: string; other: string };
  /**
   * Whether an Enter with these modifiers is this variant's shortcut. State
   * every modifier, held and not held: on Windows AltGr arrives as Ctrl+Alt,
   * so an Alt-based matcher (Send when idle's ⌥⏎) must also require
   * `!e.ctrlKey && !e.metaKey`, or AltGr+Enter and ⌥⌘⏎ would match it too.
   */
  matches: (e: EnterModifiers) => boolean;
  /**
   * What the shortcut does while the variant is offered but disabled:
   * `"menu"` opens the send menu so the row's reason is visible (a shortcut
   * that silently does nothing reads as broken); `"send"` falls back to a
   * plain Send (Send when idle with no run to wait for is just Send).
   */
  whenUnavailable: "menu" | "send";
}

export const SEND_VARIANT_SPECS: Record<SendVariant, SendVariantSpec> = {
  aside: {
    label: "Send as aside",
    description: "Ask in a side chat; this chat keeps going",
    icon: <MessageSquareQuote size={16} style={{ flexShrink: 0 }} />,
    shortcut: { apple: "⌘⇧⏎", other: "Ctrl+Shift+Enter" },
    matches: (e) => e.shiftKey && (e.metaKey || e.ctrlKey) && !e.altKey,
    // A plain send is the opposite of an aside: it would land in this chat
    // (and interrupt a running turn). Show why instead.
    whenUnavailable: "menu",
  },
};

/** Menu order, after Send. */
export const SEND_VARIANT_ORDER: readonly SendVariant[] = ["aside"];

/** The variants on offer, in menu order. */
export function offeredSendVariants(variants: SendVariants | undefined): SendVariant[] {
  return variants ? SEND_VARIANT_ORDER.filter((variant) => variants[variant]) : [];
}

/** The offered variant whose shortcut this Enter is, if any — enabled or not. */
export function sendVariantForEnter(e: EnterModifiers, variants: SendVariants | undefined): SendVariant | null {
  return offeredSendVariants(variants).find((variant) => SEND_VARIANT_SPECS[variant].matches(e)) ?? null;
}

function isApplePlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
}

export function sendVariantShortcut(variant: SendVariant): string {
  const { apple, other } = SEND_VARIANT_SPECS[variant].shortcut;
  return isApplePlatform() ? apple : other;
}

/** How long a touch-opened menu ignores its backdrop: the finger that held Send lifts onto it. Same as PopupMenu. */
const TOUCH_GRACE_MS = 300;

export interface SendMenuProps {
  variants: SendVariants;
  /** Whether Send itself (and so any variant) has something to send. */
  canSend: boolean;
  /** A run is going: Send interrupts it, and the row says so. */
  sendInterrupts?: boolean;
  /** Shortcut hints are for keyboards; off on touch layouts. */
  showShortcuts: boolean;
  openedByTouch?: boolean;
  /**
   * Where focus goes on open. `"item"`: the first usable row, for a menu the
   * user opened to pick from (chevron, right-click, long press). `"menu"`: the
   * menu itself, with no row focused — for one a shortcut opened to show a
   * reason. A focused row there would be activated by the same shortcut
   * pressed again (or auto-repeating): browsers click a focused button on
   * Enter whatever modifiers are held, and the first usable row is Send now.
   */
  initialFocus?: "item" | "menu";
  onSend: () => void;
  onVariant: (variant: SendVariant) => void;
  onClose: () => void;
  /** Where focus goes when Escape closes the menu — the textarea. */
  returnFocusTo: RefObject<HTMLElement | null>;
  /** The composer the menu belongs to, so Escape pressed in the other chat (the aside panel's) is left alone. */
  scope: RefObject<HTMLElement | null>;
}

/**
 * Positioned by the caller's wrapper (absolute, above Send), in place rather
 * than portaled: a portaled menu snapshots its position and has to close on
 * any scroll, and a streaming transcript scrolls continually — the very
 * moment an aside is most useful.
 */
export default function SendMenu({
  variants,
  canSend,
  sendInterrupts,
  showShortcuts,
  openedByTouch = false,
  initialFocus = "item",
  onSend,
  onVariant,
  onClose,
  returnFocusTo,
  scope,
}: SendMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [openedAt] = useState(() => Date.now());
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  // The first usable row takes focus; Escape closes and hands focus back to
  // the textarea. Claimed on the capture phase, as the composer's other menu
  // does, so a container that closes on Escape (the aside panel) sees it was
  // handled — and only for an Escape in this composer's chat.
  useEffect(() => {
    if (initialFocus === "menu") menuRef.current?.focus();
    else menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !escapeIsInScope(e.target, scope.current)) return;
      e.preventDefault();
      onCloseRef.current();
      returnFocusTo.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
    // Focus is placed once, on open: `initialFocus` is not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [returnFocusTo, scope]);

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    const focusAt = (i: number) => items[(i + items.length) % items.length]?.focus();
    // Only a plain, deliberate Enter picks a row. One with a modifier held is
    // a send shortcut pressed again, and an auto-repeat is a key held down:
    // left alone, either would click whichever row has focus.
    if (e.key === "Enter" && (e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey)) {
      e.preventDefault();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusAt(index + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusAt(index - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusAt(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusAt(items.length - 1);
    } else if (e.key === "Tab") {
      onClose();
    }
  };

  // The focused row unmounts with the menu, which would drop focus on the
  // page body: hand it back to the textarea, so typing carries on. Not after a
  // long press — focusing would raise a phone's keyboard.
  const pick = (action: () => void) => {
    onClose();
    if (!openedByTouch) returnFocusTo.current?.focus();
    action();
  };

  const backdropClose = () => {
    if (openedByTouch && Date.now() - openedAt < TOUCH_GRACE_MS) return;
    onClose();
  };

  return (
    <>
      <div
        onClick={backdropClose}
        onContextMenu={(e) => {
          e.preventDefault();
          backdropClose();
        }}
        style={{ position: "fixed", inset: 0, zIndex: 50 }}
      />
      <div
        ref={menuRef}
        role="menu"
        aria-label="Send options"
        tabIndex={-1}
        onKeyDown={onMenuKeyDown}
        style={{
          position: "absolute",
          bottom: "calc(100% + 8px)",
          right: 0,
          width: "max-content",
          maxWidth: "min(440px, calc(100vw - 24px))",
          zIndex: 51,
          padding: 4,
          borderRadius: 10,
          background: "var(--surface)",
          border: "1px solid var(--border)",
          boxShadow: "var(--shadow-md)",
        }}
      >
        <MenuRoleContext.Provider value={true}>
          <MenuRow
            icon={<ArrowUp size={16} style={{ flexShrink: 0 }} />}
            label="Send now"
            description={sendInterrupts ? "Interrupts the current turn" : undefined}
            shortcut={showShortcuts ? "⏎" : undefined}
            disabled={!canSend}
            onClick={() => pick(onSend)}
          />
          {offeredSendVariants(variants).map((variant) => {
            const spec = SEND_VARIANT_SPECS[variant];
            const state = variants[variant]!;
            const enabled = state.enabled && canSend;
            return (
              <MenuRow
                key={variant}
                icon={spec.icon}
                label={spec.label}
                description={!state.enabled && state.reason ? state.reason : spec.description}
                shortcut={showShortcuts ? sendVariantShortcut(variant) : undefined}
                disabled={!enabled}
                onClick={() => pick(() => onVariant(variant))}
              />
            );
          })}
        </MenuRoleContext.Provider>
      </div>
    </>
  );
}
