// @vitest-environment jsdom
/**
 * The read-aloud speaker in a bubble's hover row, and the inline player under
 * the bubble it is reading. Like the other hover affordances, the reveal rule
 * in index.css matches a DIRECT child of `.msg-bubble`, so structure is
 * asserted here; jsdom applies no stylesheet.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READ_ALOUD_NOT_CONFIGURED_MESSAGE } from "shared/types/readAloud.js";
import { appendAttachmentBlocks, formatAttachmentBlock } from "shared/types/index.js";
import type { ParsedMessage, SynthesizedSpeech } from "../api";
import { installMediaStubs } from "../testing/mediaStubs";
import { getReadAloudAudioForTesting, getSnapshot, resetReadAloudPlayerForTesting } from "../utils/readAloudPlayer";
import MessageBubble from "./MessageBubble";

const synth = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../api", () => ({ synthesizeSpeech: (...args: unknown[]) => synth.fn(...args) }));

const counts = vi.hoisted(() => ({ markdown: new Map<string, number>() }));
vi.mock("./MarkdownRenderer", () => ({
  default: ({ content }: { content: string }) => {
    counts.markdown.set(content, (counts.markdown.get(content) ?? 0) + 1);
    return <div>{content}</div>;
  },
}));

const AVAILABLE = { available: true };
const UNAVAILABLE = { available: false, reason: READ_ALOUD_NOT_CONFIGURED_MESSAGE };
const TS = "2026-01-01T00:00:00.000Z";
const reply: ParsedMessage = { role: "assistant", type: "text", content: "A reply worth hearing.", timestamp: TS } as ParsedMessage;
const prompt: ParsedMessage = { role: "user", type: "text", content: "A question?", timestamp: TS } as ParsedMessage;

const speech = (): SynthesizedSpeech => ({ blob: new Blob(["mp3"]), model: "m", voice: null, truncated: false });

beforeEach(() => {
  installMediaStubs();
  synth.fn.mockReset().mockResolvedValue(speech());
  counts.markdown.clear();
  resetReadAloudPlayerForTesting();
});
afterEach(() => {
  cleanup();
  act(() => resetReadAloudPlayerForTesting());
});

const speaker = () => screen.getByRole("button", { name: "Read aloud" });
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

describe("which bubbles get the speaker", () => {
  it.each([
    ["an assistant reply", reply],
    ["a user prompt", prompt],
    ["a team (subagent) message", { ...reply, teamName: "researcher" } as ParsedMessage],
  ])("%s", (_label, message) => {
    const { container } = render(<MessageBubble message={message} teamColorMap={new Map([["researcher", 0]])} readAloud={AVAILABLE} />);
    expect(speaker()).toBeTruthy();
    expect(container.querySelector(".msg-bubble")!.querySelector(":scope > .read-aloud-affordance")).toBe(speaker());
  });

  it.each([
    ["tool_use", { role: "assistant", type: "tool_use", content: '{"command":"ls"}', toolName: "Bash", timestamp: TS }],
    ["tool_result", { role: "user", type: "tool_result", content: "out", toolName: "Bash", timestamp: TS }],
    ["thinking", { role: "assistant", type: "thinking", content: "hmm", timestamp: TS }],
    ["system", { role: "system", type: "system", content: "Compacted", timestamp: TS }],
    ["agent_message", { role: "system", type: "system", subtype: "agent_message", content: "hi", timestamp: TS }],
    [
      "todo list",
      { role: "assistant", type: "tool_use", toolName: "TodoWrite", content: JSON.stringify({ todos: [{ content: "a", status: "pending" }] }), timestamp: TS },
    ],
    ["built-in command", { role: "user", type: "text", content: "/compact", isBuiltInCommand: true, timestamp: TS }],
    ["an empty text bubble", { role: "assistant", type: "text", content: "   ", timestamp: TS }],
  ])("not on %s", (_label, message) => {
    render(<MessageBubble message={message as ParsedMessage} readAloud={AVAILABLE} />);
    expect(screen.queryByRole("button", { name: "Read aloud" })).toBeNull();
  });

  it("not without the readAloud prop (system-info not loaded yet)", () => {
    render(<MessageBubble message={reply} />);
    expect(screen.queryByRole("button", { name: "Read aloud" })).toBeNull();
  });

  it("reads a user prompt's typed text, not its attached-file blocks", () => {
    const withFile = {
      ...prompt,
      content: appendAttachmentBlocks("Look at this.", [
        formatAttachmentBlock({ id: "f1", name: "a.md", path: "/d/f1_a.md", size: 3, mimeType: "text/markdown" }, { content: "# secret body" }),
      ]),
    } as ParsedMessage;
    render(<MessageBubble message={withFile} readAloud={AVAILABLE} />);
    fireEvent.click(speaker());
    expect(synth.fn.mock.calls[0][0]).toBe("Look at this.");
  });
});

describe("slots", () => {
  const right = (el: HTMLElement) => el.style.right;

  it("takes slot 1 after copy when there is no fork or star", () => {
    render(<MessageBubble message={reply} readAloud={AVAILABLE} />);
    expect(right(speaker())).toBe("36px");
  });

  it("follows fork", () => {
    render(<MessageBubble message={reply} onFork={vi.fn()} readAloud={AVAILABLE} />);
    expect(right(speaker())).toBe("66px");
  });

  it("follows star, and widens a narrow reply to fit the whole row", () => {
    const { container } = render(<MessageBubble message={reply} onFork={vi.fn()} starKey="k" onToggleStar={vi.fn()} readAloud={AVAILABLE} />);
    expect(right(screen.getByRole("button", { name: "Star message" }))).toBe("66px");
    expect(right(speaker())).toBe("96px");
    // edge 6 + 4 slots × 30
    expect((container.querySelector(".msg-bubble") as HTMLElement).style.minWidth).toBe("126px");
  });

  it("sits at slot 1 on a team bubble, which is widened to fit", () => {
    const { container } = render(
      <MessageBubble message={{ ...reply, teamName: "r" } as ParsedMessage} teamColorMap={new Map([["r", 0]])} readAloud={AVAILABLE} />,
    );
    expect(right(speaker())).toBe("36px");
    expect((container.querySelector(".msg-bubble") as HTMLElement).style.minWidth).toBe("66px");
  });
});

describe("the speaker", () => {
  it("is aria-disabled with the key tooltip when read aloud is unavailable, and does nothing", () => {
    render(<MessageBubble message={reply} readAloud={UNAVAILABLE} />);
    const button = speaker();
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("title")).toBe(READ_ALOUD_NOT_CONFIGURED_MESSAGE);
    fireEvent.click(button);
    expect(synth.fn).not.toHaveBeenCalled();
  });

  it("starts, shows the player under that bubble only, and stops on a second click", async () => {
    const { container } = render(
      <>
        <MessageBubble message={reply} readAloud={AVAILABLE} />
        <MessageBubble message={prompt} readAloud={AVAILABLE} />
      </>,
    );
    const [first] = screen.getAllByRole("button", { name: "Read aloud" });
    fireEvent.click(first);
    expect(synth.fn).toHaveBeenCalledWith("A reply worth hearing.", expect.any(AbortSignal));
    await flush();

    const players = container.querySelectorAll(".read-aloud-player");
    expect(players).toHaveLength(1);
    // Under the reply's bubble, outside it (the hover row stays the bubble's own).
    expect(players[0].previousElementSibling?.textContent).toContain("A reply worth hearing.");
    const stopButton = screen.getByRole("button", { name: "Stop reading aloud" });
    expect(stopButton.classList.contains("is-active")).toBe(true);
    fireEvent.click(stopButton);
    expect(getSnapshot().status).toBe("idle");
    expect(container.querySelector(".read-aloud-player")).toBeNull();
  });

  it("starting another bubble moves the player there", async () => {
    const { container } = render(
      <>
        <MessageBubble message={reply} readAloud={AVAILABLE} />
        <MessageBubble message={prompt} readAloud={AVAILABLE} />
      </>,
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Read aloud" })[0]);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Read aloud" }));
    await flush();
    const players = container.querySelectorAll(".read-aloud-player");
    expect(players).toHaveLength(1);
    expect(players[0].previousElementSibling?.textContent).toContain("A question?");
  });

  it("cancels while loading", () => {
    synth.fn.mockReturnValueOnce(new Promise(() => {}));
    render(<MessageBubble message={reply} readAloud={AVAILABLE} />);
    fireEvent.click(speaker());
    expect(getSnapshot().status).toBe("loading");
    const signal = synth.fn.mock.calls[0][1] as AbortSignal;
    fireEvent.click(screen.getByRole("button", { name: "Stop reading aloud" }));
    expect(signal.aborted).toBe(true);
    expect(getSnapshot().status).toBe("idle");
  });

  it("stops when its bubble unmounts", async () => {
    const { unmount } = render(<MessageBubble message={reply} readAloud={AVAILABLE} />);
    fireEvent.click(speaker());
    await flush();
    expect(getSnapshot().status).toBe("playing");
    unmount();
    expect(getSnapshot().status).toBe("idle");
  });
});

describe("re-render containment", () => {
  /** A Chat-shaped parent: identity-stable props, re-rendered by a composer. */
  function Harness() {
    const [draft, setDraft] = useState("");
    return (
      <>
        <textarea aria-label="composer" value={draft} onChange={(e) => setDraft(e.target.value)} />
        <MessageBubble message={reply} readAloud={AVAILABLE} />
        <MessageBubble message={prompt} readAloud={AVAILABLE} />
      </>
    );
  }

  it("timeupdate re-renders neither bubble body, only the owner's player", async () => {
    render(<Harness />);
    fireEvent.click(screen.getAllByRole("button", { name: "Read aloud" })[0]);
    await flush();
    const ownerBefore = counts.markdown.get(reply.content);
    const otherBefore = counts.markdown.get(prompt.content);

    const audio = getReadAloudAudioForTesting()!;
    for (const t of [1, 2, 3]) {
      act(() => {
        audio.currentTime = t;
        audio.dispatchEvent(new Event("timeupdate"));
      });
    }
    expect(screen.getByText("0:03 / 1:00")).toBeTruthy();
    expect(counts.markdown.get(reply.content)).toBe(ownerBefore);
    expect(counts.markdown.get(prompt.content)).toBe(otherBefore);

    // And the bubbles stay memoized against parent re-renders.
    fireEvent.change(screen.getByLabelText("composer"), { target: { value: "x" } });
    expect(counts.markdown.get(reply.content)).toBe(ownerBefore);
  });
});
