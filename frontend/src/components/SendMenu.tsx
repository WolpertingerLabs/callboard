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
 * now is the caller's (`sendVariants` on PromptInput); sending is
 * PromptInput's, which clears the composer only once a variant reports it went
 * out.
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
  /** Whether an Enter with these modifiers is this variant's shortcut. */
  matches: (e: EnterModifiers) => boolean;
}

export const SEND_VARIANT_SPECS: Record<SendVariant, SendVariantSpec> = {
  aside: {
    label: "Send as aside",
    description: "Ask in a side chat; this chat keeps going",
    icon: <MessageSquareQuote size={16} style={{ flexShrink: 0 }} />,
    shortcut: { apple: "⌘⇧⏎", other: "Ctrl+Shift+Enter" },
    matches: (e) => e.shiftKey && (e.metaKey || e.ctrlKey) && !e.altKey,
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
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !escapeIsInScope(e.target, scope.current)) return;
      e.preventDefault();
      onCloseRef.current();
      returnFocusTo.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [returnFocusTo, scope]);

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    const focusAt = (i: number) => items[(i + items.length) % items.length]?.focus();
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
            onClick={() => {
              onClose();
              onSend();
            }}
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
                onClick={() => {
                  onClose();
                  onVariant(variant);
                }}
              />
            );
          })}
        </MenuRoleContext.Provider>
      </div>
    </>
  );
}
