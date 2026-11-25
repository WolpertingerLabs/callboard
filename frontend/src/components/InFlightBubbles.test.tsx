// @vitest-environment jsdom
/**
 * The optimistic "Sent" bubbles render their text with the persisted user
 * bubble's markdown renderer, so nothing reflows when the transcript catches
 * up and replaces them — and stay out of selection-to-quote.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ParsedMessage } from "../api";
import InFlightBubbles from "./InFlightBubbles";
import MessageBubble from "./MessageBubble";
import type { InFlightMessage } from "../utils/inFlightMessages";

vi.mock("../api", () => ({}));

afterEach(cleanup);

const message = (text: string, extra: Partial<InFlightMessage> = {}): InFlightMessage => ({ key: `k-${text}`, text, imageUrls: [], ...extra });

describe("InFlightBubbles", () => {
  it("renders markdown in the text as elements, like a persisted user bubble", () => {
    const { container } = render(<InFlightBubbles messages={[message("Make this **bold**\n\n```ts\nconst x = 1;\n```")]} />);
    const markdown = container.querySelector(".message-markdown");
    expect(markdown).not.toBeNull();
    expect(markdown!.querySelector("strong")?.textContent).toBe("bold");
    expect(markdown!.querySelector("pre code")?.textContent).toContain("const x = 1;");
    expect(container.textContent).not.toContain("**");
    expect(container.textContent).toContain("Sent");
  });

  it("renders text exactly as the persisted user bubble that replaces it", () => {
    const text = "line one\nline two\n\n- item\n\n**bold** `code`";
    const inFlight = render(<InFlightBubbles messages={[message(text)]} />).container.querySelector(".message-markdown");
    const persisted = render(
      <MessageBubble message={{ role: "user", type: "text", content: text, timestamp: "2026-01-01T00:00:00.000Z" } as ParsedMessage} />,
    ).container.querySelector(".message-markdown");
    expect(inFlight).not.toBeNull();
    expect(persisted).not.toBeNull();
    expect(inFlight!.innerHTML).toBe(persisted!.innerHTML);
  });

  it("renders no markdown body for an attachment-only message", () => {
    const { container, getByText } = render(<InFlightBubbles messages={[message("", { fileNames: ["notes.txt"] })]} />);
    expect(container.querySelector(".message-markdown")).toBeNull();
    expect(getByText("notes.txt")).toBeTruthy();
  });

  it("is not quotable while it is still being sent", () => {
    const { container } = render(<InFlightBubbles messages={[message("hello")]} />);
    expect(container.querySelector("[data-quote-content]")).toBeNull();
  });
});
