import { afterEach, describe, expect, it } from "vitest";
import type { ChatTreeNode, ChatTreeResponse, ParsedMessage } from "../api";
import { asidesOf, findQuoteRange, locateAsideRanges, quoteCandidates, quoteOccurrence } from "./asideHighlights";

const node = (chatId: string, extra: Partial<ChatTreeNode> = {}): ChatTreeNode => ({
  chatId,
  title: chatId,
  provider: "claude-code",
  status: "stopped",
  folder: "/tmp",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  children: [],
  ...extra,
});

const tree = (children: ChatTreeNode[], targetChatId = "main"): ChatTreeResponse => ({
  targetChatId,
  rootChatId: "main",
  ancestors: [],
  tree: node("main", { children }),
});

const quote = (text: string, timestamp = "t1", role: "user" | "assistant" = "assistant") => ({ timestamp, role, text });

describe("asidesOf", () => {
  it("lists the target's direct asides, oldest first, with their quotes", () => {
    const asides = asidesOf(
      tree([
        node("late", { role: "aside", createdAt: "2026-01-02T00:00:00.000Z", asideQuotes: [quote("b")] }),
        node("fork", { role: "fork" }),
        node("early", { role: "aside", createdAt: "2026-01-01T00:00:00.000Z", title: null, asideQuotes: [quote("a")] }),
      ]),
    );
    expect(asides.map((a) => a.chatId)).toEqual(["early", "late"]);
    expect(asides[0]).toMatchObject({ title: "Aside", quotes: [quote("a")] });
  });

  it("leaves out archived asides, and an aside without quotes has none (an older daemon)", () => {
    const asides = asidesOf(tree([node("gone", { role: "aside", childArchived: true }), node("bare", { role: "aside" })]));
    expect(asides.map((a) => a.chatId)).toEqual(["bare"]);
    expect(asides[0]!.quotes).toEqual([]);
  });

  it("reads the target's own children, not the root's", () => {
    const t: ChatTreeResponse = {
      ...tree([node("child", { children: [node("deep", { role: "aside" })] }), node("rootAside", { role: "aside" })]),
      targetChatId: "child",
    };
    expect(asidesOf(t).map((a) => a.chatId)).toEqual(["deep"]);
    expect(asidesOf(null)).toEqual([]);
  });
});

describe("quoteCandidates", () => {
  const messages: ParsedMessage[] = [
    { role: "user", type: "text", content: "q", timestamp: "t1" },
    { role: "assistant", type: "text", content: "a1", timestamp: "t1" },
    { role: "assistant", type: "tool_use", content: "x", timestamp: "t1" },
    { role: "assistant", type: "text", content: "a2", timestamp: "t1" },
    { role: "assistant", type: "text", content: "sub", timestamp: "t1", teamName: "helper" },
  ];
  it("is every quotable message with the quote's timestamp and role", () => {
    expect(quoteCandidates(messages, quote("x"))).toEqual([1, 3]);
    expect(quoteCandidates(messages, quote("x", "t1", "user"))).toEqual([0]);
    expect(quoteCandidates(messages, quote("x", "t2"))).toEqual([]);
  });
});

describe("findQuoteRange", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("finds a passage across elements, ignoring the whitespace a selection adds or drops", () => {
    document.body.innerHTML = "<div id=c><p>First <b>bold</b> line</p><ul><li>one</li><li>two</li></ul></div>";
    const root = document.getElementById("c")!;
    const range = findQuoteRange(root, "bold line\n\none\ntwo")!;
    expect(range).not.toBeNull();
    expect(range.toString()).toBe("bold lineonetwo");
    expect(range.startContainer.textContent).toBe("bold");
    expect(range.startOffset).toBe(0);
  });

  it("ends on the last character, mid-node", () => {
    document.body.innerHTML = "<div id=c>alpha beta gamma</div>";
    const range = findQuoteRange(document.getElementById("c")!, "beta")!;
    expect(range.toString()).toBe("beta");
  });

  it("is null for text that is not there, or a blank quote", () => {
    document.body.innerHTML = "<div id=c>alpha</div>";
    expect(findQuoteRange(document.getElementById("c")!, "omega")).toBeNull();
    expect(findQuoteRange(document.getElementById("c")!, "  \n ")).toBeNull();
  });
});

