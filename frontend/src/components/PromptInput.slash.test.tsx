// @vitest-environment jsdom
/**
 * Keyboard navigation of the composer's `/` command menu.
 *
 * The contract, and the one asymmetry with the `$keyword` menu
 * (`PromptInput.keyword.test.tsx`): nothing is highlighted until the user
 * arrows or points at a row, so Enter on an untouched menu keeps doing what it
 * always did — dismiss, without sending. Once a row is highlighted, Enter and
 * forward Tab pick it into a chip. The arrows only belong to the menu while it
 * has rows; otherwise they are the textarea's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import PromptInput from "./PromptInput";
import { matchSlashCommands } from "../utils/commands";

vi.mock("../api", () => ({
  getSlashCommandContent: vi.fn(async (name: string) => ({ name, source: "custom-skill", description: "", content: "" })),
  createKeyword: vi.fn(),
}));

const COMMANDS = ["callboard:foo", "compact", "context", "model"];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderComposer(props: Partial<React.ComponentProps<typeof PromptInput>> = {}) {
  const onSend = vi.fn();
  render(<PromptInput onSend={onSend} disabled={false} slashCommands={COMMANDS} {...props} />);
  const textarea = screen.getByPlaceholderText("Send a message...") as HTMLTextAreaElement;
  return { onSend, textarea };
}

function type(textarea: HTMLTextAreaElement, text: string) {
  fireEvent.change(textarea, { target: { value: text } });
}

/** Fire a key and report whether the composer claimed it (see the keyword test's twin). */
function keyDown(textarea: HTMLTextAreaElement, init: Parameters<typeof createEvent.keyDown>[1]) {
  const event = createEvent.keyDown(textarea, init);
  fireEvent(textarea, event);
  return { prevented: event.defaultPrevented };
}

const menu = () => screen.queryByTestId("slash-command-autocomplete");
const options = () => screen.queryAllByRole("option");
const highlighted = () => options().filter((o) => o.getAttribute("aria-selected") === "true");
const chip = (name: string) => screen.queryByRole("button", { name: `/${name}` });

describe("matchSlashCommands", () => {
  it("ranks prefix matches first, then alphabetically, and caps the list", () => {
    expect(matchSlashCommands(["xcon", "context", "compact", "model"], "/con")).toEqual(["context", "xcon"]);
    expect(matchSlashCommands(["b", "a", "c"], "/")).toEqual(["a", "b", "c"]);
    const many = Array.from({ length: 15 }, (_, i) => `cmd-${String(i).padStart(2, "0")}`);
    expect(matchSlashCommands(many, "/cmd")).toHaveLength(10);
  });

  it("matches nothing without a leading slash, or once prose follows the command", () => {
    expect(matchSlashCommands(COMMANDS, "compact")).toEqual([]);
    expect(matchSlashCommands(COMMANDS, "/compact now")).toEqual([]);
  });
});

