/**
 * `getFirstUserMessage` — the sidebar preview read.
 *
 * It used to slurp the whole transcript to return 200 characters that sit at
 * the top of it. On a real data dir the 82 rows of one sidebar page spanned
 * 175 MB, and reading it cost 623 ms of blocked event loop per chat-list
 * request; scanning lazily costs 26 ms for byte-identical results on all 82.
 *
 * The risk in that change is behavioural, not performance: stopping early must
 * not change *which* message is returned, and the shapes it has to agree on are
 * the ones the Claude Code transcript actually produces — string content, block
 * content, a user turn carrying no text at all (a tool_result), and a file with
 * no user turn. Each is pinned below against the whole-file semantics.
 *
 * The chunk-boundary and decoding hazards of the lazy read belong to the
 * scanner itself and are covered in utils/jsonl-scan.test.ts.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../../services/image-storage.js", () => ({
  storeBase64Image: vi.fn(() => "img-stub"),
}));

const { getFirstUserMessage } = await import("./sessionParser.js");

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-preview-"));
let seq = 0;

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function transcript(lines: any[]): string {
  const path = join(tmpRoot, `t${seq++}.jsonl`);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n"));
  return path;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const userLine = (content: any) => ({ type: "user", message: { role: "user", content } });
const assistantLine = (text: string) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });

describe("getFirstUserMessage", () => {
  it("returns string content from the first user turn", () => {
    expect(getFirstUserMessage(transcript([userLine("hello there"), userLine("second")]))).toBe("hello there");
  });

  it("returns the first text block when content is an array", () => {
    const path = transcript([userLine([{ type: "text", text: "block text" }])]);
    expect(getFirstUserMessage(path)).toBe("block text");
  });

  it("skips leading non-user lines", () => {
    const path = transcript([{ type: "summary", summary: "s" }, assistantLine("hi"), userLine("the real first")]);
    expect(getFirstUserMessage(path)).toBe("the real first");
  });

  it("falls through a user turn with no text block, as the whole-file loop did", () => {
    // A tool_result is a `type: "user"` line carrying no text — it must not end
    // the search and yield an empty preview.
    const path = transcript([userLine([{ type: "tool_result", tool_use_id: "t1", content: "output" }]), userLine("actual prompt")]);
    expect(getFirstUserMessage(path)).toBe("actual prompt");
  });

  it("truncates to maxLength", () => {
    const path = transcript([userLine("x".repeat(500))]);
    expect(getFirstUserMessage(path, 200)).toBe("x".repeat(200));
    expect(getFirstUserMessage(path, 10)).toBe("x".repeat(10));
  });

  it("defaults to 200 characters", () => {
    const path = transcript([userLine("y".repeat(500))]);
    expect(getFirstUserMessage(path)).toHaveLength(200);
  });

  it("returns null when no user turn has text", () => {
    const path = transcript([assistantLine("only assistant"), { type: "system", content: "x" }]);
    expect(getFirstUserMessage(path)).toBeNull();
  });

  it("returns null for a missing file", () => {
    expect(getFirstUserMessage(join(tmpRoot, "nope.jsonl"))).toBeNull();
  });

  it("stops at the first user turn instead of reading the rest of the file", () => {
    // The answer is on line 2; everything after it is unparseable. A reader
    // that walked the whole file would still return the same string, so the
    // early stop is asserted by making the tail hostile rather than by timing.
    const path = join(tmpRoot, "early-stop.jsonl");
    const head = [JSON.stringify(assistantLine("intro")), JSON.stringify(userLine("the answer"))].join("\n");
    writeFileSync(path, `${head}\n${"{{{ not json ".repeat(200_000)}`);

    expect(getFirstUserMessage(path)).toBe("the answer");
  });
});