describe("locateAsideRanges", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("looks only inside each candidate's quotable content, and skips quotes it cannot find", () => {
    document.body.innerHTML = `
      <div id=c>
        <div data-message-index="0"><div data-quote-content>question text</div></div>
        <div data-message-index="1"><span>metadata answer</span><div data-quote-content>the answer part one</div></div>
        <div data-message-index="2"><div data-quote-content>the answer part two</div></div>
      </div>`;
    const messages: ParsedMessage[] = [
      { role: "user", type: "text", content: "", timestamp: "t0" },
      { role: "assistant", type: "text", content: "", timestamp: "t1" },
      { role: "assistant", type: "text", content: "", timestamp: "t1" },
    ];
    const asides = [
      {
        chatId: "a",
        title: "A",
        status: "stopped" as const,
        provider: "claude-code",
        createdAt: "",
        updatedAt: "",
        quotes: [quote("part two"), quote("compressed away")],
      },
      { chatId: "b", title: "B", status: "stopped" as const, provider: "claude-code", createdAt: "", updatedAt: "", quotes: [quote("metadata")] },
      { chatId: "c", title: "C", status: "stopped" as const, provider: "claude-code", createdAt: "", updatedAt: "", quotes: [quote("question", "t0", "user")] },
    ];
    const located = locateAsideRanges(document.getElementById("c")!, messages, asides);
    expect(located.get("a")!.map((r) => r.toString())).toEqual(["part two"]);
    expect(located.has("b")).toBe(false);
    expect(located.get("c")!.map((r) => r.toString())).toEqual(["question"]);
  });
});

describe("repeated passages (occurrence)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  const html = "<div id=c><p>run the tests, then</p><p>run   the\ntests again</p><p>and run the tests</p></div>";

  it("records which repeat a selection is, ignoring whitespace", () => {
    document.body.innerHTML = html;
    const root = document.getElementById("c")!;
    const ps = root.querySelectorAll("p");
    const select = (p: Element, from: number, to: number) => {
      const range = document.createRange();
      range.setStart(p.firstChild!, from);
      range.setEnd(p.firstChild!, to);
      return range;
    };
    expect(quoteOccurrence(root, select(ps[0]!, 0, 13), "run the tests")).toBe(0);
    expect(quoteOccurrence(root, select(ps[1]!, 0, 15), "run the tests")).toBe(1);
    expect(quoteOccurrence(root, select(ps[2]!, 4, 17), "run the tests")).toBe(2);
  });

  it("finds the recorded repeat, and the first for none or one past the last", () => {
    document.body.innerHTML = html;
    const root = document.getElementById("c")!;
    const paragraphOf = (r: Range | null) =>
      r!.startContainer.parentElement === root.children[0] ? 0 : r!.startContainer.parentElement === root.children[1] ? 1 : 2;
    expect(paragraphOf(findQuoteRange(root, "run the tests"))).toBe(0);
    expect(paragraphOf(findQuoteRange(root, "run the tests", 1))).toBe(1);
    expect(paragraphOf(findQuoteRange(root, "run the tests", 2))).toBe(2);
    expect(paragraphOf(findQuoteRange(root, "run the tests", 7))).toBe(0);
  });

  it("locates an aside's quote by its occurrence", () => {
    document.body.innerHTML = `<div id=w><div data-message-index="0"><div data-quote-content>${html}</div></div></div>`;
    const messages: ParsedMessage[] = [{ role: "assistant", type: "text", content: "", timestamp: "t1" }];
    const asides = [
      {
        chatId: "a",
        title: "A",
        status: "stopped" as const,
        provider: "claude-code",
        createdAt: "",
        updatedAt: "",
        quotes: [{ ...quote("run the tests"), occurrence: 2 }],
      },
    ];
    const [range] = locateAsideRanges(document.getElementById("w")!, messages, asides).get("a")!;
    expect(range!.startContainer.textContent).toBe("and run the tests");
  });
});
