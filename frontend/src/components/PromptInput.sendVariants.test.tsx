// @vitest-environment jsdom
/**
 * The composer's send variants (Send as aside): a split button with a chevron
 * only when the page offers some, the same menu on right-click and on a long
 * press (touch), ⌘/Ctrl+Shift+Enter as the shortcut, a send handed to the
 * page with the composer left alone (the page clears what it took), and the
 * variants in the hamburger menu on a phone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import PromptInput, { type SendVariants } from "./PromptInput";
import { SEND_VARIANT_SPECS } from "./SendMenu";

vi.mock("../api", () => ({ getSlashCommandContent: vi.fn(async (name: string) => ({ name, source: "custom-skill", description: "", content: "" })) }));

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
});

const ENABLED: SendVariants = { aside: { enabled: true } };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function renderComposer(props: Partial<React.ComponentProps<typeof PromptInput>> = {}) {
  const onSend = vi.fn();
  const onSendVariant = vi.fn(async (): Promise<void> => {});
  let addImages: ((files: File[]) => void) | null = null;
  const base: React.ComponentProps<typeof PromptInput> = {
    onSend,
    onSendVariant,
    disabled: false,
    slashCommands: ["compact"],
    chatId: "chat-1",
    onAddImages: (register) => {
      addImages = (register as unknown as () => (files: File[]) => void)();
    },
    ...props,
  };
  const view = render(<PromptInput {...base} />);
  const textarea = screen.getByPlaceholderText("Send a message...") as HTMLTextAreaElement;
  return {
    onSend,
    onSendVariant: (props.onSendVariant ?? onSendVariant) as ReturnType<typeof vi.fn>,
    textarea,
    sendButton: () => screen.getByRole("button", { name: "Send" }),
    chevron: () => screen.queryByRole("button", { name: "More ways to send" }),
    attach: (files: File[]) => act(() => addImages!(files)),
    rerender: (next: Partial<React.ComponentProps<typeof PromptInput>>) => view.rerender(<PromptInput {...base} {...next} />),
  };
}

const type = (textarea: HTMLTextAreaElement, value: string) => fireEvent.change(textarea, { target: { value } });
const asideShortcut = (textarea: HTMLTextAreaElement, mods: { metaKey?: boolean; ctrlKey?: boolean } = { metaKey: true }) =>
  fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true, ...mods });

describe("PromptInput send variants", () => {
  it("has no chevron, menu or long press without variants", () => {
    const { chevron, sendButton, textarea } = renderComposer({ sendVariants: undefined });
    expect(chevron()).toBeNull();
    type(textarea, "hi");
    fireEvent.contextMenu(sendButton());
    expect(screen.queryByRole("menu")).toBeNull();
    // An empty variant set is the same as none.
    cleanup();
    expect(renderComposer({ sendVariants: {} }).chevron()).toBeNull();
  });

  it("opens the send menu from the chevron, with Send now and Send as aside", () => {
    const { chevron, textarea } = renderComposer({ sendVariants: ENABLED });
    type(textarea, "why?");
    const toggle = chevron()!;
    expect(toggle.getAttribute("aria-haspopup")).toBe("menu");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const items = screen.getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual([expect.stringContaining("Send now"), expect.stringContaining("Send as aside")]);
    // The first usable row has focus.
    expect(document.activeElement).toBe(items[0]);
  });

  it("sends as aside from the menu, leaving the composer to the page", async () => {
    const { chevron, textarea, onSendVariant, onSend } = renderComposer({ sendVariants: ENABLED });
    type(textarea, "why?  ");
    fireEvent.click(chevron()!);
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: /Send as aside/ }));
    });
    expect(onSendVariant).toHaveBeenCalledWith("aside", "why?", []);
    expect(onSend).not.toHaveBeenCalled();
    // Cleared by the page once it knows what went (Chat's handleAskAside).
    expect(textarea.value).toBe("why?  ");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Send now in the menu is the ordinary send", () => {
    const { chevron, textarea, onSend, onSendVariant } = renderComposer({ sendVariants: ENABLED, sendInterrupts: true });
    type(textarea, "go on");
    fireEvent.click(chevron()!);
    const sendNow = screen.getByRole("menuitem", { name: /Send now/ });
    expect(sendNow.textContent).toContain("Interrupts the current turn");
    fireEvent.click(sendNow);
    expect(onSend).toHaveBeenCalledWith("go on", undefined);
    expect(onSendVariant).not.toHaveBeenCalled();
  });

  it("sends as aside on Cmd+Shift+Enter and Ctrl+Shift+Enter; Shift+Enter alone stays a newline", async () => {
    const { textarea, onSendVariant, onSend } = renderComposer({ sendVariants: ENABLED });
    type(textarea, "one");
    const shiftEnter = fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    // Not prevented: the textarea inserts its newline.
    expect(shiftEnter).toBe(true);
    expect(onSendVariant).not.toHaveBeenCalled();

    await act(async () => {
      asideShortcut(textarea, { metaKey: true });
    });
    expect(onSendVariant).toHaveBeenLastCalledWith("aside", "one", []);
    type(textarea, "two");
    await act(async () => {
      asideShortcut(textarea, { ctrlKey: true });
    });
    expect(onSendVariant).toHaveBeenLastCalledWith("aside", "two", []);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("ignores the shortcut mid IME composition", () => {
    const { textarea, onSendVariant } = renderComposer({ sendVariants: ENABLED });
    type(textarea, "かな");
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true, metaKey: true, isComposing: true });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true, metaKey: true, keyCode: 229 });
    expect(onSendVariant).not.toHaveBeenCalled();
  });

  it("lets an open slash menu have the shortcut's Enter: it closes the menu and sends nothing", () => {
    const { textarea, onSendVariant, onSend } = renderComposer({ sendVariants: ENABLED });
    type(textarea, "/comp");
    expect(screen.getByRole("listbox")).toBeTruthy();
    asideShortcut(textarea);
    expect(onSendVariant).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("hands over the prompt with its command chip and the attachments, and touches neither", async () => {
    const { textarea, attach, onSendVariant } = renderComposer({ sendVariants: ENABLED });
    const file = new File(["x"], "a.png", { type: "image/png" });
    type(textarea, "why?");
    attach([file]);
    await act(async () => {
      asideShortcut(textarea);
    });
    expect(onSendVariant).toHaveBeenCalledWith("aside", "why?", [file]);
    expect(textarea.value).toBe("why?");
    expect(screen.getByText("1 file attached")).toBeTruthy();
  });

  it("sends once for a second press while the first is out, and again once it has settled — even after a throw", async () => {
    const pending = deferred<void>();
    const onSendVariant = vi.fn((): Promise<void> => pending.promise);
    const { textarea } = renderComposer({ sendVariants: ENABLED, onSendVariant });
    type(textarea, "why?");
    asideShortcut(textarea);
    asideShortcut(textarea);
    expect(onSendVariant).toHaveBeenCalledTimes(1);
    onSendVariant.mockRejectedValueOnce(new Error("boom"));
    await act(async () => pending.resolve());
    await act(async () => {
      asideShortcut(textarea);
    });
    expect(onSendVariant).toHaveBeenCalledTimes(2);
    onSendVariant.mockResolvedValueOnce(undefined);
    await act(async () => {
      asideShortcut(textarea);
    });
    expect(onSendVariant).toHaveBeenCalledTimes(3);
  });

  it("shows a disabled variant's reason, and its shortcut opens the menu instead of sending", () => {
    const { textarea, onSendVariant } = renderComposer({ sendVariants: { aside: { enabled: false, reason: "A slash command runs in this chat." } } });
    type(textarea, "why?");
    asideShortcut(textarea);
    expect(onSendVariant).not.toHaveBeenCalled();
    const row = screen.getByRole("menuitem", { name: /Send as aside/ }) as HTMLButtonElement;
    expect(row.disabled).toBe(true);
    expect(row.textContent).toContain("A slash command runs in this chat.");
    // The reason is the row's accessible description.
    expect(document.getElementById(row.getAttribute("aria-describedby")!)!.textContent).toBe("A slash command runs in this chat.");
  });

  it("greys every row out while there is nothing to send", () => {
    const { chevron } = renderComposer({ sendVariants: ENABLED });
    fireEvent.click(chevron()!);
    for (const row of screen.getAllByRole("menuitem")) expect((row as HTMLButtonElement).disabled).toBe(true);
  });

  it("opens on right-click of Send without sending", () => {
    const { sendButton, textarea, onSend } = renderComposer({ sendVariants: ENABLED });
    type(textarea, "hi");
    fireEvent.contextMenu(sendButton());
    expect(screen.getByRole("menu")).toBeTruthy();
    // macOS Ctrl+click: a contextmenu and a pointer click (detail 1).
    fireEvent.click(sendButton(), { detail: 1 });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("does not let a right-click swallow the next keyboard press of Send", () => {
    const { sendButton, textarea, onSend } = renderComposer({ sendVariants: ENABLED });
    type(textarea, "hi");
    fireEvent.contextMenu(sendButton());
    fireEvent.keyDown(screen.getAllByRole("menuitem")[0], { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    // Tab to Send, press Space: a click with detail 0.
    fireEvent.click(sendButton(), { detail: 0 });
    expect(onSend).toHaveBeenCalledWith("hi", undefined);
  });

  it("opens on a long press of Send (touch), and the click it leaves behind does not send", () => {
    vi.useFakeTimers();
    const { sendButton, textarea, onSend } = renderComposer({ sendVariants: ENABLED });
    type(textarea, "hi");
    fireEvent.pointerDown(sendButton(), { pointerType: "touch", clientX: 5, clientY: 5 });
    act(() => vi.advanceTimersByTime(460));
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.pointerUp(sendButton());
    fireEvent.click(sendButton(), { detail: 1 });
    expect(onSend).not.toHaveBeenCalled();
    // A plain tap still sends.
    act(() => vi.advanceTimersByTime(400));
    fireEvent.keyDown(screen.getAllByRole("menuitem")[0], { key: "Escape" });
    fireEvent.pointerDown(sendButton(), { pointerType: "touch", clientX: 5, clientY: 5 });
    fireEvent.pointerUp(sendButton());
    fireEvent.click(sendButton(), { detail: 1 });
    expect(onSend).toHaveBeenCalledWith("hi", undefined);
  });

  it("does not open on a press that moves away (a scroll)", () => {
    vi.useFakeTimers();
    const { sendButton, textarea } = renderComposer({ sendVariants: ENABLED });
    type(textarea, "hi");
    fireEvent.pointerDown(sendButton(), { pointerType: "touch", clientX: 5, clientY: 5 });
    fireEvent.pointerMove(sendButton(), { pointerType: "touch", clientX: 5, clientY: 40 });
    act(() => vi.advanceTimersByTime(600));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("on a phone: no chevron, no shortcut hints, and the variants are in More actions", async () => {
    Object.defineProperty(window, "innerWidth", { value: 400, configurable: true });
    const { chevron, textarea, onSendVariant, sendButton } = renderComposer({ sendVariants: ENABLED });
    expect(chevron()).toBeNull();
    type(textarea, "why?");
    fireEvent.click(screen.getByTitle("More actions"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Send as aside/ }));
    });
    expect(onSendVariant).toHaveBeenCalledWith("aside", "why?", []);
    // The long-press menu carries no keyboard hints.
    type(textarea, "again");
    fireEvent.contextMenu(sendButton());
    expect(screen.getByRole("menuitem", { name: /Send as aside/ }).textContent).not.toContain("Enter");
  });

  it("on a phone, a disabled variant in More actions says why", () => {
    Object.defineProperty(window, "innerWidth", { value: 400, configurable: true });
    const { textarea } = renderComposer({ sendVariants: { aside: { enabled: false, reason: "Not now." } } });
    type(textarea, "why?");
    fireEvent.click(screen.getByTitle("More actions"));
    const row = screen.getByRole("button", { name: /Send as aside/ }) as HTMLButtonElement;
    expect(row.disabled).toBe(true);
    expect(row.textContent).toContain("Not now.");
  });

  it("opens on the shortcut of a disabled variant with no row focused, so pressing it again sends nothing", () => {
    const { textarea, onSend, onSendVariant } = renderComposer({
      sendVariants: { aside: { enabled: false, reason: "Not now." } },
      sendInterrupts: true,
    });
    type(textarea, "why?");
    asideShortcut(textarea);
    const menu = screen.getByRole("menu");
    // The menu has focus, not Send now — a row with focus is what a repeated
    // shortcut's Enter would click.
    expect(document.activeElement).toBe(menu);
    const again = createEvent.keyDown(menu, { key: "Enter", shiftKey: true, metaKey: true });
    fireEvent(menu, again);
    expect(again.defaultPrevented).toBe(true);
    // ↓ from the menu picks the first usable row.
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: /Send now/ }));
    expect(onSend).not.toHaveBeenCalled();
    expect(onSendVariant).not.toHaveBeenCalled();
  });

  it("refuses a modified or auto-repeated Enter on a focused row, and takes a plain one", () => {
    const { chevron, textarea, onSend } = renderComposer({ sendVariants: ENABLED });
    type(textarea, "go");
    fireEvent.click(chevron()!);
    const sendNow = screen.getByRole("menuitem", { name: /Send now/ });
    expect(document.activeElement).toBe(sendNow);
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { repeat: true }]) {
      const event = createEvent.keyDown(sendNow, { key: "Enter", ...init });
      fireEvent(sendNow, event);
      expect(event.defaultPrevented).toBe(true);
    }
    const plain = createEvent.keyDown(sendNow, { key: "Enter" });
    fireEvent(sendNow, plain);
    expect(plain.defaultPrevented).toBe(false);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("falls back to a plain Send for a disabled variant whose spec says so", () => {
    const original = SEND_VARIANT_SPECS.aside.whenUnavailable;
    SEND_VARIANT_SPECS.aside.whenUnavailable = "send";
    try {
      const { textarea, onSend, onSendVariant } = renderComposer({ sendVariants: { aside: { enabled: false } } });
      type(textarea, "plain");
      asideShortcut(textarea);
      expect(onSend).toHaveBeenCalledWith("plain", undefined);
      expect(onSendVariant).not.toHaveBeenCalled();
      expect(screen.queryByRole("menu")).toBeNull();
    } finally {
      SEND_VARIANT_SPECS.aside.whenUnavailable = original;
    }
  });

  it("hands focus back to the textarea after a row is picked", async () => {
    const { chevron, textarea } = renderComposer({ sendVariants: ENABLED });
    type(textarea, "why?");
    fireEvent.click(chevron()!);
    fireEvent.keyDown(screen.getByRole("menuitem", { name: /Send now/ }), { key: "ArrowDown" });
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: /Send as aside/ }));
    });
    expect(document.activeElement).toBe(textarea);
  });

  it("does not focus the textarea after a row picked from a long-press menu (no phone keyboard)", async () => {
    vi.useFakeTimers();
    const { sendButton, textarea } = renderComposer({ sendVariants: ENABLED });
    type(textarea, "why?");
    textarea.blur();
    fireEvent.pointerDown(sendButton(), { pointerType: "touch", clientX: 5, clientY: 5 });
    act(() => vi.advanceTimersByTime(460));
    fireEvent.click(screen.getByRole("menuitem", { name: /Send as aside/ }));
    expect(document.activeElement).not.toBe(textarea);
  });

  it("lets a highlighted slash row's menu have the shortcut: it closes the menu, picks nothing and sends nothing", () => {
    const { textarea, onSendVariant, onSend } = renderComposer({ sendVariants: ENABLED });
    type(textarea, "/comp");
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    expect(screen.getByRole("option", { selected: true })).toBeTruthy();
    asideShortcut(textarea);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(textarea.value).toBe("/comp");
    expect(onSendVariant).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("lets an open $keyword menu have the shortcut: it dismisses the menu and sends nothing", () => {
    const keywords = [
      { name: "review", description: "", body: "Check the tests.", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    ];
    const { textarea, onSendVariant, onSend } = renderComposer({ sendVariants: ENABLED, keywords });
    type(textarea, "please $rev");
    expect(screen.getByTestId("keyword-autocomplete")).toBeTruthy();
    asideShortcut(textarea);
    expect(screen.queryByTestId("keyword-autocomplete")).toBeNull();
    expect(textarea.value).toBe("please $rev");
    expect(onSendVariant).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });
});
