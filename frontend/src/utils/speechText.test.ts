import { describe, expect, it } from "vitest";
import { markdownToSpeechText } from "./speechText";

describe("markdownToSpeechText", () => {
  it("keeps plain prose, collapsing whitespace and soft line breaks", () => {
    expect(markdownToSpeechText("Hello   there,\nfriend.\n\n\n  Second   paragraph.  ")).toBe("Hello there, friend.\n\nSecond paragraph.");
  });

  it("replaces a fenced or indented code block with a short notice, and keeps inline code", () => {
    expect(markdownToSpeechText("Run this:\n\n```ts\nconst x = 1;\n```\n\nThen `npm test` passes.")).toBe(
      "Run this:\n\nCode block omitted.\n\nThen npm test passes.",
    );
    expect(markdownToSpeechText("Indented:\n\n    four spaces\n\nAfter.")).toBe("Indented:\n\nCode block omitted.\n\nAfter.");
  });

  it("returns an empty string for a message that is only code", () => {
    expect(markdownToSpeechText("```\nls -la\n```")).toBe("");
    expect(markdownToSpeechText("```js\na()\n```\n\n```js\nb()\n```")).toBe("");
  });

  it("speaks a link as its text, and a bare autolink as its host", () => {
    expect(markdownToSpeechText("See [the docs](https://example.com/docs) for more.")).toBe("See the docs for more.");
    expect(markdownToSpeechText("Visit https://www.example.com/a/b?c=d today.")).toBe("Visit link to example.com today.");
    expect(markdownToSpeechText("Visit <https://news.example.org/x> today.")).toBe("Visit link to news.example.org today.");
  });

  it("drops images, raw HTML and footnotes", () => {
    expect(markdownToSpeechText("Look ![a chart](chart.png) here.")).toBe("Look here.");
    expect(markdownToSpeechText("Some <b>bold</b> text.\n\n<div>block html</div>")).toBe("Some bold text.");
    expect(markdownToSpeechText("A claim.[^1]\n\n[^1]: The source.")).toBe("A claim.");
  });

  it("gives headings and list items terminal punctuation, each its own sentence", () => {
    expect(markdownToSpeechText("# Summary\n\n- first point\n- second point!\n\n1. step one\n2. step two")).toBe(
      "Summary.\n\nfirst point.\n\nsecond point!\n\nstep one.\n\nstep two.",
    );
  });

  it("does not double up punctuation a heading already has", () => {
    expect(markdownToSpeechText("## Why?\n\n### Done:")).toBe("Why?\n\nDone:");
  });

  it("flattens nested lists in order and drops task-list checkboxes", () => {
    expect(markdownToSpeechText("- outer\n  - inner a\n  - inner b\n- last\n\n- [x] shipped\n- [ ] pending")).toBe(
      "outer.\n\ninner a.\n\ninner b.\n\nlast.\n\nshipped.\n\npending.",
    );
  });

  it("reads a table row by row, cells joined", () => {
    expect(markdownToSpeechText("| Name | Price |\n|---|---|\n| Kokoro | $0.99 |\n| Aura | $30 |")).toBe("Name, Price.\n\nKokoro, $0.99.\n\nAura, $30.");
  });

  it("flattens blockquotes, emphasis, strong and strikethrough", () => {
    expect(markdownToSpeechText("> **Note:** this is *really* ~~not~~ important.")).toBe("Note: this is really not important.");
  });

  it("treats a hard break as a space and a thematic break as a paragraph break", () => {
    expect(markdownToSpeechText("line one  \nline two\n\n---\n\nAfter the rule.")).toBe("line one line two\n\nAfter the rule.");
  });

  it("returns an empty string for blank input", () => {
    expect(markdownToSpeechText("")).toBe("");
    expect(markdownToSpeechText("   \n\n  ")).toBe("");
  });
});
