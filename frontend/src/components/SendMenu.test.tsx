// @vitest-environment jsdom
/**
 * The send menu on its own: a `menu` of `menuitem`s, the first usable one
 * focused, arrows (and Home/End) moving between usable rows, Escape closing
 * it and handing focus back to the textarea — claimed, so a container closing
 * on Escape sees it handled — and only for an Escape in its own chat.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import SendMenu, { sendVariantForEnter, type SendMenuProps } from "./SendMenu";

afterEach(cleanup);

function renderMenu(props: Partial<SendMenuProps> = {}) {
  const textareaRef = createRef<HTMLTextAreaElement>();
  const scopeRef = createRef<HTMLDivElement>();
  const onClose = vi.fn();
  const onSend = vi.fn();
  const onVariant = vi.fn();
  render(
    <div className="chat-layout">
      <div ref={scopeRef}>
        <textarea ref={textareaRef} aria-label="composer" />
        <SendMenu
          variants={{ aside: { enabled: true } }}
          canSend
          showShortcuts
          onSend={onSend}
          onVariant={onVariant}
          onClose={onClose}
          returnFocusTo={textareaRef}
          scope={scopeRef}
          {...props}
        />
      </div>
    </div>,
  );
  return { onClose, onSend, onVariant, textareaRef };
}

describe("SendMenu", () => {
  it("is a labelled menu whose first row takes focus, with shortcut hints", () => {
    renderMenu();
    expect(screen.getByRole("menu", { name: "Send options" })).toBeTruthy();
    const items = screen.getAllByRole("menuitem");
    expect(document.activeElement).toBe(items[0]);
    expect(items[0].textContent).toContain("⏎");
    expect(items[1].textContent).toMatch(/⌘⇧⏎|Ctrl\+Shift\+Enter/);
  });

  it("moves with the arrow keys, wrapping, and Home/End", () => {
    renderMenu();
    const [sendNow, aside] = screen.getAllByRole("menuitem");
    fireEvent.keyDown(sendNow, { key: "ArrowDown" });
    expect(document.activeElement).toBe(aside);
    fireEvent.keyDown(aside, { key: "ArrowDown" });
    expect(document.activeElement).toBe(sendNow);
    fireEvent.keyDown(sendNow, { key: "ArrowUp" });
    expect(document.activeElement).toBe(aside);
    fireEvent.keyDown(aside, { key: "Home" });
    expect(document.activeElement).toBe(sendNow);
    fireEvent.keyDown(sendNow, { key: "End" });
    expect(document.activeElement).toBe(aside);
  });

  it("skips a disabled row, which still shows its reason", () => {
    renderMenu({ variants: { aside: { enabled: false, reason: "Remove the command first." } } });
    const [sendNow, aside] = screen.getAllByRole("menuitem");
    expect((aside as HTMLButtonElement).disabled).toBe(true);
    expect(aside.textContent).toContain("Remove the command first.");
    fireEvent.keyDown(sendNow, { key: "ArrowDown" });
    expect(document.activeElement).toBe(sendNow);
  });

  it("closes on Escape, claimed, and returns focus to the textarea", () => {
    const { onClose, textareaRef } = renderMenu();
    const escape = fireEvent.keyDown(screen.getAllByRole("menuitem")[0], { key: "Escape" });
    expect(escape).toBe(false);
    expect(onClose).toHaveBeenCalled();
    expect(document.activeElement).toBe(textareaRef.current);
  });

  it("leaves an Escape pressed in another chat alone", () => {
    const { onClose } = renderMenu();
    const other = document.createElement("input");
    const otherChat = document.createElement("div");
    otherChat.className = "chat-layout";
    otherChat.appendChild(other);
    document.body.appendChild(otherChat);
    fireEvent.keyDown(other, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    otherChat.remove();
  });

  it("closes on a click outside, and a row closes it and runs", () => {
    const { onClose, onVariant, onSend } = renderMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Send as aside/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onVariant).toHaveBeenCalledWith("aside");
    fireEvent.click(screen.getByRole("menuitem", { name: /Send now/ }));
    expect(onSend).toHaveBeenCalled();
    // The backdrop is the menu's previous sibling.
    fireEvent.click(screen.getByRole("menu").previousElementSibling!);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("ignores the backdrop click a long press's lifted finger leaves", () => {
    const { onClose } = renderMenu({ openedByTouch: true });
    fireEvent.click(screen.getByRole("menu").previousElementSibling!);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("sendVariantForEnter", () => {
  const aside = { aside: { enabled: true } };
  it("matches Cmd/Ctrl+Shift+Enter to aside, and nothing else", () => {
    expect(sendVariantForEnter({ shiftKey: true, metaKey: true, ctrlKey: false, altKey: false }, aside)).toBe("aside");
    expect(sendVariantForEnter({ shiftKey: true, metaKey: false, ctrlKey: true, altKey: false }, aside)).toBe("aside");
    expect(sendVariantForEnter({ shiftKey: true, metaKey: false, ctrlKey: false, altKey: false }, aside)).toBeNull();
    expect(sendVariantForEnter({ shiftKey: false, metaKey: true, ctrlKey: false, altKey: false }, aside)).toBeNull();
    expect(sendVariantForEnter({ shiftKey: true, metaKey: true, ctrlKey: false, altKey: true }, aside)).toBeNull();
  });
  it("matches only variants on offer", () => {
    expect(sendVariantForEnter({ shiftKey: true, metaKey: true, ctrlKey: false, altKey: false }, {})).toBeNull();
    expect(sendVariantForEnter({ shiftKey: true, metaKey: true, ctrlKey: false, altKey: false }, undefined)).toBeNull();
  });
});
