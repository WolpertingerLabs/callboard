// @vitest-environment jsdom
/**
 * A user message carrying non-image attachments renders as the typed text plus
 * one download chip per file. The blocks ride in the message text (see
 * shared/types/attachment.ts), so neither the body nor the copy button may
 * show them.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { appendAttachmentBlocks, formatAttachmentBlock } from "shared/types/index.js";
import type { ParsedMessage } from "../api";
import MessageBubble from "./MessageBubble";

vi.mock("../api", () => ({}));
const copyToClipboard = vi.fn(async (_text: string) => true);
vi.mock("../utils/clipboard", () => ({ copyToClipboard: (text: string) => copyToClipboard(text) }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const content = appendAttachmentBlocks("please review these", [
  formatAttachmentBlock({ id: "f1", name: "notes.md", path: "/d/f1_notes.md", size: 2048, mimeType: "text/markdown" }, { content: "# secret notes body" }),
  formatAttachmentBlock({ id: "f2", name: "data.pdf", path: "/d/f2_data.pdf", size: 3 * 1024 * 1024, mimeType: "application/pdf" }, { reason: "binary" }),
]);

const message = { role: "user", type: "text", content, timestamp: "2026-01-01T00:00:00.000Z" } as ParsedMessage;

describe("MessageBubble with file attachments", () => {
  it("shows the typed text and a download chip per file, not the blocks", () => {
    const { container } = render(<MessageBubble message={message} />);
    expect(screen.getByText("please review these")).toBeTruthy();
    expect(container.textContent).not.toContain("callboard-attachment");
    expect(container.textContent).not.toContain("secret notes body");

    const links = [...container.querySelectorAll("a[download]")] as HTMLAnchorElement[];
    expect(links.map((a) => [a.getAttribute("href"), a.getAttribute("download")])).toEqual([
      ["/api/images/f1", "notes.md"],
      ["/api/images/f2", "data.pdf"],
    ]);
    expect(links[0].textContent).toContain("notes.md");
    expect(links[0].textContent).toMatch(/2(\.0)? KB/);
    expect(links[1].textContent).toMatch(/3(\.0)? MB/);
  });

  it("copies only the typed text", async () => {
    render(<MessageBubble message={message} />);
    fireEvent.click(screen.getByTitle("Copy message"));
    await waitFor(() => expect(copyToClipboard).toHaveBeenCalledWith("please review these"));
  });

  it("splits a built-in command's blocks out too, showing the command line literally", () => {
    const command = { ...message, content: appendAttachmentBlocks("/review the auth module", [content.slice(content.indexOf("<callboard-attachment"))]), isBuiltInCommand: true } as ParsedMessage;
    const { container } = render(<MessageBubble message={command} />);
    expect(screen.getByText("/review the auth module")).toBeTruthy();
    expect(container.textContent).not.toContain("callboard-attachment");
    expect(container.textContent).not.toContain("secret notes body");
    expect([...container.querySelectorAll("a[download]")].map((a) => a.getAttribute("download"))).toEqual(["notes.md", "data.pdf"]);
  });
});
