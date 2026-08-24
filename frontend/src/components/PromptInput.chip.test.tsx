// @vitest-environment jsdom
/**
 * A picked slash command stops being text and becomes a chip — but only the
 * *presentation* changes. What these tests pin is that boundary: the prompt
 * string leaving the composer is byte-identical to the one it produced when the
 * command was raw text, the user's prose is never collateral damage of picking
 * or dropping a chip, and a command that was never picked from the autocomplete
 * still travels as the literal text the user typed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import PromptInput, { composePrompt, parseLeadingCommand, stripLeadingCommandToken } from "./PromptInput";

// The chip popover fetches a body on first open; nothing here cares what it
// says, only that the composer's own bookkeeping survives the round trip.
const getSlashCommandContent = vi.fn(async (_chatId: string, name: string) => ({
  name,
  source: "custom-skill",
  description: `${name} description`,
  content: `body of ${name}`,
}));
vi.mock("../api", () => ({ getSlashCommandContent: (...args: [string, string]) => getSlashCommandContent(...args) }));

const COMMANDS = ["callboard:foo", "compact", "model"];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderComposer(props: Partial<React.ComponentProps<typeof PromptInput>> = {}) {
  const onSend = vi.fn();
  const onSaveDraft = vi.fn();
  let setValue: ((v: string) => void) | null = null;
  render(
    <PromptInput
      onSend={onSend}
      disabled={false}
      onSaveDraft={onSaveDraft}
      slashCommands={COMMANDS}
      chatId="chat-1"
      // PromptInput hands its setter out the way a React state setter takes
      // one: wrapped in an updater, so setState doesn't invoke it. Unwrap it
      // here exactly as Chat.tsx's useState setter would.
      onSetValue={(fn) => {
        setValue = (fn as unknown as () => (v: string) => void)();
      }}
      {...props}
    />,
  );
  const textarea = screen.getByPlaceholderText("Send a message...") as HTMLTextAreaElement;
  return { onSend, onSaveDraft, textarea, setValue: (v: string) => act(() => setValue!(v)) };
}

/**
 * Pick `command` out of the autocomplete, then type `prose`.
 *
 * The typed query is the command's own prefix because that is all the
 * autocomplete matches on — it filters against the whole textarea value, so
 * prose typed first would hide the list. Prose therefore arrives after the
 * pick, which is also the order a user works in.
 */
function pick(textarea: HTMLTextAreaElement, command: string, prose = "") {
  fireEvent.change(textarea, { target: { value: `/${command.split(":")[0]}` } });
  fireEvent.click(screen.getByText(command));
  if (prose) fireEvent.change(textarea, { target: { value: prose } });
}

const chip = (name: string) => screen.queryByRole("button", { name: `/${name}` });

describe("PromptInput prompt serialization", () => {
  it("re-emits exactly the string the composer used to produce", () => {
    expect(composePrompt("callboard:foo", "my text")).toBe("/callboard:foo my text");
    expect(composePrompt("compact", "")).toBe("/compact");
    expect(composePrompt("compact", "   ")).toBe("/compact");
    expect(composePrompt(null, "  my text ")).toBe("my text");
  });

  it("parses back only tokens that are known commands", () => {
    expect(parseLeadingCommand("/callboard:foo my text", COMMANDS)).toEqual({ command: "callboard:foo", rest: "my text" });
    expect(parseLeadingCommand("/compact", COMMANDS)).toEqual({ command: "compact", rest: "" });
    expect(parseLeadingCommand("/unknown my text", COMMANDS)).toEqual({ command: null, rest: "/unknown my text" });
    expect(parseLeadingCommand("plain text", COMMANDS)).toEqual({ command: null, rest: "plain text" });
  });

  it("takes only the leading token out of the textarea, never the prose behind it", () => {
    expect(stripLeadingCommandToken("/callboard")).toBe("");
    expect(stripLeadingCommandToken("/callboard my text")).toBe("my text");
    expect(stripLeadingCommandToken("/callboard  padded  text")).toBe(" padded  text");
  });
});

