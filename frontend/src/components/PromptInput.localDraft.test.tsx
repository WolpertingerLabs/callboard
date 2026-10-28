// @vitest-environment jsdom
/**
 * Unsent composer text is kept per chat, in localStorage, until it is sent.
 *
 * The composer is not remounted when the page moves between chats — Chat.tsx
 * changes `draftKey` under the same instance — so what these pin is the swap:
 * the outgoing chat's text is saved under the outgoing key, the incoming
 * chat's own text (or nothing) replaces it, and no write in between lands one
 * chat's text under the other's key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import PromptInput, { DRAFT_SAVE_DELAY_MS } from "./PromptInput";
import { getComposerDraft, saveComposerDraft } from "../utils/localStorage";

vi.mock("../api", () => ({ getSlashCommandContent: vi.fn(async (name: string) => ({ name, source: "custom-skill", content: "" })) }));

const COMMANDS = ["compact", "model"];
/** The composer's external setter, updater form included. */
let latestSetter: ((v: string | ((cur: string) => string)) => void) | null = null;

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  localStorage.clear();
});

function renderComposer(props: Partial<React.ComponentProps<typeof PromptInput>> = {}) {
  const onSend = vi.fn();
  let setValue: ((v: string) => void) | null = null;
  const baseProps: React.ComponentProps<typeof PromptInput> = {
    onSend,
    disabled: false,
    slashCommands: COMMANDS,
    draftKey: "chat-a",
    onSetValue: (fn) => {
      setValue = (fn as unknown as () => (v: string) => void)();
      latestSetter = setValue as unknown as typeof latestSetter;
    },
    ...props,
  };
  let current = baseProps;
  const view = render(<PromptInput {...baseProps} />);
  const textarea = () => screen.getByPlaceholderText("Send a message...") as HTMLTextAreaElement;
  return {
    onSend,
    textarea,
    type: (text: string) => fireEvent.change(textarea(), { target: { value: text } }),
    setValue: (v: string) => act(() => setValue!(v)),
    rerender: (next: Partial<React.ComponentProps<typeof PromptInput>>) => {
      current = { ...current, ...next };
      act(() => view.rerender(<PromptInput {...current} />));
    },
    unmount: () => view.unmount(),
  };
}

const settle = () => act(() => vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS));