describe("arrow keys move a highlight through the / menu", () => {
  it("highlights nothing until an arrow is pressed", () => {
    const { textarea } = renderComposer();
    type(textarea, "/co");
    expect(options()).toHaveLength(2);
    expect(highlighted()).toHaveLength(0);
    expect(textarea.getAttribute("aria-activedescendant")).toBeNull();
  });

  it("ArrowDown starts at the first row, ArrowUp at the last, and both wrap", () => {
    const { textarea } = renderComposer();
    type(textarea, "/");

    expect(keyDown(textarea, { key: "ArrowDown" }).prevented).toBe(true);
    expect(highlighted()[0].textContent).toContain("callboard:foo");
    keyDown(textarea, { key: "ArrowUp" });
    // Wrapped from the first row to the last.
    expect(highlighted()[0].textContent).toContain("model");
    keyDown(textarea, { key: "ArrowDown" });
    expect(highlighted()[0].textContent).toContain("callboard:foo");

    // A fresh menu: ArrowUp from "nothing" lands on the last row.
    type(textarea, "/co");
    keyDown(textarea, { key: "ArrowUp" });
    expect(highlighted()[0].textContent).toContain("context");
  });

  it("points aria-activedescendant at the highlighted option", () => {
    const { textarea } = renderComposer();
    type(textarea, "/");
    keyDown(textarea, { key: "ArrowDown" });
    keyDown(textarea, { key: "ArrowDown" });

    const active = textarea.getAttribute("aria-activedescendant");
    expect(active).toBeTruthy();
    expect(document.getElementById(active!)?.textContent).toContain("compact");
    expect(textarea.getAttribute("aria-controls")).toBe(screen.getByRole("listbox").id);
  });

  it("resets the highlight when the query changes", () => {
    const { textarea } = renderComposer();
    type(textarea, "/");
    keyDown(textarea, { key: "ArrowDown" });
    keyDown(textarea, { key: "ArrowDown" });
    type(textarea, "/c");
    expect(highlighted()).toHaveLength(0);
  });

  it("leaves the arrows to the textarea when no menu is showing", () => {
    const { textarea } = renderComposer();
    type(textarea, "hello\nworld");
    expect(keyDown(textarea, { key: "ArrowUp" }).prevented).toBe(false);
    expect(keyDown(textarea, { key: "ArrowDown" }).prevented).toBe(false);

    // `/`-led, but past the command into prose: no rows, so no menu to drive.
    type(textarea, "/compact please\nnow");
    expect(menu()).toBeNull();
    expect(keyDown(textarea, { key: "ArrowUp" }).prevented).toBe(false);

    // Dismissed with Escape: the arrows are the textarea's again.
    type(textarea, "/co");
    keyDown(textarea, { key: "Escape" });
    expect(menu()).toBeNull();
    expect(keyDown(textarea, { key: "ArrowDown" }).prevented).toBe(false);
  });

  it("follows the pointer, so the mouse and the keyboard share one highlight", () => {
    const { textarea } = renderComposer();
    type(textarea, "/co");
    fireEvent.mouseMove(screen.getByText("context"));
    expect(highlighted()[0].textContent).toContain("context");

    // The arrows continue from where the pointer left the highlight.
    keyDown(textarea, { key: "ArrowUp" });
    expect(highlighted()[0].textContent).toContain("compact");
  });
});

describe("Enter and Tab on the / menu", () => {
  it("Enter picks the highlighted row into a chip, without sending", () => {
    const { textarea, onSend } = renderComposer();
    type(textarea, "/co");
    keyDown(textarea, { key: "ArrowDown" });
    keyDown(textarea, { key: "ArrowDown" });

    expect(keyDown(textarea, { key: "Enter" }).prevented).toBe(true);
    expect(chip("context")).toBeTruthy();
    expect(textarea.value).toBe("");
    expect(menu()).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("Enter with nothing highlighted dismisses without sending, as it always has", () => {
    const { textarea, onSend } = renderComposer();
    type(textarea, "/compact");

    expect(keyDown(textarea, { key: "Enter" }).prevented).toBe(true);
    expect(menu()).toBeNull();
    expect(chip("compact")).toBeNull();
    expect(onSend).not.toHaveBeenCalled();

    keyDown(textarea, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("/compact", undefined);
  });

  it("Shift+Enter is never a pick", () => {
    const { textarea } = renderComposer();
    type(textarea, "/co");
    keyDown(textarea, { key: "ArrowDown" });
    expect(keyDown(textarea, { key: "Enter", shiftKey: true }).prevented).toBe(false);
    expect(chip("compact")).toBeNull();
  });

  it("forward Tab picks the highlighted row; otherwise Tab is left to move focus", () => {
    const { textarea } = renderComposer();
    type(textarea, "/co");
    expect(keyDown(textarea, { key: "Tab" }).prevented).toBe(false);

    keyDown(textarea, { key: "ArrowDown" });
    expect(keyDown(textarea, { key: "Tab", shiftKey: true }).prevented).toBe(false);
    expect(chip("compact")).toBeNull();

    expect(keyDown(textarea, { key: "Tab" }).prevented).toBe(true);
    expect(chip("compact")).toBeTruthy();
  });
});

describe("the highlighted / row is kept on screen", () => {
  const TWELVE = Array.from({ length: 12 }, (_, i) => `cmd-${String(i).padStart(2, "0")}`);
  const scrollIntoView = vi.fn();
  beforeEach(() => {
    Object.defineProperty(Element.prototype, "scrollIntoView", { value: scrollIntoView, writable: true, configurable: true });
  });
  afterEach(() => {
    delete (Element.prototype as Partial<Element>).scrollIntoView;
  });

  it("scrolls the row the arrow keys land on into view", () => {
    const { textarea } = renderComposer({ slashCommands: TWELVE });
    type(textarea, "/");
    scrollIntoView.mockClear();

    keyDown(textarea, { key: "ArrowUp" });

    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    const scrolled = scrollIntoView.mock.instances.at(-1) as HTMLElement;
    // Capped at ten rows, so the last one is cmd-09.
    expect(scrolled.textContent).toContain("cmd-09");
  });
});
