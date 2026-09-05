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
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCodexRollout, readCodexSessionMeta } from "./sessionParser.js";

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

  it("drops every instruction blob the CLI injects ahead of the transcript", () => {
    const leaked = parseCodexRollout(file)
      .map((m) => m.content ?? "")
      .filter((c) => /^<(skills_instructions|permissions|environment_context|user_instructions)\b/i.test(c.trimStart()));
    expect(leaked).toEqual([]);
  });
});

/**
 * The leads that still leak, recorded as a fact rather than asserted as
 * correct. All three are CLI scaffolding — every one of these literals is
 * compiled into the bundled `codex` binary — but they are **not** caused by the
 * 0.153.4 bump: they leak identically at 0.146.0, so they are out of scope for
 * the regression fix and are addressed on their own.
 *
 * Note the 0.146.0 multi-agent lead carries no tag at all, which is why no
 * addition to the prefix list can reach it.
 */
describe("pre-existing leaks (not introduced by the 0.153.4 bump)", () => {
  const heads = (file: string): string[] =>
    parseCodexRollout(file)
      .filter((m) => m.type === "text" && m.content !== REAL_PROMPT && m.content !== "OK")
      .map((m) => `${m.role}: ${(m.content ?? "").slice(0, 40)}`);

  it("leaks the same lead messages on both CLI versions", () => {
    expect(heads(fixture("rollout-cli-0.146.0.jsonl"))).toEqual([
      "system: You are `/root`, the primary agent in a ",
      "system: <multi_agent_mode>Any earlier instructio",
      "user: <recommended_plugins>\nHere is a list of ",
    ]);
    expect(heads(fixture("rollout-cli-0.153.4.jsonl"))).toEqual([
      "system: <multi_agent_role>You are `/root`, the p",
      "system: <multi_agent_mode>Any earlier instructio",
      "user: <recommended_plugins>\nHere is a list of ",
    ]);
  });
});
