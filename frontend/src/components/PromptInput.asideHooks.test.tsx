// @vitest-environment jsdom
/**
 * The composer's two hooks for Ask as aside: a read-only snapshot getter
 * (prompt as it would be sent, command chip included, and the attachments)
 * that leaves the text and caret alone, a remover for the attachments an
 * aside took, and a "leads with a command"
 * report that fires only when it changes — for a command chip, or text the
 * caller's rule recognises.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import PromptInput, { type ComposerSnapshot } from "./PromptInput";

vi.mock("../api", () => ({ getSlashCommandContent: vi.fn(async (name: string) => ({ name, source: "custom-skill", description: "", content: "" })) }));

afterEach(cleanup);

function renderComposer(props: Partial<React.ComponentProps<typeof PromptInput>> = {}) {
  let snapshot: (() => ComposerSnapshot) | null = null;
  let setValue: ((v: string) => void) | null = null;
  const onCommandLeadChange = vi.fn();
  render(
    <PromptInput
      onSend={vi.fn()}
      disabled={false}
      slashCommands={["compact"]}
      chatId="chat-1"
      onSnapshotRequest={(get) => {
        snapshot = get;
      }}
      onSetValue={(fn) => {
        setValue = (fn as unknown as () => (v: string) => void)();
      }}
      onCommandLeadChange={onCommandLeadChange}
      isCommandPrompt={(p) => /^\s*\/compact\b/.test(p)}
      {...props}
    />,
  );
  const textarea = screen.getByPlaceholderText("Send a message...") as HTMLTextAreaElement;
  return { snapshot: () => snapshot!(), setValue: (v: string) => act(() => setValue!(v)), textarea, onCommandLeadChange };
}

describe("PromptInput snapshot and command lead", () => {
  it("reads the prompt and attachment count without touching the text or caret", () => {
    const { snapshot, textarea } = renderComposer();
    fireEvent.change(textarea, { target: { value: "why this?  " } });
    textarea.setSelectionRange(3, 3);
    // The prompt as it would be sent (trimmed); the composer keeps its own text.
    expect(snapshot()).toEqual({ prompt: "why this?", attachments: 0, files: [] });
    expect(textarea.value).toBe("why this?  ");
    expect(textarea.selectionStart).toBe(3);
  });

  it("includes an active command chip in the prompt, and reports the lead only on change", () => {
    const { snapshot, setValue, textarea, onCommandLeadChange } = renderComposer();
    expect(onCommandLeadChange.mock.calls).toEqual([[false]]);
    fireEvent.change(textarea, { target: { value: "plain" } });
    fireEvent.change(textarea, { target: { value: "plain text" } });
    expect(onCommandLeadChange.mock.calls).toEqual([[false]]);

    // A command handed in becomes the chip: the lead is reported once.
    setValue("/compact keep the tests");
    expect(snapshot().prompt).toBe("/compact keep the tests");
    expect(onCommandLeadChange.mock.calls).toEqual([[false], [true]]);

    setValue("no command");
    expect(onCommandLeadChange.mock.calls.at(-1)).toEqual([false]);
  });

  it("reads the attachments, and removes exactly the files it is handed", () => {
    let add: ((files: File[]) => void) | null = null;
    let remove: ((files: File[]) => void) | null = null;
    const { snapshot } = renderComposer({
      onAddImages: (get) => {
        add = (get as unknown as () => (files: File[]) => void)();
      },
      onRemoveImages: (get) => {
        remove = (get as unknown as () => (files: File[]) => void)();
      },
    });
    const [a, b, c] = ["a.png", "b.png", "c.png"].map((name) => new File(["x"], name, { type: "image/png" }));
    act(() => add!([a!, b!]));
    const taken = snapshot();
    expect(taken).toMatchObject({ attachments: 2, files: [a, b] });
    // A copy: changing it changes nothing in the composer.
    taken.files.pop();
    expect(snapshot().files).toEqual([a, b]);
    // Attached while the aside was out: stays when the sent ones are removed.
    act(() => add!([c!]));
    act(() => remove!([a!, b!]));
    expect(snapshot().files).toEqual([c]);
  });

  it("unregisters the snapshot on unmount", () => {
    let snapshot: unknown = "unset";
    const { unmount } = render(
      <PromptInput
        onSend={vi.fn()}
        disabled={false}
        onSnapshotRequest={(get) => {
          snapshot = get;
        }}
      />,
    );
    expect(snapshot).toBeTypeOf("function");
    unmount();
    expect(snapshot).toBeNull();
  });
});
