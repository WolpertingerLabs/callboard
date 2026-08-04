// @vitest-environment jsdom
/**
 * Guards the per-code-block copy affordance.
 *
 * Two things here are invisible to TypeScript and worth pinning:
 *
 *  1. The text that gets copied is recovered from the hast tree, not from the
 *     DOM. rehype-highlight rewrites a fenced block into nested <span>s, so a
 *     naive `textContent` read is both fragile and liable to pick up the button
 *     itself. These tests assert the raw source comes back intact.
 *
 *  2. The hover-reveal rule is keyed on a DIRECT child of `.code-block`:
 *
 *         .code-block > .code-copy-btn          { opacity: 0 }
 *         .code-block:hover > .code-copy-btn    { opacity: 1 }
 *
 *     jsdom applies no stylesheet, so the structure the selector depends on is
 *     asserted instead of computed opacity — same approach as
 *     MessageBubble.fork.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import MarkdownRenderer from "./MarkdownRenderer";

const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const FENCED = ["```ts", "const answer = 42;", 'console.log("hi");', "```"].join("\n");

describe("MarkdownRenderer code block copy button", () => {
  it("copies the block's source without the fence or the trailing newline", async () => {
    render(<MarkdownRenderer content={FENCED} />);

    screen.getByRole("button", { name: "Copy code" }).click();

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('const answer = 42;\nconsole.log("hi");'));
  });

  it("puts the hover-reveal class on a direct child of .code-block", () => {
    const { container } = render(<MarkdownRenderer content={FENCED} />);

    const wrapper = container.querySelector(".code-block");
    expect(wrapper).not.toBeNull();
    expect(wrapper!.querySelector(":scope > .code-copy-btn")).not.toBeNull();
    // A sibling of the <pre>, so it can't scroll away with long lines or land
    // inside a selection of the code.
    expect(wrapper!.querySelector("pre .code-copy-btn")).toBeNull();
  });

  it("gives each block its own button", () => {
    render(<MarkdownRenderer content={`${FENCED}\n\ntext between\n\n\`\`\`\nplain\n\`\`\``} />);

    expect(screen.getAllByRole("button", { name: "Copy code" })).toHaveLength(2);
  });

  it("leaves inline code alone", () => {
    render(<MarkdownRenderer content="a sentence with `inline` code" />);

    expect(screen.queryByRole("button", { name: "Copy code" })).toBeNull();
  });

  it("swaps to a confirmation once the copy lands", async () => {
    render(<MarkdownRenderer content={FENCED} />);

    const button = screen.getByRole("button", { name: "Copy code" });
    expect(button.querySelector(".lucide-copy")).not.toBeNull();

    button.click();

    await waitFor(() => expect(button.querySelector(".lucide-check")).not.toBeNull());
  });

  it("falls back to execCommand when the Clipboard API is unavailable", async () => {
    // Callboard is routinely served over plain HTTP on a LAN address, where
    // navigator.clipboard is absent entirely.
    Object.assign(navigator, { clipboard: undefined });
    const execCommand = vi.fn(() => true);
    Object.assign(document, { execCommand });

    render(<MarkdownRenderer content={FENCED} />);
    screen.getByRole("button", { name: "Copy code" }).click();

    await waitFor(() => expect(execCommand).toHaveBeenCalledWith("copy"));
  });
});
