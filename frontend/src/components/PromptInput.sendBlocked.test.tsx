// @vitest-environment jsdom
/**
 * The composer can be told it must not send, and by whom.
 *
 * `disabled` already existed and is the wrong tool for this: it turns off the
 * textarea, the paperclip and paste-to-attach too, and the states this covers
 * are ones the user fixes *elsewhere* — the branch box above the composer —
 * while a half-written message sits in here. So the requirement is narrower
 * than `disabled` and stricter than doing nothing: the send must not fire, and
 * the draft must survive being blocked, because `handleSend` clears the
 * composer and a send the page then refuses would take the message with it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import PromptInput from "./PromptInput";

vi.mock("../api", () => ({ getSlashCommandContent: vi.fn() }));

afterEach(cleanup);

function renderComposer(props: Partial<React.ComponentProps<typeof PromptInput>> = {}) {
  const onSend = vi.fn();
  const base: React.ComponentProps<typeof PromptInput> = { onSend, disabled: false, ...props };
  const view = render(<PromptInput {...base} />);
  const textarea = screen.getByPlaceholderText("Send a message...") as HTMLTextAreaElement;
  // The send button carries an icon and no text; it is the one holding the
  // arrow-up glyph, which is also the thing the user aims at.
  const sendButton = () => view.container.querySelector("svg.lucide-arrow-up")!.closest("button") as HTMLButtonElement;
  return {
    onSend,
    textarea,
    sendButton,
    rerender: (next: Partial<React.ComponentProps<typeof PromptInput>>) => view.rerender(<PromptInput {...base} {...next} />),
  };
}

describe("a composer that is blocked from sending", () => {
  it("keeps the draft instead of sending it", () => {
    const { onSend, textarea, sendButton } = renderComposer({ sendBlockedReason: "The branch name above is not one git will accept." });

    fireEvent.change(textarea, { target: { value: "do the thing" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.click(sendButton());

    expect(onSend).not.toHaveBeenCalled();
    expect(textarea.value).toBe("do the thing");
    expect(sendButton().disabled).toBe(true);
  });

  it("sends that same draft once the reason goes away", () => {
    const { onSend, textarea, rerender, sendButton } = renderComposer({ sendBlockedReason: "not sendable" });

    fireEvent.change(textarea, { target: { value: "do the thing" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();

    rerender({ sendBlockedReason: undefined });

    expect(sendButton().disabled).toBe(false);
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("do the thing", undefined);
    expect(textarea.value).toBe("");
  });

  /**
   * The textarea stays live while blocked — the difference from `disabled`, and
   * the reason this prop exists rather than reusing it.
   */
  it("leaves the message editable while it is blocked", () => {
    const { textarea } = renderComposer({ sendBlockedReason: "not sendable" });

    expect(textarea.disabled).toBe(false);
    fireEvent.change(textarea, { target: { value: "still typing" } });
    expect(textarea.value).toBe("still typing");
  });
});
