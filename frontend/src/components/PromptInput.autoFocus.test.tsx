// @vitest-environment jsdom
/**
 * The composer focuses itself when the chat it belongs to changes — opening a
 * chat, switching to another, opening the new-chat composer — but only on a
 * device with a keyboard. On a phone, focus raises the on-screen keyboard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import PromptInput from "./PromptInput";
import { NEW_CHAT_DRAFT_KEY, saveComposerDraft } from "../utils/localStorage";

vi.mock("../api", () => ({ getSlashCommandContent: vi.fn(async (name: string) => ({ name, source: "custom-skill", content: "" })) }));

/** Answer `(hover: hover) and (pointer: fine)` as a desktop (true) or a phone (false) would. */
function stubPointer(desktop: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: desktop && query.includes("pointer: fine"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

type ComposerProps = React.ComponentProps<typeof PromptInput>;

function renderComposer(props: Partial<ComposerProps> = {}) {
  let current: ComposerProps = { onSend: vi.fn(), disabled: false, draftKey: "chat-a", focusKey: "chat-a", ...props };
  const view = render(<PromptInput {...current} />);
  return {
    textarea: () => screen.getByPlaceholderText("Send a message...") as HTMLTextAreaElement,
    rerender: (next: Partial<ComposerProps>) => {
      current = { ...current, ...next };
      act(() => view.rerender(<PromptInput {...current} />));
    },
  };
}

describe("composer auto-focus", () => {
  it("focuses on opening a chat, on desktop", () => {
    stubPointer(true);
    const c = renderComposer();
    expect(document.activeElement).toBe(c.textarea());
  });

  it("puts the caret at the end of a restored draft", () => {
    stubPointer(true);
    saveComposerDraft("chat-a", "half a thought");
    const c = renderComposer();
    expect(document.activeElement).toBe(c.textarea());
    expect(c.textarea().selectionStart).toBe("half a thought".length);
    expect(c.textarea().selectionEnd).toBe("half a thought".length);
  });

  it("focuses again on switching chats, at the end of the incoming chat's draft", () => {
    stubPointer(true);
    saveComposerDraft("chat-b", "chat b's longer draft");
    const c = renderComposer();
    c.textarea().blur();
    c.rerender({ draftKey: "chat-b", focusKey: "chat-b" });
    expect(document.activeElement).toBe(c.textarea());
    expect(c.textarea().value).toBe("chat b's longer draft");
    expect(c.textarea().selectionStart).toBe("chat b's longer draft".length);
  });

  it("focuses on opening the new-chat composer", () => {
    stubPointer(true);
    const c = renderComposer({ draftKey: NEW_CHAT_DRAFT_KEY, focusKey: NEW_CHAT_DRAFT_KEY });
    expect(document.activeElement).toBe(c.textarea());
  });

  it("does not focus again for the same chat", () => {
    stubPointer(true);
    const c = renderComposer();
    c.textarea().blur();
    c.rerender({ disabled: true });
    c.rerender({ disabled: false });
    expect(document.activeElement).not.toBe(c.textarea());
  });

  it("does not focus on a touch device, on open or on switch", () => {
    stubPointer(false);
    const c = renderComposer();
    expect(document.activeElement).not.toBe(c.textarea());
    c.rerender({ draftKey: "chat-b", focusKey: "chat-b" });
    expect(document.activeElement).not.toBe(c.textarea());
  });

  it("does not focus where matchMedia is unavailable", () => {
    vi.stubGlobal("matchMedia", undefined);
    const c = renderComposer();
    expect(document.activeElement).not.toBe(c.textarea());
  });

  it("does not take focus from a field the user is typing in", () => {
    stubPointer(true);
    const other = document.createElement("input");
    document.body.appendChild(other);
    other.focus();
    try {
      renderComposer();
      expect(document.activeElement).toBe(other);
    } finally {
      other.remove();
    }
  });

  it("does take focus from the link that was clicked to get here", () => {
    stubPointer(true);
    const link = document.createElement("a");
    link.href = "/chat/chat-a";
    document.body.appendChild(link);
    link.focus();
    try {
      const c = renderComposer();
      expect(document.activeElement).toBe(c.textarea());
    } finally {
      link.remove();
    }
  });

  it("never focuses without a focusKey", () => {
    stubPointer(true);
    const c = renderComposer({ focusKey: undefined });
    expect(document.activeElement).not.toBe(c.textarea());
  });
});
