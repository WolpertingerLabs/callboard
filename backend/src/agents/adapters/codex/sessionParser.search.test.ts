/**
 * `deriveCodexSearchText` — what content search matches a Codex rollout on.
 *
 * It used to be the first user prompt alone, so anything said after the
 * opening message was unsearchable. It is now every genuine user and assistant
 * message, under the transcript view's own-history rule.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveCodexSearchText } from "./sessionParser.js";

const dir = mkdtempSync(join(tmpdir(), "codex-search-text-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PARENT = "11111111-1111-4111-8111-111111111111";
const CHILD = "22222222-2222-4222-8222-222222222222";

let n = 0;
function rollout(lines: object[]): string {
  const path = join(dir, `rollout-${n++}.jsonl`);
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return path;
}
const message = (role: string, text: string) => ({
  type: "response_item",
  payload: { type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }] },
});
const rootMeta = { type: "session_meta", payload: { id: PARENT, cwd: "/repo", cli_version: "0.153.4" } };
const matches = (path: string, needle: string) => deriveCodexSearchText(path).toLowerCase().includes(needle.toLowerCase());

describe("deriveCodexSearchText", () => {
  it("matches a later user message and an assistant message, not just the first prompt", () => {
    const path = rollout([
      rootMeta,
      message("user", "<environment_context>\n  <cwd>/repo</cwd>\n  <secret>envblob</secret>\n</environment_context>"),
      message("user", "first prompt"),
      message("assistant", "an assistant answer mentioning Zebra"),
      message("user", "second message about Giraffe"),
      { type: "response_item", payload: { type: "function_call", name: "shell", arguments: '{"cmd":"toolonly"}', call_id: "c1" } },
      message("developer", "developer-only text"),
    ]);
    expect(matches(path, "first prompt")).toBe(true);
    expect(matches(path, "giraffe")).toBe(true);
    expect(matches(path, "zebra")).toBe(true);
    // The CLI's synthetic user-channel lead is not conversation.
    expect(matches(path, "envblob")).toBe(false);
    // Nor are tool traffic and developer messages.
    expect(matches(path, "toolonly")).toBe(false);
    expect(matches(path, "developer-only")).toBe(false);
  });

  it("does not match a native fork on the parent history it copied", () => {
    const forkMeta = (extra: object) => ({
      type: "session_meta",
      payload: {
        id: CHILD,
        cwd: "/repo",
        cli_version: "0.153.4",
        source: { subagent: { thread_spawn: { parent_thread_id: PARENT, depth: 1, agent_nickname: "Scout" } } },
        ...extra,
      },
    });
    // Ordinals 0-2 are the copied parent history; the fork's own begins at 3.
    const lines = (extra: object) => [
      forkMeta(extra),
      rootMeta,
      message("user", "parent said Platypus"),
      message("user", "child asks about Okapi"),
      message("assistant", "child reply"),
    ];
    const fork = rollout(lines({ subagent_history_start_ordinal: 3 }));
    expect(matches(fork, "okapi")).toBe(true);
    expect(matches(fork, "platypus")).toBe(false);
    // The nickname is the child's title in the list.
    expect(matches(fork, "scout")).toBe(true);

    // Without the ordinal the fork's own history is unknowable: fail closed,
    // as the transcript does, leaving only the nickname.
    const unknown = rollout(lines({}));
    expect(matches(unknown, "platypus")).toBe(false);
    expect(matches(unknown, "okapi")).toBe(false);
    expect(deriveCodexSearchText(unknown)).toBe("Scout");
  });
});
