// @vitest-environment jsdom
/**
 * Keyword expansion in the composer — the *interaction* half of the feature.
 * The trigger guards themselves are pinned in `utils/keywordTrigger.test.ts`;
 * what this file pins is what the keyboard does with them.
 *
 * The behaviour worth protecting is the Enter key. A dropdown that appears
 * unbidden and then swallows the Enter the user meant as "send" is the one
 * failure mode that would make this feature actively worse than nothing, so
 * there is a deliberate asymmetry: with a query typed, the first row is
 * highlighted and Enter inserts it; on a bare `$` nothing is highlighted and
 * Enter dismisses *without sending and without inserting*. Both halves are
 * tested, and so is the arrow-key path that converts one into the other.
 *
 * Also pinned: the keyword menu is plain text, never a chip, and the existing
 * chip mechanism is untouched by any of it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import PromptInput from "./PromptInput";
import type { Keyword } from "../api";

const getSlashCommandContent = vi.fn(async (name: string, _scope: unknown) => ({
  name,
  source: "custom-skill",
  description: `${name} description`,
  content: `body of ${name}`,
}));
const createKeyword = vi.fn();
vi.mock("../api", () => ({
  getSlashCommandContent: (...args: [string, unknown]) => getSlashCommandContent(...args),
  createKeyword: (...args: unknown[]) => createKeyword(...args),
}));

const COMMANDS = ["callboard:foo", "compact", "model"];

const kw = (name: string, body: string, description = ""): Keyword => ({
  name,
  description,
  body,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const KEYWORDS: Keyword[] = [
  kw("review", "Check the tests and the types.", "Review checklist"),
  kw("review-deep", "Read every call site.", "Thorough review"),
  kw("standup", "Yesterday:\nToday:\nBlockers:", "Standup template"),
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderComposer(props: Partial<React.ComponentProps<typeof PromptInput>> = {}) {
  const onSend = vi.fn();
  const onSaveDraft = vi.fn();
  const onKeywordCreated = vi.fn();
  const view = render(
    <PromptInput
      onSend={onSend}
      disabled={false}
      onSaveDraft={onSaveDraft}
      slashCommands={COMMANDS}
      keywords={KEYWORDS}
      onKeywordCreated={onKeywordCreated}
      {...props}
    />,
  );
  const textarea = screen.getByPlaceholderText("Send a message...") as HTMLTextAreaElement;
  return { onSend, onSaveDraft, onKeywordCreated, textarea, view };
}

/**
 * Type `text` into the composer, leaving the caret at its end.
 *
 * jsdom's value setter collapses the selection to the end of the new value,
 * which matches where a real keystroke leaves it — so the caret the composer
 * reads back is the one the user would have.
 */
function type(textarea: HTMLTextAreaElement, text: string) {
  fireEvent.change(textarea, { target: { value: text } });
}

const menu = () => screen.queryByTestId("keyword-autocomplete");
const row = (name: string) => screen.queryByText(`$${name}`);

/**
 * Fire a key and report whether the composer claimed it.
 *
 * `fireEvent.keyDown` discards the event object, so it cannot tell "handled"
 * from "ignored" — and for Tab that distinction *is* the behaviour under test:
 * an unprevented Tab is what lets the browser move focus.
 */
function keyDown(textarea: HTMLTextAreaElement, init: Parameters<typeof createEvent.keyDown>[1]) {
  const event = createEvent.keyDown(textarea, init);
  fireEvent(textarea, event);
  return { prevented: event.defaultPrevented };
}

describe("keyword menu visibility", () => {
  it("opens on a bare $ and lists every keyword", () => {
    const { textarea } = renderComposer();
    type(textarea, "$");
    expect(menu()).toBeTruthy();
    expect(row("review")).toBeTruthy();
    expect(row("standup")).toBeTruthy();
  });

  it("narrows to the query as it is typed", () => {
    const { textarea } = renderComposer();
    type(textarea, "$rev");
    expect(row("review")).toBeTruthy();
    expect(row("review-deep")).toBeTruthy();
    expect(row("standup")).toBeNull();
  });

  it("renders nothing at all when the query matches no keyword", () => {
    const { textarea } = renderComposer();
    type(textarea, "$HOME");
    expect(menu()).toBeNull();
  });

  it("never opens on a price, a currency code, or an interior $", () => {
    const { textarea } = renderComposer();
    for (const prose of ["$50", "costs $1,000", "US$", "foo$bar", "$ 5", "$$x$$"]) {
      type(textarea, prose);
      expect(menu()).toBeNull();
    }
  });

  it("is suppressed while the slash-command autocomplete is up — slash wins", () => {
    const { textarea } = renderComposer();
    // `$rev` on its own opens the keyword menu…
    type(textarea, "$rev");
    expect(menu()).toBeTruthy();

    // …and the identical token inside a slash-command value does not. The
    // composer is in command mode; the token is still there, still valid, and
    // still refused.
    type(textarea, "/model $rev");
    expect(menu()).toBeNull();

    // With a bare command prefix, the slash menu is the one on screen — the
    // two are never both visible.
    type(textarea, "/model");
    expect(screen.getByText("model")).toBeTruthy();
    expect(menu()).toBeNull();
  });
});