describe("composer draft persistence", () => {
  it("saves typed text under the chat's key after the debounce", () => {
    const c = renderComposer();
    c.type("half a thought");
    expect(getComposerDraft("chat-a")).toBe("");
    settle();
    expect(getComposerDraft("chat-a")).toBe("half a thought");
  });

  it("restores a chat's draft on mount (a reload)", () => {
    saveComposerDraft("chat-a", "from before the reload");
    const c = renderComposer();
    expect(c.textarea().value).toBe("from before the reload");
  });

  it("A → B → A shows each chat's own text, never the other's", () => {
    saveComposerDraft("chat-b", "b's draft");
    const c = renderComposer();
    c.type("a's draft");
    // Switch inside the debounce: A's pending write must still land on A.
    c.rerender({ draftKey: "chat-b" });
    expect(c.textarea().value).toBe("b's draft");
    expect(getComposerDraft("chat-a")).toBe("a's draft");

    c.type("b's draft, edited");
    c.rerender({ draftKey: "chat-a" });
    expect(c.textarea().value).toBe("a's draft");
    settle();
    expect(getComposerDraft("chat-a")).toBe("a's draft");
    expect(getComposerDraft("chat-b")).toBe("b's draft, edited");
  });

  it("switching to a chat with no draft empties the composer and leaves the new key unwritten", () => {
    const c = renderComposer();
    c.type("only for a");
    c.rerender({ draftKey: "chat-c" });
    expect(c.textarea().value).toBe("");
    settle();
    expect(getComposerDraft("chat-c")).toBe("");
    expect(getComposerDraft("chat-a")).toBe("only for a");
  });

  it("clears the draft when the message is sent, without waiting for the debounce", () => {
    saveComposerDraft("chat-a", "send me");
    const c = renderComposer();
    fireEvent.keyDown(c.textarea(), { key: "Enter" });
    expect(c.onSend).toHaveBeenCalledWith("send me", undefined);
    expect(getComposerDraft("chat-a")).toBe("");
    expect(localStorage.getItem("callboard-composer-drafts")).toBeNull();
  });

  it("removes the key when the text is emptied by hand", () => {
    saveComposerDraft("chat-a", "x");
    saveComposerDraft("chat-b", "keep me");
    const c = renderComposer();
    c.type("");
    expect(getComposerDraft("chat-a")).toBe("");
    expect(getComposerDraft("chat-b")).toBe("keep me");
  });

  it("text put back into the composer (a failed send restored) is saved again", () => {
    const c = renderComposer();
    c.type("retry me");
    fireEvent.keyDown(c.textarea(), { key: "Enter" });
    expect(getComposerDraft("chat-a")).toBe("");
    c.setValue("retry me");
    settle();
    expect(getComposerDraft("chat-a")).toBe("retry me");
  });

  it("a stored command comes back as a chip, and round-trips through send", () => {
    saveComposerDraft("chat-b", "/model opus");
    const c = renderComposer();
    c.rerender({ draftKey: "chat-b" });
    expect(screen.getByText("/model")).toBeTruthy();
    expect(c.textarea().value).toBe("opus");
    fireEvent.keyDown(c.textarea(), { key: "Enter" });
    expect(c.onSend).toHaveBeenCalledWith("/model opus", undefined);
  });

  it("a command restored before the command list arrives still chips", () => {
    saveComposerDraft("chat-a", "/compact");
    const c = renderComposer({ slashCommands: [] });
    expect(c.textarea().value).toBe("/compact");
    c.rerender({ slashCommands: COMMANDS });
    expect(screen.getByText("/compact")).toBeTruthy();
    expect(c.textarea().value).toBe("");
    settle();
    expect(getComposerDraft("chat-a")).toBe("/compact");
  });

  it("a value set from outside (an opened server draft) replaces the local one and is what gets kept", () => {
    saveComposerDraft("chat-a", "local scribble");
    const c = renderComposer();
    c.setValue("the saved server draft");
    expect(c.textarea().value).toBe("the saved server draft");
    settle();
    expect(getComposerDraft("chat-a")).toBe("the saved server draft");
  });

  it("flushes a pending write on unmount", () => {
    const c = renderComposer();
    c.type("leaving now");
    c.unmount();
    expect(getComposerDraft("chat-a")).toBe("leaving now");
  });

  it("flushes a pending write when the page is hidden", () => {
    const c = renderComposer();
    c.type("tab closing");
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(getComposerDraft("chat-a")).toBe("tab closing");
  });

  it("viewing a chat does not rewrite its draft (no timestamp bump)", () => {
    saveComposerDraft("chat-a", "untouched", 1_000);
    saveComposerDraft("chat-b", "also untouched", 2_000);
    const c = renderComposer();
    settle();
    c.rerender({ draftKey: "chat-b" });
    settle();
    const stored = JSON.parse(localStorage.getItem("callboard-composer-drafts")!);
    expect(stored["chat-a"].at).toBe(1_000);
    expect(stored["chat-b"].at).toBe(2_000);
  });

  it("an edit reverted back to the loaded text is still saved", () => {
    saveComposerDraft("chat-a", "x");
    const c = renderComposer();
    c.type("xy");
    settle();
    expect(getComposerDraft("chat-a")).toBe("xy");
    c.type("x");
    settle();
    expect(getComposerDraft("chat-a")).toBe("x");
  });

  describe("paused (a server draft holds the composer, or a new chat's first send is in flight)", () => {
    /** Mount paused on chat-a and hand in an opened server draft, the way Chat.tsx's prefill does. */
    function openServerDraft(text = "the server draft") {
      const c = renderComposer({ draftPaused: true });
      c.setValue(text);
      return c;
    }

    it("mounting paused shows the handed-in draft, not the chat's stored text", () => {
      saveComposerDraft("chat-a", "a's own");
      const c = renderComposer({ draftPaused: true });
      expect(c.textarea().value).toBe("");
      c.setValue("the server draft");
      expect(c.textarea().value).toBe("the server draft");
    });

    it("pausing keeps what is on screen and flushes the key's own pending text", () => {
      const c = renderComposer();
      c.type("typed in a");
      c.rerender({ draftPaused: true });
      expect(c.textarea().value).toBe("typed in a");
      expect(getComposerDraft("chat-a")).toBe("typed in a");
    });

    it("persists nothing while paused, and leaves the chat's own kept text alone", () => {
      saveComposerDraft("chat-a", "a's own");
      const c = openServerDraft();
      c.type("the server draft, edited");
      settle();
      expect(c.textarea().value).toBe("the server draft, edited");
      expect(getComposerDraft("chat-a")).toBe("a's own");
    });

    it("resuming after a send with nothing typed brings the chat's own kept text back", () => {
      saveComposerDraft("chat-a", "a's own");
      const c = openServerDraft();
      fireEvent.keyDown(c.textarea(), { key: "Enter" });
      expect(c.onSend).toHaveBeenCalledWith("the server draft", undefined);
      c.rerender({ draftPaused: false });
      expect(c.textarea().value).toBe("a's own");
      expect(getComposerDraft("chat-a")).toBe("a's own");
    });

    it("a follow-up typed while the draft's send was in flight survives the resume and is saved", () => {
      saveComposerDraft("chat-a", "a's own, older");
      const c = openServerDraft();
      fireEvent.keyDown(c.textarea(), { key: "Enter" });
      c.type("the follow-up");
      c.rerender({ draftPaused: false });
      expect(c.textarea().value).toBe("the follow-up");
      settle();
      expect(getComposerDraft("chat-a")).toBe("the follow-up");
    });

    it("an edited draft is the user's: it stays when the hold is released in place, and is saved", () => {
      saveComposerDraft("chat-a", "a's own");
      const c = openServerDraft();
      c.type("the server draft, edited");
      c.rerender({ draftPaused: false });
      expect(c.textarea().value).toBe("the server draft, edited");
      settle();
      expect(getComposerDraft("chat-a")).toBe("the server draft, edited");
    });

    it("an untouched draft gives way to the chat's own text when the hold is released in place", () => {
      saveComposerDraft("chat-a", "a's own");
      const c = openServerDraft();
      c.rerender({ draftPaused: false });
      expect(c.textarea().value).toBe("a's own");
      settle();
      expect(getComposerDraft("chat-a")).toBe("a's own");
    });

    it("leaving an untouched draft for another chat shows that chat's text and stores the draft nowhere", () => {
      saveComposerDraft("chat-b", "b's own");
      const c = openServerDraft();
      // Chat.tsx moves the key first and releases the hold a commit later.
      c.rerender({ draftKey: "chat-b" });
      expect(c.textarea().value).toBe("b's own");
      c.rerender({ draftPaused: false });
      expect(c.textarea().value).toBe("b's own");
      settle();
      expect(getComposerDraft("chat-a")).toBe("");
      expect(getComposerDraft("chat-b")).toBe("b's own");
    });

    it("leaving with a follow-up typed during the pause saves it under the chat it was typed in, not the next one", () => {
      const c = openServerDraft();
      fireEvent.keyDown(c.textarea(), { key: "Enter" });
      c.type("typed in a");
      c.rerender({ draftKey: "chat-b" });
      expect(c.textarea().value).toBe("");
      c.rerender({ draftPaused: false });
      settle();
      expect(getComposerDraft("chat-a")).toBe("typed in a");
      expect(getComposerDraft("chat-b")).toBe("");
    });

    it("a click building on the draft (updater form) does not move the baseline", () => {
      const c = openServerDraft();
      act(() => latestSetter!((cur: string) => `${cur} plus a chip`));
      c.rerender({ draftPaused: false });
      expect(c.textarea().value).toBe("the server draft plus a chip");
    });

    it("pausing for an in-flight new-chat send settles the slot as emptied by that send", () => {
      saveComposerDraft("new", "start the chat");
      const c = renderComposer({ draftKey: "new" });
      // Send and pause land in one commit, as Chat.tsx's setStreaming does.
      fireEvent.keyDown(c.textarea(), { key: "Enter" });
      c.rerender({ draftPaused: true });
      expect(getComposerDraft("new")).toBe("");
      c.rerender({ draftKey: "chat-new-id", draftPaused: false });
      expect(c.textarea().value).toBe("");
      settle();
      expect(localStorage.getItem("callboard-composer-drafts")).toBeNull();
    });
  });

  it("persists nothing without a draftKey", () => {
    const c = renderComposer({ draftKey: undefined });
    c.type("ephemeral");
    settle();
    expect(localStorage.getItem("callboard-composer-drafts")).toBeNull();
  });
});

