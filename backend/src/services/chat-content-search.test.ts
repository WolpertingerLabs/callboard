import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectContentMatches } from "./chat-content-search.js";
const dir = mkdtempSync(join(tmpdir(), "chat-content-"));
describe("bounded complete content collection", () => {
  it("returns more than fifty Claude matches and reconciles historical aliases", async () => {
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
    const result = await collectContentMatches("needle", sessions, [
      {
        id: "logical",
        session_id: "new",
        folder: "/repo",
        metadata: JSON.stringify({ provider: "codex", session_ids: ["0"] }),
        created_at: "",
        updated_at: "",
        session_log_path: null,
      },
    ]);
    expect(result.keys.size).toBe(131);
    expect(result.keys.has(JSON.stringify(["claude-code", "logical"]))).toBe(true);
    expect(result.warnings).toEqual([]);
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
