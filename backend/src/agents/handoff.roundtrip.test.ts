/**
 * Cross-harness handoff, through the **real** session providers.
 *
 * `routes/chats.fork.test.ts` drives the route with stub providers and asserts
 * on the metadata it composes. That is the right test for the route and the
 * wrong one for this question: a stub that returns `{ logPath }` proves the
 * route calls `seedSession`, not that the file `seedSession` wrote can be read
 * back. Cline and pi were both offered as handoff targets in Phase 5 on the
 * strength of implementing the method; this is the check that the method
 * actually works.
 *
 * The shape mirrors what the route does, in order:
 *
 *   source `parseSessionMessages` → `truncateAtCutoff` → `buildHandoffTurns`
 *   → target `seedSession` → target `parseSessionMessages`
 *
 * and then forks the seeded session within the target, because a handed-off
 * chat that cannot itself be forked is a dead end.
 */
import { describe, expect, it, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParsedMessage } from "shared/types/index.js";

// Before anything reads `paths.ts` — #302.
const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-handoff-roundtrip-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const { PiSessionProvider } = await import("./adapters/pi/PiSessionProvider.js");
const { ClineSessionProvider } = await import("./adapters/cline/ClineSessionProvider.js");
const { buildHandoffTurns, truncateAtCutoff } = await import("./handoff.js");
const { resolvePiSessionsRoot } = await import("./adapters/pi/paths.js");

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

const T1 = "2026-01-01T00:00:00.000Z";
const T2 = "2026-01-01T01:00:00.000Z";
const FOLDER = "/repo/handoff-target";

/** A Claude Code chat's history, as its parser would hand it over. */
function sourceHistory(): ParsedMessage[] {
  return [
    { role: "user", type: "text", content: "the codeword is albatross", timestamp: T1 },
    { role: "assistant", type: "text", content: "Noted — albatross.", timestamp: T1 },
    { role: "assistant", type: "tool_use", content: '{"file_path":"NOTES.md"}', toolName: "Read", toolUseId: "t1", timestamp: T1 },
    { role: "user", type: "tool_result", content: "nothing else here", toolUseId: "t1", timestamp: T1 },
    { role: "assistant", type: "thinking", content: "private reasoning that must not travel", timestamp: T2 },
    { role: "user", type: "text", content: "thanks", timestamp: T2 },
  ];
}

const TARGETS = [
  { kind: "pi" as const, provider: () => new PiSessionProvider() },
  { kind: "cline" as const, provider: () => new ClineSessionProvider() },
];

beforeEach(() => {
  rmSync(resolvePiSessionsRoot(), { recursive: true, force: true });
  rmSync(join(tmpRoot, "cline-sessions"), { recursive: true, force: true });
});

describe.each(TARGETS)("handoff into $kind", ({ kind, provider: makeProvider }) => {
  /** The route's own pipeline, minus the HTTP layer. */
  function handoff(sessionId: string, cutoff = "2030-01-01T00:00:00.000Z") {
    const provider = makeProvider();
    const history = truncateAtCutoff(sourceHistory(), cutoff);
    const turns = buildHandoffTurns(history, "claude-code", kind);
    const seeded = provider.seedSession?.(turns, { folder: FOLDER, newSessionId: sessionId }) ?? null;
    return { provider, turns, seeded };
  }

  it("writes a session the provider can read back", () => {
    const { provider, seeded } = handoff(`seed-${kind}`);
    expect(seeded, `${kind}.seedSession returned null`).not.toBeNull();
    const messages = provider.parseSessionMessages([`seed-${kind}`]);
    expect(messages.length).toBeGreaterThan(0);
  });

  it("carries the conversation's content across", () => {
    const { provider } = handoff(`content-${kind}`);
    const text = provider
      .parseSessionMessages([`content-${kind}`])
      .map((m) => m.content)
      .join("\n");
    expect(text).toContain("albatross");
    expect(text).toContain("Noted — albatross.");
  });

  it("carries the provenance preamble, so the model knows whose history this is", () => {
    const { provider } = handoff(`preamble-${kind}`);
    const text = provider
      .parseSessionMessages([`preamble-${kind}`])
      .map((m) => m.content)
      .join("\n");
    expect(text).toContain("conversation_handoff");
    expect(text).toContain("Claude Code");
  });

  it("flattens tool traffic to text rather than replaying calls", () => {
    // Replaying would seed the target with function calls naming tools it does
    // not have — rejected by some providers, confusing to all of them.
    const { provider } = handoff(`tools-${kind}`);
    const messages = provider.parseSessionMessages([`tools-${kind}`]);
    const text = messages.map((m) => m.content).join("\n");
    expect(text).toContain("[tool: Read]");
    expect(text).toContain("[tool result] nothing else here");
    expect(messages.filter((m) => m.type === "tool_use")).toHaveLength(0);
  });

  it("drops the source model's reasoning", () => {
    const { provider } = handoff(`thinking-${kind}`);
    const text = provider
      .parseSessionMessages([`thinking-${kind}`])
      .map((m) => m.content)
      .join("\n");
    expect(text).not.toContain("private reasoning that must not travel");
  });

  it("honours the fork cutoff", () => {
    const { provider } = handoff(`cutoff-${kind}`, T1);
    const text = provider
      .parseSessionMessages([`cutoff-${kind}`])
      .map((m) => m.content)
      .join("\n");
    expect(text).toContain("albatross");
    // "thanks" is stamped T2, past the cutoff.
    expect(text).not.toContain("thanks");
  });

  it("produces a session that can itself be forked", () => {
    // A handed-off chat that cannot be forked is a dead end — and the route
    // reaches `forkSession` for any same-harness fork after the handoff.
    const { provider } = handoff(`forkable-${kind}`);
    const forked = provider.forkSession?.([`forkable-${kind}`], "2030-01-01T00:00:00.000Z", `forked-${kind}`) ?? null;
    expect(forked, `${kind}.forkSession returned null on a seeded session`).not.toBeNull();
    const text = provider
      .parseSessionMessages([`forked-${kind}`])
      .map((m) => m.content)
      .join("\n");
    expect(text).toContain("albatross");
  });

  it("refuses an unsafe session id rather than writing outside its root", () => {
    const provider = makeProvider();
    const turns = buildHandoffTurns(sourceHistory(), "claude-code", kind);
    expect(provider.seedSession?.(turns, { folder: FOLDER, newSessionId: "../../escape" })).toBeNull();
  });

  it("returns null for an empty history rather than seeding a preamble alone", () => {
    const provider = makeProvider();
    expect(provider.seedSession?.([], { folder: FOLDER, newSessionId: `empty-${kind}` })).toBeNull();
  });
});