describe("saveComposerDraft bounds", () => {
  it("keeps the most recently written drafts past the cap", async () => {
    const { COMPOSER_DRAFTS_MAX } = await import("../utils/localStorage");
    for (let i = 0; i <= COMPOSER_DRAFTS_MAX; i++) saveComposerDraft(`chat-${i}`, `draft ${i}`, 1_000 + i);
    expect(getComposerDraft("chat-0")).toBe("");
    expect(getComposerDraft("chat-1")).toBe("draft 1");
    expect(getComposerDraft(`chat-${COMPOSER_DRAFTS_MAX}`)).toBe(`draft ${COMPOSER_DRAFTS_MAX}`);
  });

  it("drops drafts untouched past the max age on the next write", async () => {
    const { COMPOSER_DRAFT_MAX_AGE_MS } = await import("../utils/localStorage");
    saveComposerDraft("stale", "old", 0);
    saveComposerDraft("fresh", "new", COMPOSER_DRAFT_MAX_AGE_MS + 1);
    expect(getComposerDraft("stale")).toBe("");
    expect(getComposerDraft("fresh")).toBe("new");
  });

  it("ignores a malformed store", () => {
    localStorage.setItem("callboard-composer-drafts", '{"a": 3, "b": {"text": "ok", "at": 1}}');
    expect(getComposerDraft("a")).toBe("");
    expect(getComposerDraft("b")).toBe("ok");
    localStorage.setItem("callboard-composer-drafts", "not json");
    expect(getComposerDraft("b")).toBe("");
  });
});