describe("keyword insertion", () => {
  it("inserts the body on Enter once a query has been typed", () => {
    const { textarea, onSend } = renderComposer();
    type(textarea, "$rev");
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(textarea.value).toBe("Check the tests and the types.");
    expect(menu()).toBeNull();
    // Inserting is not sending.
    expect(onSend).not.toHaveBeenCalled();
  });

  it("inserts on Tab", () => {
    const { textarea } = renderComposer();
    type(textarea, "$rev");
    expect(keyDown(textarea, { key: "Tab" }).prevented).toBe(true);
    expect(textarea.value).toBe("Check the tests and the types.");
  });

  it("inserts at the right offset, keeping the prose on both sides", () => {
    const { textarea } = renderComposer();
    type(textarea, "please $rev");
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(textarea.value).toBe("please Check the tests and the types.");
    expect(textarea.selectionStart).toBe(textarea.value.length);
  });

  it("replaces only the $token when there is text after it", () => {
    const { textarea } = renderComposer();
    // Put the caret inside the token rather than at the end of the value.
    type(textarea, "a $rev z");
    act(() => {
      textarea.setSelectionRange(6, 6);
    });
    fireEvent.select(textarea);

    expect(menu()).toBeTruthy();
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea.value).toBe("a Check the tests and the types. z");
    // Caret lands immediately after the inserted body, not at the end.
    expect(textarea.selectionStart).toBe("a Check the tests and the types.".length);
  });

  it("inserts on click", () => {
    const { textarea } = renderComposer();
    type(textarea, "$stand");
    fireEvent.click(screen.getByText("$standup"));
    expect(textarea.value).toBe("Yesterday:\nToday:\nBlockers:");
  });

  it("sends the fully expanded text, with nothing marking it as a keyword", () => {
    const { textarea, onSend } = renderComposer();
    type(textarea, "$rev");
    fireEvent.keyDown(textarea, { key: "Enter" }); // inserts
    type(textarea, `${textarea.value} — and ship it`);
    fireEvent.keyDown(textarea, { key: "Enter" }); // sends

    expect(onSend).toHaveBeenCalledWith("Check the tests and the types. — and ship it", undefined);
  });

  it("expands to editable text rather than to a chip", () => {
    const { textarea } = renderComposer();
    type(textarea, "$rev");
    fireEvent.keyDown(textarea, { key: "Enter" });

    // No chip button appeared…
    expect(screen.queryByRole("button", { name: /^\/review/ })).toBeNull();
    // …and the inserted text is the user's to edit.
    type(textarea, "Check the types only.");
    expect(textarea.value).toBe("Check the types only.");
  });
});

