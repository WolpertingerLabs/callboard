// @vitest-environment jsdom
/**
 * The real composer's half of select & quote — Chat.quoteTray.test stubs the
 * composer out. `onFocusRequest` hands out a function that puts the caret at
 * the end of whatever is typed (the selection bar's Ask calls it, on touch
 * devices too), and does nothing while the composer is disabled; `accessory`
 * (the quote tray) renders inside the composer.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import PromptInput from "./PromptInput";

vi.mock("../api", () => ({ getSlashCommandContent: vi.fn() }));

afterEach(cleanup);

/** Registered the way Chat receives it — through a state setter, so what arrives is an updater. */
function registrar() {
  const box: { focus: (() => void) | null } = { focus: null };
  const set = (updater: unknown) => {
    box.focus = updater === null ? null : (updater as () => () => void)();
  };
  return { box, set };
}

describe("PromptInput onFocusRequest / accessory", () => {
  it("focuses the textarea with the caret at the end of the text", () => {
    const { box, set } = registrar();
    render(<PromptInput onSend={vi.fn()} disabled={false} onFocusRequest={set} />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "why does this" } });
    textarea.setSelectionRange(0, 0);
    textarea.blur();
    expect(document.activeElement).not.toBe(textarea);

    act(() => box.focus!());

    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe("why does this".length);
    expect(textarea.selectionEnd).toBe("why does this".length);
  });

  it("does nothing while the composer is disabled", () => {
    const { box, set } = registrar();
    render(<PromptInput onSend={vi.fn()} disabled onFocusRequest={set} />);
    act(() => box.focus!());
    expect(document.activeElement).toBe(document.body);
  });

  it("unregisters on unmount", () => {
    const { box, set } = registrar();
    const { unmount } = render(<PromptInput onSend={vi.fn()} disabled={false} onFocusRequest={set} />);
    expect(box.focus).toBeTypeOf("function");
    unmount();
    expect(box.focus).toBeNull();
  });

  it("renders the accessory inside the composer", () => {
    render(<PromptInput onSend={vi.fn()} disabled={false} accessory={<div data-testid="tray">quotes</div>} />);
    expect(screen.getByTestId("tray").textContent).toBe("quotes");
  });
});
