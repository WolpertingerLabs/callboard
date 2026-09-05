/**
 * Synthetic-lead filtering, driven by **real captured rollouts** rather than a
 * hand-written approximation of one.
 *
 * `sessionParser.ts` filters the CLI's injected lead messages by matching their
 * opening tag. That tag text is undocumented, is not described anywhere in the
 * SDK's `.d.ts`, and moves between CLI releases: 0.153.4 reordered the first
 * `developer` blob so it opens with `<skills_instructions>` rather than
 * `<permissions instructions>`, and ~2.5 KB of boilerplate started appearing at
 * the head of every Codex transcript. The unit fixture was modelled on 0.146.0
 * output, so the suite stayed green through it.
 *
 * The only fixture that can catch that class of change is one the CLI wrote.
 * Both files here are exactly that — see `__fixtures__/README.md` for how they
 * were captured and the single redaction applied.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCodexRollout, readCodexSessionMeta, readFirstUserPrompt } from "./sessionParser.js";

const fixture = (name: string): string => fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));

/** The prompt both captures were driven with — the one user-authored line. */
const REAL_PROMPT = "Reply with exactly the word OK and nothing else.";

const CAPTURES = [
  { cliVersion: "0.146.0", file: fixture("rollout-cli-0.146.0.jsonl") },
  { cliVersion: "0.153.4", file: fixture("rollout-cli-0.153.4.jsonl") },
] as const;

describe.each(CAPTURES)("captured rollout — codex-cli $cliVersion", ({ cliVersion, file }) => {
  it("is the capture it claims to be", () => {
    expect(readCodexSessionMeta(file)?.cliVersion).toBe(cliVersion);
  });

  it("keeps the real user prompt and the assistant reply", () => {
    const messages = parseCodexRollout(file);
    expect(messages.filter((m) => m.role === "user" && m.type === "text").map((m) => m.content)).toContain(REAL_PROMPT);
    expect(messages.filter((m) => m.role === "assistant" && m.type === "text").map((m) => m.content)).toEqual(["OK"]);
  });

  it("previews the real prompt, not the CLI's plugin catalogue", () => {
    expect(readFirstUserPrompt(file)).toBe(REAL_PROMPT);
  });

  /**
   * The whole point: no assertion about *which* blobs leak, because the set of
   * blobs is exactly the thing that keeps changing. Both captures reduce to
   * the two lines a human typed or read.
   */
  it("reduces to nothing but the real conversation", () => {
    expect(parseCodexRollout(file).map((m) => ({ role: m.role, type: m.type, content: m.content }))).toEqual([
      { role: "user", type: "text", content: REAL_PROMPT },
      { role: "assistant", type: "text", content: "OK" },
    ]);
  });
});

/**
 * A resumed turn appends to the *same* rollout, and the CLI re-injects its
 * lead run ahead of it. This is why the filter cannot be positional — there is
 * no single "before the first real user message" region to carve out — and why
 * `developer` is dropped by role rather than by tag.
 */
describe("captured rollout — resumed thread (codex-cli 0.153.4)", () => {
  const file = fixture("rollout-cli-0.153.4-resumed.jsonl");

  it("re-injects the lead run mid-file", () => {
    const roles: string[] = [];
    for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
      const r = JSON.parse(line) as { type?: string; payload?: { type?: string; role?: string } };
      if (r.type === "response_item" && r.payload?.type === "message") roles.push(r.payload.role ?? "?");
    }
    // ...developer leads, turn 1, then developer leads AGAIN, then turn 2.
    expect(roles).toEqual(["developer", "developer", "developer", "user", "user", "assistant", "developer", "user", "assistant"]);
  });

  it("keeps both turns and drops both lead runs", () => {
    expect(parseCodexRollout(file).map((m) => `${m.role}: ${m.content}`)).toEqual([
      `user: ${REAL_PROMPT}`,
      "assistant: OK",
      "user: Now reply with exactly the word TWO.",
      "assistant: TWO",
    ]);
  });
});