describe("the Enter key on a bare $", () => {
  it("dismisses without sending and without inserting", () => {
    const { textarea, onSend } = renderComposer();
    type(textarea, "$");
    expect(menu()).toBeTruthy();

    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(menu()).toBeNull();
    expect(textarea.value).toBe("$");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("sends on the next Enter, the way the slash autocomplete already behaves", () => {
    const { textarea, onSend } = renderComposer();
    type(textarea, "$");
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("$", undefined);
  });

  it("inserts after an arrow key establishes a highlight", () => {
    const { textarea, onSend } = renderComposer();
    type(textarea, "$");
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    fireEvent.keyDown(textarea, { key: "Enter" });

    // ArrowDown from "nothing highlighted" lands on the first row, which is
    // alphabetically "review".
    expect(textarea.value).toBe("Check the tests and the types.");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("wraps ArrowUp round to the last row", () => {
    const { textarea } = renderComposer();
    type(textarea, "$");
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea.value).toBe("Yesterday:\nToday:\nBlockers:");
  });

  it("moves the highlight with ArrowDown and wraps at the end", () => {
    const { textarea } = renderComposer();
    type(textarea, "$rev"); // two matches: review, review-deep
    // Already highlighted on "review"; one down is "review-deep", two wraps back.
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea.value).toBe("Check the tests and the types.");
  });
});

/**
 * The dismissal is scoped to the *token*, not to the offset it happened to
 * start at. Offset 0 and "just after the last space" are where a `$` most
 * often lands, so an offset-keyed dismissal would take the feature out for the
 * rest of the composer session on the first Escape.
 */
describe("Escape dismissal", () => {
  it("dismisses the menu for the current token only", () => {
    const { textarea } = renderComposer();
    type(textarea, "$rev");
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(menu()).toBeNull();

    // Still dismissed while the same token keeps being typed.
    type(textarea, "$revi");
    expect(menu()).toBeNull();

    // A `$` somewhere else opens normally.
    type(textarea, "$revi and $stand");
    expect(menu()).toBeTruthy();
    expect(row("standup")).toBeTruthy();
  });

  it("lets a different token at the very same offset open", () => {
    const { textarea } = renderComposer();
    type(textarea, "$rev");
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(menu()).toBeNull();

    // Clear and start again. `$stand` begins at offset 0 too — the dismissal
    // was on `$rev`, and `$rev` is gone.
    type(textarea, "");
    type(textarea, "$stand");
    expect(menu()).toBeTruthy();
    expect(row("standup")).toBeTruthy();
  });

  it("does not wedge the offset after a space either", () => {
    const { textarea } = renderComposer();
    type(textarea, "hello $rev");
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(menu()).toBeNull();

    type(textarea, "hello ");
    type(textarea, "hello $stand");
    expect(menu()).toBeTruthy();
  });

  it("re-opens when the token is edited rather than extended", () => {
    const { textarea } = renderComposer();
    type(textarea, "$rev");
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(menu()).toBeNull();

    // Backspacing is not "still typing that token" — the user is reworking it,
    // which is the moment the menu becomes useful again.
    type(textarea, "$re");
    expect(menu()).toBeTruthy();
  });

  it("leaves Escape-dismissed text alone on send", () => {
    const { textarea, onSend } = renderComposer();
    type(textarea, "$rev");
    fireEvent.keyDown(textarea, { key: "Escape" });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("$rev", undefined);
  });
});

/**
 * Bodies that mention other keywords are the first thing a power user writes,
 * and the caret lands at the end of the pasted body — inside the trailing
 * token. Left alone, the menu re-opens on text the user never typed and the
 * Enter they meant as "send" expands it instead: recursive expansion by
 * accident, which the feature deliberately does not do.
 */
describe("a keyword body ending in a $token", () => {
  const NESTED = [kw("review", "Check the tests."), kw("outer", "please do $review")];

  it("does not re-open the menu on the token it just pasted", () => {
    const { textarea } = renderComposer({ keywords: NESTED });
    type(textarea, "$out");
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(textarea.value).toBe("please do $review");
    expect(menu()).toBeNull();
  });

  it("sends on the next Enter instead of expanding again", () => {
    const { textarea, onSend } = renderComposer({ keywords: NESTED });
    type(textarea, "$out");
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.keyDown(textarea, { key: "Enter" });

    // Sent verbatim, with the inner `$review` left as the literal text it is —
    // and the composer cleared, which is what sending does.
    expect(onSend).toHaveBeenCalledWith("please do $review", undefined);
    expect(textarea.value).toBe("");
  });

  it("still opens on a $ the user types after the insertion", () => {
    const { textarea } = renderComposer({ keywords: NESTED });
    type(textarea, "$out");
    fireEvent.keyDown(textarea, { key: "Enter" });
    type(textarea, "please do $review then $rev");
    expect(menu()).toBeTruthy();
  });
});

/**
 * Tab must not become a focus trap. While any `$token` is live the menu is up,
 * and a keyboard-only user who cannot Tab out of the composer has only Escape
 * left — which is the other half of this pair.
 */
describe("Tab", () => {
  it("lets Shift+Tab through so focus can move backwards", () => {
    const { textarea } = renderComposer();
    type(textarea, "$rev");
    expect(menu()).toBeTruthy();

    expect(keyDown(textarea, { key: "Tab", shiftKey: true }).prevented).toBe(false);
    expect(textarea.value).toBe("$rev");
  });

  it("lets Shift+Tab through on a bare $ as well", () => {
    const { textarea } = renderComposer();
    type(textarea, "$");
    expect(keyDown(textarea, { key: "Tab", shiftKey: true }).prevented).toBe(false);
    expect(textarea.value).toBe("$");
  });

  it("refuses to guess a match for a bare $, the way Enter does", () => {
    const { textarea } = renderComposer();
    type(textarea, "$");
    expect(menu()).toBeTruthy();

    // No query means no expressed intent — "the top match" would just be
    // whatever sorts first. Tab moves focus instead.
    expect(keyDown(textarea, { key: "Tab" }).prevented).toBe(false);
    expect(textarea.value).toBe("$");
  });

  it("completes once an arrow key has established a highlight", () => {
    const { textarea } = renderComposer();
    type(textarea, "$");
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(keyDown(textarea, { key: "Tab" }).prevented).toBe(true);
    expect(textarea.value).toBe("Yesterday:\nToday:\nBlockers:");
  });
});

/**
 * `caret` mirrors the textarea's selection so the menu can be derived at render
 * time. Anything that sets `value` without setting `caret` leaves the mirror
 * pointing into the old string, and the menu is then derived from a position
 * the user is not at.
 */
describe("a value pushed in from outside", () => {
  /** Mirror how Chat.tsx registers the setter: `onSetValue` is a `useState` setter. */
  function renderWithExternalSetValue() {
    let setValue!: (next: string) => void;
    const onSetValue = ((register: () => (next: string) => void) => {
      setValue = register();
    }) as unknown as (next: (value: string) => void) => void;
    const rendered = renderComposer({ onSetValue });
    return { ...rendered, setValue: (next: string) => act(() => setValue(next)) };
  }

  it("resyncs the caret, so no menu opens on a $ the user never typed", () => {
    const { textarea, setValue } = renderWithExternalSetValue();
    type(textarea, "0123456789");

    setValue("check $rev now");
    expect(textarea.value).toBe("check $rev now");
    expect(menu()).toBeNull();
  });

  it("sends the restored draft rather than rewriting it", () => {
    const { textarea, onSend, setValue } = renderWithExternalSetValue();
    type(textarea, "0123456789");
    setValue("check $rev now");

    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("check $rev now", undefined);
  });
});

describe("the menu is honest about what it is showing", () => {
  const FORTY = Array.from({ length: 40 }, (_, i) => kw(`kw-${String(i).padStart(2, "0")}`, `body ${i}`));

  it("says how many of the total it truncated to", () => {
    const { textarea } = renderComposer({ keywords: FORTY });
    type(textarea, "$");
    expect(screen.getByText("Keywords (10 of 40)")).toBeTruthy();
  });

  it("gives a plain count when nothing was dropped", () => {
    const { textarea } = renderComposer();
    type(textarea, "$rev");
    expect(screen.getByText("Keywords (2)")).toBeTruthy();
  });
});

/**
 * The list scrolls — 200px against ~35px rows shows about five of ten — so a
 * highlight driven past the visible window has to bring itself into view, or
 * Enter inserts something the user cannot see.
 */
describe("the highlighted row is kept on screen", () => {
  const TEN = Array.from({ length: 10 }, (_, i) => kw(`kw-${i}`, `body ${i}`));

  // jsdom has no layout and therefore no `scrollIntoView` at all, which is why
  // the component calls it optionally — and why it has to be stubbed to be
  // observed. Removed again afterwards so no other test sees a method jsdom
  // does not really have.
  const scrollIntoView = vi.fn();
  beforeEach(() => {
    Object.defineProperty(Element.prototype, "scrollIntoView", { value: scrollIntoView, writable: true, configurable: true });
  });
  afterEach(() => {
    delete (Element.prototype as Partial<Element>).scrollIntoView;
  });

  it("scrolls the row the arrow keys land on into view", () => {
    const { textarea } = renderComposer({ keywords: TEN });
    type(textarea, "$");
    scrollIntoView.mockClear();

    // ArrowUp from "nothing highlighted" wraps to the last row, which is the
    // furthest possible from the top of a ten-row list.
    fireEvent.keyDown(textarea, { key: "ArrowUp" });

    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    const scrolled = scrollIntoView.mock.instances.at(-1) as HTMLElement;
    expect(scrolled.textContent).toContain("$kw-9");
  });
});

describe("the highlight belongs to the match list it was made against", () => {
  const THREE = [kw("review", "R0"), kw("review-deep", "R1"), kw("review-x", "R2")];

  it("is dropped when the caret moves to a different token", () => {
    const { textarea } = renderComposer({ keywords: THREE });
    type(textarea, "$rev one $rev");

    // Into the first token, then two rows down: an explicit choice of row 2.
    act(() => {
      textarea.setSelectionRange(4, 4);
    });
    fireEvent.select(textarea);
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    fireEvent.keyDown(textarea, { key: "ArrowDown" });

    // Into the second token — a fresh match list, so the default row applies.
    act(() => {
      textarea.setSelectionRange(13, 13);
    });
    fireEvent.select(textarea);
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(textarea.value).toBe("$rev one R0");
  });
});

describe("existing chip behaviour is undisturbed", () => {
  it("still chips a picked slash command and sends it as one prompt string", () => {
    const { textarea, onSend } = renderComposer();

    fireEvent.change(textarea, { target: { value: "/callboard" } });
    fireEvent.click(screen.getByText("callboard:foo"));
    expect(screen.queryByRole("button", { name: "/callboard:foo" })).toBeTruthy();
    expect(textarea.value).toBe("");

    fireEvent.change(textarea, { target: { value: "my text" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("/callboard:foo my text", undefined);
  });

  it("still deletes the chip on Backspace at offset 0 — a keyword caret is never 0", () => {
    const { textarea } = renderComposer();

    fireEvent.change(textarea, { target: { value: "/callboard" } });
    fireEvent.click(screen.getByText("callboard:foo"));
    fireEvent.change(textarea, { target: { value: "my text" } });

    textarea.setSelectionRange(0, 0);
    fireEvent.keyDown(textarea, { key: "Backspace" });

    expect(screen.queryByRole("button", { name: "/callboard:foo" })).toBeNull();
    expect(textarea.value).toBe("my text");
  });

  it("sends a chip plus keyword-expanded prose as one plain string", () => {
    const { textarea, onSend } = renderComposer();

    fireEvent.change(textarea, { target: { value: "/callboard" } });
    fireEvent.click(screen.getByText("callboard:foo"));
    type(textarea, "$rev");
    fireEvent.keyDown(textarea, { key: "Enter" }); // expands
    fireEvent.keyDown(textarea, { key: "Enter" }); // sends

    expect(onSend).toHaveBeenCalledWith("/callboard:foo Check the tests and the types.", undefined);
  });
});

describe("save-as-keyword modal", () => {
  function openModal(textarea: HTMLTextAreaElement) {
    fireEvent.click(screen.getByTitle("More actions"));
    fireEvent.click(screen.getByText("Save as keyword"));
    return textarea;
  }

  it("cannot save without a name", async () => {
    const { textarea } = renderComposer();
    type(textarea, "some reusable text");
    openModal(textarea);

    const save = screen.getByText("Save keyword").closest("button") as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    // Clicking the disabled button does nothing — the backend is never asked.
    fireEvent.click(save);
    expect(createKeyword).not.toHaveBeenCalled();

    // Whitespace is not a name either.
    fireEvent.change(screen.getByPlaceholderText("e.g. review-checklist"), { target: { value: "   " } });
    expect((screen.getByText("Save keyword").closest("button") as HTMLButtonElement).disabled).toBe(true);

    // A real name enables it.
    fireEvent.change(screen.getByPlaceholderText("e.g. review-checklist"), { target: { value: "my-snippet" } });
    expect((screen.getByText("Save keyword").closest("button") as HTMLButtonElement).disabled).toBe(false);
  });

  it("pre-populates the body with the whole composer when nothing is selected", () => {
    const { textarea } = renderComposer();
    type(textarea, "the whole thing");
    openModal(textarea);

    const body = screen.getByPlaceholderText("The text pasted into the composer when the keyword is used…") as HTMLTextAreaElement;
    expect(body.value).toBe("the whole thing");
  });

  it("pre-populates the body with the selection when there is one", () => {
    const { textarea } = renderComposer();
    type(textarea, "keep only this part please");
    act(() => {
      textarea.setSelectionRange(10, 19);
    });
    openModal(textarea);

    const body = screen.getByPlaceholderText("The text pasted into the composer when the keyword is used…") as HTMLTextAreaElement;
    expect(body.value).toBe("this part");
  });

  it("posts the keyword and reports it back so the autocomplete sees it at once", async () => {
    const saved = kw("my-snippet", "edited body", "desc");
    createKeyword.mockResolvedValue(saved);

    const { textarea, onKeywordCreated } = renderComposer();
    type(textarea, "original body");
    openModal(textarea);

    fireEvent.change(screen.getByPlaceholderText("e.g. review-checklist"), { target: { value: "my-snippet" } });
    fireEvent.change(screen.getByPlaceholderText("The text pasted into the composer when the keyword is used…"), { target: { value: "edited body" } });
    await act(async () => {
      fireEvent.click(screen.getByText("Save keyword"));
    });

    expect(createKeyword).toHaveBeenCalledWith({ name: "my-snippet", description: "", body: "edited body" });
    expect(onKeywordCreated).toHaveBeenCalledWith(saved);
  });

  it("disables the menu entry when the composer is empty", () => {
    renderComposer();
    fireEvent.click(screen.getByTitle("More actions"));
    expect((screen.getByText("Save as keyword").closest("button") as HTMLButtonElement).disabled).toBe(true);
  });
});
