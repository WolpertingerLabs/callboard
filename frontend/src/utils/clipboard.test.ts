// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyRichToClipboard } from "./clipboard";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** jsdom's Blob has no `.text()`. */
function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.readAsText(blob);
  });
}

describe("copyRichToClipboard", () => {
  it("writes html and plain text as one ClipboardItem", async () => {
    const write = vi.fn(async () => {});
    class FakeItem {
      constructor(public items: Record<string, Blob>) {}
    }
    vi.stubGlobal("ClipboardItem", FakeItem);
    vi.stubGlobal("navigator", { clipboard: { write } });

    expect(await copyRichToClipboard("<b>hi</b>", "**hi**")).toBe(true);
    const item = (write.mock.calls[0] as unknown as [FakeItem[]])[0][0];
    expect(Object.keys(item.items).sort()).toEqual(["text/html", "text/plain"]);
    expect(item.items["text/html"].type).toBe("text/html");
    expect(await readBlob(item.items["text/html"])).toBe("<b>hi</b>");
    expect(await readBlob(item.items["text/plain"])).toBe("**hi**");
  });

  it("falls back to a copy event that sets both types when the Clipboard API is missing", async () => {
    vi.stubGlobal("navigator", {});
    const set: Record<string, string> = {};
    let selected = "";
    document.execCommand = vi.fn(() => {
      // Safari only fires `copy` with something selected.
      const textarea = document.querySelector("textarea")!;
      selected = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd);
      const e = new Event("copy") as ClipboardEvent;
      Object.defineProperty(e, "clipboardData", { value: { setData: (t: string, v: string) => (set[t] = v) } });
      document.dispatchEvent(e);
      return true;
    });

    expect(await copyRichToClipboard("<b>hi</b>", "**hi**")).toBe(true);
    expect(set).toEqual({ "text/html": "<b>hi</b>", "text/plain": "**hi**" });
    expect(selected).toBe("**hi**");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("reports failure when nothing filled the clipboard", async () => {
    vi.stubGlobal("navigator", {});
    document.execCommand = vi.fn(() => false);
    expect(await copyRichToClipboard("<b>hi</b>", "**hi**")).toBe(false);
  });
});