describe("PromptInput command chips", () => {
  it("chips the picked command and takes its token out of the textarea", () => {
    const { textarea } = renderComposer();

    pick(textarea, "callboard:foo");

    expect(chip("callboard:foo")).toBeTruthy();
    expect(textarea.value).toBe("");
  });

  it("sends the chip and the prose as one prompt string", () => {
    const { textarea, onSend } = renderComposer();

    pick(textarea, "callboard:foo", "my text");
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSend).toHaveBeenCalledWith("/callboard:foo my text", undefined);
    // Composer is empty again — chip included.
    expect(chip("callboard:foo")).toBeNull();
    expect(textarea.value).toBe("");
  });

  it("is sendable on the chip alone, for commands that take no argument", () => {
    const { textarea, onSend } = renderComposer();

    pick(textarea, "compact");
    expect(textarea.value).toBe("");

    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("/compact", undefined);
  });

  it("replaces the chip when a second command is picked", () => {
    const { textarea, onSend } = renderComposer();

    pick(textarea, "callboard:foo");
    pick(textarea, "model");

    expect(chip("callboard:foo")).toBeNull();
    expect(chip("model")).toBeTruthy();

    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("/model", undefined);
  });

  it("shows the replacement's body, not the body the previous chip cached", async () => {
    const { textarea } = renderComposer();

    pick(textarea, "callboard:foo");
    fireEvent.click(chip("callboard:foo")!);
    expect(await screen.findByText("body of callboard:foo")).toBeTruthy();

    pick(textarea, "model");
    fireEvent.click(chip("model")!);

    expect(await screen.findByText("body of model")).toBeTruthy();
    expect(screen.queryByText("body of callboard:foo")).toBeNull();
  });

  it("drops the chip from the popover's X and leaves the prose alone", async () => {
    const { textarea, onSend } = renderComposer();

    pick(textarea, "callboard:foo", "my text");
    fireEvent.click(chip("callboard:foo")!);
    fireEvent.click(await screen.findByTitle("Remove"));

    expect(chip("callboard:foo")).toBeNull();
    expect(textarea.value).toBe("my text");

    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("my text", undefined);
  });

  it("drops the chip on Backspace at the start of the prose", () => {
    const { textarea } = renderComposer();

    pick(textarea, "callboard:foo", "my text");
    textarea.setSelectionRange(0, 0);
    fireEvent.keyDown(textarea, { key: "Backspace" });

    expect(chip("callboard:foo")).toBeNull();
    expect(textarea.value).toBe("my text");
  });

  it("keeps the chip when Backspace lands mid-prose", () => {
    const { textarea } = renderComposer();

    pick(textarea, "callboard:foo", "my text");
    textarea.setSelectionRange(3, 3);
    fireEvent.keyDown(textarea, { key: "Backspace" });

    expect(chip("callboard:foo")).toBeTruthy();
  });

  it("round-trips a chipped prompt through a saved draft", () => {
    const { textarea, onSaveDraft, setValue } = renderComposer();

    pick(textarea, "callboard:foo", "my text");
    fireEvent.click(screen.getByTitle("More actions"));
    fireEvent.click(screen.getByText("Save as draft"));

    expect(onSaveDraft).toHaveBeenCalledWith("/callboard:foo my text", undefined, expect.any(Function));

    // Reloading that draft into the composer must show the chip again, not the
    // serialized text — otherwise the chip is a one-way door.
    setValue(onSaveDraft.mock.calls[0][0]);
    expect(chip("callboard:foo")).toBeTruthy();
    expect(textarea.value).toBe("my text");
  });

  it("leaves a value whose leading token is not a known command as literal text", () => {
    const { textarea, setValue } = renderComposer();

    setValue("/not-a-command still text");

    expect(chip("not-a-command")).toBeNull();
    expect(textarea.value).toBe("/not-a-command still text");
  });

  it("still sends a raw typed command verbatim, chips or no chips", () => {
    const { textarea, onSend } = renderComposer();

    fireEvent.change(textarea, { target: { value: "/foo" } });
    // First Enter dismisses the open autocomplete, second sends — unchanged.
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("/foo", undefined);
    expect(chip("callboard:foo")).toBeNull();
  });
});
