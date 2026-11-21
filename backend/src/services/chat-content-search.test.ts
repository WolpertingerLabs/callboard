import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectContentMatches } from "./chat-content-search.js";
const dir = mkdtempSync(join(tmpdir(), "chat-content-"));
describe("bounded complete content collection", () => {
  // Mapping hits to chat rows (historical aliases included) is the route's
  // job now — see routes/chats.search.test.ts.
  it("returns more than fifty Claude matches", async () => {
    const sessions = Array.from({ length: 130 }, (_, i) => {
      const filePath = join(dir, i + ".jsonl");
      writeFileSync(filePath, '{"text":"needle"}\n');
      return {
        sessionId: String(i),
        filePath,
        folder: "/repo",
        displayFolder: "/repo",
        createdAt: new Date(0),
        updatedAt: new Date(0),
        providerKind: "claude-code",
      };
    });
    const result = await collectContentMatches("needle", sessions);
    expect(result.keys.size).toBe(130);
    expect(result.warnings).toEqual([]);
  });
  it("finds a Codex session by a message after its first prompt", async () => {
    const filePath = join(dir, "codex-later.jsonl");
    const message = (role: string, text: string) =>
      JSON.stringify({ type: "response_item", payload: { type: "message", role, content: [{ type: "input_text", text }] } });
    writeFileSync(
      filePath,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "codex-later", cwd: "/repo", cli_version: "0.153.4" } }),
        message("user", "opening prompt"),
        message("assistant", "reply"),
        message("user", "later message with the laterneedle"),
      ].join("\n") + "\n",
    );
    const session = {
      sessionId: "codex-later",
      filePath,
      folder: "/repo",
      displayFolder: "/repo",
      createdAt: new Date(0),
      updatedAt: new Date(0),
      providerKind: "codex",
    };
    const result = await collectContentMatches("LaterNeedle", [session]);
    expect([...result.keys]).toEqual([JSON.stringify(["codex", "codex-later"])]);
    expect(result.warnings).toEqual([]);
  });
  it("flags a Codex native child matched only on its nickname", async () => {
    const child = "22222222-2222-4222-8222-222222222222";
    const filePath = join(dir, "codex-native.jsonl");
    writeFileSync(
      filePath,
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: child,
          cwd: "/repo",
          cli_version: "0.153.4",
          source: { subagent: { thread_spawn: { parent_thread_id: "11111111-1111-4111-8111-111111111111", agent_nickname: "Scoutling" } } },
          subagent_history_start_ordinal: 1,
        },
      }) +
        "\n" +
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "own words" }] } }) +
        "\n",
    );
    const session = { sessionId: child, filePath, folder: "/repo", displayFolder: "/repo", createdAt: new Date(0), updatedAt: new Date(0), providerKind: "codex" };
    const key = JSON.stringify(["codex", child]);
    const byLabel = await collectContentMatches("scoutling", [session]);
    expect(byLabel.keys.has(key)).toBe(true);
    expect(byLabel.labelOnlyKeys.has(key)).toBe(true);
    const byMessage = await collectContentMatches("own words", [session]);
    expect(byMessage.keys.has(key)).toBe(true);
    expect(byMessage.labelOnlyKeys.has(key)).toBe(false);
  });
  it("reports missing files and invalid grep instead of claiming no matches", async () => {
    const base = {
      sessionId: "x",
      filePath: join(dir, "missing"),
      folder: "/repo",
      displayFolder: "/repo",
      createdAt: new Date(0),
      updatedAt: new Date(0),
      providerKind: "claude-code",
    };
    expect((await collectContentMatches("needle", [base])).warnings[0]).toContain("read failed");
    writeFileSync(base.filePath, "text");
    expect((await collectContentMatches("[", [base])).warnings[0]).toContain("grep failed");
  });
});
