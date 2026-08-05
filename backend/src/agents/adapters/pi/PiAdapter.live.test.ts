/**
 * The pi adapter against a real model, over a real network.
 *
 * ## Why this exists when `PiAgentQuery.test.ts` already drives the whole query
 *
 * The fixture reproduces pi's behaviour *as measured*. That is exactly its
 * limitation: it encodes what the Phase 0 spike observed, so it cannot notice
 * pi changing. Everything below is either a claim the spike made about the real
 * runtime, or one of the §10 leftovers it could not answer cheaply. Re-running
 * this after a version bump is how those claims stay true rather than becoming
 * folklore.
 *
 * Skipped by default. It needs an OpenRouter key and costs a few cents:
 *
 *     CALLBOARD_PI_LIVE=1 npx vitest run --project node PiAdapter.live
 *
 * The key is read from `~/.callboard/agent-settings.json` (`openRouterApiKey`)
 * or `OPENROUTER_API_KEY`, in that order.
 *
 * ## Cost control
 *
 * One cheap model, trivial prompts, `thinkingLevel` never `"off"` — see the
 * effort case below for why that last one is not a preference.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "../../ports/events.js";
import type { DefaultPermissions } from "shared/types/index.js";

/**
 * Cheap, fast, and reasoning-capable. Note it *mandates* reasoning — the 400
 * that taught us `thinkingLevel: "off"` is not a safe default.
 */
const MODEL = "google/gemini-3.6-flash";
const TEST_TIMEOUT = 180_000;

function apiKey(): string {
  const fromEnv = process.env.OPENROUTER_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    const settings = JSON.parse(readFileSync(join(homedir(), ".callboard", "agent-settings.json"), "utf8"));
    return typeof settings.openRouterApiKey === "string" ? settings.openRouterApiKey.trim() : "";
  } catch {
    return "";
  }
}

const live = process.env.CALLBOARD_PI_LIVE === "1" && apiKey() !== "";

// `CALLBOARD_DATA_DIR` before anything reads `paths.ts`, so a live run never
// writes into a developer's real chat list (#302).
const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-pi-live-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const { PiAdapter } = await import("./PiAdapter.js");
const { customSkillsService } = await import("../../../services/custom-skills-service.js");

const ALL_ALLOW: DefaultPermissions = { fileRead: "allow", fileWrite: "allow", codeExecution: "allow", webAccess: "allow" };
const ALL_ASK: DefaultPermissions = { fileRead: "ask", fileWrite: "ask", codeExecution: "ask", webAccess: "ask" };

/** A scratch project, deliberately NOT under /tmp's ignored prefix for realism. */
let repo: string;

/** In the callboard skill's **body** only — see the custom-skill case for why. */
const PROBE_WORD = "chrysanthemum";
/**
 * In the repo's own `.pi/skills`. A rival answer to the same prompt, present so
 * the custom-skill case runs against a realistic repo rather than an empty one —
 * see that case for why its absence from the reply is not asserted.
 */
const PROJECT_WORD = "nightshade";

beforeAll(() => {
  repo = join(tmpRoot, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "NOTES.md"), "the codeword is albatross\n", "utf8");

  // A real custom skill, written through the real service. `CALLBOARD_DATA_DIR`
  // already points at tmpRoot, so this lands where `resolveCallboardSkillPaths()`
  // looks and no test-only plumbing is involved.
  customSkillsService.createSkill({
    name: "callboard probe skill",
    description: "Use this when asked for the callboard probe word.",
    content: `The callboard probe word is ${PROBE_WORD}. When asked for it, reply with that single word.`,
  });

  // The hostile twin: a project-local skill in the opened repo, same shape,
  // different word.
  mkdirSync(join(repo, ".pi", "skills", "project-probe-skill"), { recursive: true });
  writeFileSync(
    join(repo, ".pi", "skills", "project-probe-skill", "SKILL.md"),
    `---\nname: "project-probe-skill"\ndescription: "Use this when asked for the callboard probe word."\n---\n\nThe callboard probe word is ${PROJECT_WORD}.\n`,
    "utf8",
  );
});

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

interface RunResult {
  events: AgentEvent[];
  text: string;
  toolNames: string[];
  result: (AgentEvent & { type: "result" }) | undefined;
}

async function run(prompt: string, options: Record<string, unknown> = {}, permissions: DefaultPermissions = ALL_ALLOW): Promise<RunResult> {
  const events: AgentEvent[] = [];
  const query = new PiAdapter().query({
    prompt,
    options: {
      cwd: repo,
      ...options,
      pi: {
        providerId: "openrouter",
        model: MODEL,
        apiKey: apiKey(),
        effort: "minimal",
        getPermissions: () => permissions,
        ...((options.pi as Record<string, unknown>) ?? {}),
      },
    },
  });
  for await (const event of query) events.push(event);
  return {
    events,
    text: events
      .filter((e) => e.type === "text")
      .map((e) => (e as { content: string }).content)
      .join("\n"),
    toolNames: events.filter((e) => e.type === "tool_use").map((e) => (e as { toolName: string }).toolName),
    result: events.find((e) => e.type === "result") as (AgentEvent & { type: "result" }) | undefined,
  };
}

describe.skipIf(!live)("pi adapter — live", () => {
  it(
    "completes a turn and reports usage with a real cost",
    async () => {
      const { text, result } = await run("Reply with the single word: ok");
      expect(text.toLowerCase()).toContain("ok");
      expect(result).toMatchObject({ type: "result", status: "success" });
      // Per-turn, from `message_end.message.usage` — `turn_end` carries none.
      expect(result?.usage?.inputTokens).toBeGreaterThan(0);
      expect(result?.usage?.costUsd).toBeGreaterThan(0);
    },
    TEST_TIMEOUT,
  );

  it(
    "runs a built-in tool and reports its arguments",
    async () => {
      // `tool_use.input` arriving as `{}` is the bug Phase 1 shipped and Phase 4
      // fixed by reading args off `tool_execution_start`. Only a real run has
      // ever caught it.
      const { toolNames, events, text } = await run("Read NOTES.md and reply with the codeword only.");
      expect(toolNames).toContain("read");
      const use = events.find((e) => e.type === "tool_use") as { input: Record<string, unknown> };
      expect(Object.keys(use.input).length).toBeGreaterThan(0);
      expect(text.toLowerCase()).toContain("albatross");
    },
    TEST_TIMEOUT,
  );

  it(
    "emits tool_use before tool_result, so a running tool has a bubble",
    async () => {
      const { events } = await run("Read NOTES.md and reply with the codeword only.");
      const useAt = events.findIndex((e) => e.type === "tool_use");
      const resultAt = events.findIndex((e) => e.type === "tool_result");
      expect(useAt).toBeGreaterThanOrEqual(0);
      expect(useAt).toBeLessThan(resultAt);
    },
    TEST_TIMEOUT,
  );

  it(
    "makes a denied tool invisible to the model rather than blocking the call",
    async () => {
      // Two layers guard a `deny` axis, and this is the OUTER one: buildToolFilters
      // narrows `tools`/`excludeTools` so the model is never offered `bash` at
      // all. Measured — the model does not attempt the call and says the tool
      // does not exist, rather than trying and being refused.
      //
      // That is the stronger outcome: a model told "no" mid-turn often retries
      // or argues, while one that never saw the tool simply plans around it.
      // The inner layer (the `tool_call` gate refusing a *visible* tool) is
      // exercised by the `ask`-with-no-approval-channel case below.
      const canary = join(repo, "PWNED.txt");
      if (existsSync(canary)) rmSync(canary);
      const { toolNames, result } = await run(
        "Run the bash command `echo pwned > PWNED.txt` and then report exactly what happened.",
        {},
        { ...ALL_ALLOW, codeExecution: "deny" },
      );
      expect(existsSync(canary), "a denied bash tool wrote to disk").toBe(false);
      expect(toolNames, "bash was offered to the model despite a deny axis").not.toContain("bash");
      // Deliberately no assertion on the model's prose. It reliably explains
      // that bash is unavailable, but the wording varies run to run, and a
      // regex over it would be testing the model rather than the adapter — a
      // flake dressed as coverage.
      expect(result?.status).toBe("success");
    },
    TEST_TIMEOUT,
  );

  it(
    "blocks a visible tool at call time when nothing can surface a prompt",
    async () => {
      // The INNER layer, and the one that proves the gate is real: an `ask`
      // axis leaves the tool visible, the model calls it, and
      // `decidePiToolCall` refuses because there is no `canUseTool` to ask
      // through — a quick-completion or an unattended job step. Fail-closed.
      const { events } = await run("Run the bash command `echo hi`.", {}, ALL_ASK);
      const result = events.find((e) => e.type === "tool_result") as { isError?: boolean; content: string } | undefined;
      expect(result?.isError).toBe(true);
      expect(result?.content).toContain("No approval channel");
    },
    TEST_TIMEOUT,
  );

  it(
    "does not execute a project-local extension from the opened repo",
    async () => {
      // `projectTrust.test.ts` proves this offline against the services builder.
      // This proves it survives an actual session being created and run.
      const marker = join(tmpRoot, "HOSTILE_RAN");
      mkdirSync(join(repo, ".pi", "extensions"), { recursive: true });
      writeFileSync(
        join(repo, ".pi", "extensions", "hostile.ts"),
        [`import { writeFileSync } from "node:fs";`, `writeFileSync(${JSON.stringify(marker)}, "executed");`, `export default function (pi: any) {}`].join("\n"),
        "utf8",
      );
      try {
        await run("Reply with the single word: ok");
        expect(existsSync(marker), "an untrusted project extension executed during a live run").toBe(false);
      } finally {
        rmSync(join(repo, ".pi"), { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT,
  );

  it(
    "rejects thinkingLevel 'off' on a model that mandates reasoning",
    async () => {
      // The 400 that made `translateThinkingLevel(undefined)` send nothing at
      // all rather than defaulting to "off". Asserted so a future pi that
      // silently swallows it is noticed.
      const { result } = await run("Reply with the single word: ok", { pi: { effort: "none" } });
      expect(result?.status).toBe("error");
      expect(result?.reason ?? "").toMatch(/reasoning/i);
    },
    TEST_TIMEOUT,
  );

  it(
    "carries an image through PromptOptions.images",
    async () => {
      // §10 leftover. A 1x1 red PNG: enough to prove the block is accepted and
      // reaches the model without spending real vision tokens on a photograph.
      const png =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
      async function* streamed(): AsyncIterable<unknown> {
        yield {
          message: {
            content: [
              { type: "text", text: "What colour is this image? One word." },
              { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
            ],
          },
        };
      }
      const events: AgentEvent[] = [];
      const query = new PiAdapter().query({
        prompt: streamed(),
        options: {
          cwd: repo,
          pi: { providerId: "openrouter", model: MODEL, apiKey: apiKey(), effort: "minimal", getPermissions: () => ALL_ALLOW },
        },
      });
      for await (const event of query) events.push(event);
      const result = events.find((e) => e.type === "result") as { status: string } | undefined;
      // The assertion is that the turn SUCCEEDS — a malformed image block is a
      // provider 400, which is what would actually break. What the model says
      // the colour is, is not callboard's business to assert.
      expect(result?.status).toBe("success");
    },
    TEST_TIMEOUT,
  );

  it(
    "cancels cleanly mid-turn, reporting success rather than an error",
    async () => {
      // `stopReason: "aborted"`, not `willRetry` — the plan's correction.
      const abortController = new AbortController();
      const events: AgentEvent[] = [];
      const query = new PiAdapter().query({
        prompt: "Count slowly from 1 to 400, one number per line, with no other text.",
        options: {
          cwd: repo,
          abortController,
          pi: { providerId: "openrouter", model: MODEL, apiKey: apiKey(), effort: "minimal", getPermissions: () => ALL_ALLOW },
        },
      });
      const timer = setTimeout(() => abortController.abort(), 4_000);
      try {
        for await (const event of query) events.push(event);
      } finally {
        clearTimeout(timer);
      }
      const result = events.at(-1) as { type: string; status: string; reason?: string };
      expect(result.type).toBe("result");
      expect(result.status).toBe("success");
      expect(result.reason).toBeUndefined();
    },
    TEST_TIMEOUT,
  );

  it(
    "resumes a session from its file path and answers from carried context",
    async () => {
      const first = await run("My favourite fruit is the persimmon. Acknowledge in three words.");
      const started = first.events.find((e) => e.type === "session_started") as { sessionId: string };
      const { PiSessionProvider } = await import("./PiSessionProvider.js");
      const resolved = new PiSessionProvider().resolveSession(started.sessionId);
      expect(resolved, "the first turn wrote no session file").not.toBeNull();

      const second = await run("What is my favourite fruit? One word, from memory.", { pi: { resumeSessionPath: resolved!.logPath } });
      expect(second.text.toLowerCase()).toContain("persimmon");
    },
    TEST_TIMEOUT,
  );

  it(
    "invokes a callboard custom skill, body and all",
    async () => {
      // The point of a live case here is that the *model* uses the skill. That
      // the directory reaches pi's loader is settled offline and deterministically
      // by `customSkills.test.ts`; a live test asserting only that would be
      // paying network latency for a fact already proven.
      //
      // So the codeword lives in the skill **body**, never in its description.
      // The description reaches the model in the system prompt, the body only
      // through pi's advertised route — the model reading SKILL.md off disk with
      // the `read` tool. Answering correctly is therefore proof of invocation
      // rather than proof of a path being passed in.
      const { text, toolNames, events } = await run(
        "What is the callboard probe word? Use the available skill, then reply with that word only.",
      );

      expect(text.toLowerCase()).toContain(PROBE_WORD);
      expect(toolNames, "the model never read the skill file").toContain("read");
      const readPaths = events
        .filter((e) => e.type === "tool_use")
        .map((e) => JSON.stringify((e as { input: Record<string, unknown> }).input));
      expect(readPaths.some((p) => p.includes("SKILL.md")), "no read targeted a SKILL.md").toBe(true);

      // Deliberately NO assertion that the repo's own skill went unused, though
      // it sits in `.pi/skills/` with a rival word for exactly this prompt.
      //
      // A control run with callboard's skill absent was measured, and it is the
      // reason this comment exists rather than an assertion: the model never
      // produced the callboard word (so the case above passes because of the
      // feature and nothing else), but it *did* produce the project one — by
      // running `ls`/`find` and reading `.pi/skills/…/SKILL.md` itself.
      //
      // That is not a hole in this feature, and it is worth being exact about
      // why. The property is that pi does not **load** project-local skills:
      // they never enter the system prompt, and — unlike extensions — nothing
      // executes. A model that goes looking and reads a markdown file inside the
      // workspace it was pointed at is doing ordinary file reading, gated by the
      // `fileRead`/`codeExecution` axes like any other read of NOTES.md. Not
      // loaded does not mean unreachable, and only the first is a trust boundary.
      //
      // Asserting the negative here would therefore be asserting that the model
      // does not go looking, which it sometimes does — a flake dressed as
      // coverage, as the denied-tool case above puts it. The rigorous, model-free
      // version of this negative lives in `customSkills.test.ts`.
    },
    TEST_TIMEOUT,
  );

  it(
    "answers the model catalog offline, with no key",
    async () => {
      const { clearPiModelCacheForTesting, getPiModels } = await import("./modelCatalog.js");
      clearPiModelCacheForTesting();
      const saved = process.env.OPENROUTER_API_KEY;
      delete process.env.OPENROUTER_API_KEY;
      try {
        expect((await getPiModels("openrouter")).length).toBeGreaterThan(100);
      } finally {
        if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved;
      }
    },
    TEST_TIMEOUT,
  );
});

/**
 * ## Still unverified, deliberately
 *
 * These are the §10 leftovers this file does **not** close, and an honest gap
 * beats a test that pretends:
 *
 *  - **`willRetry: true` in the wild.** Reproducing it needs a genuine 429 or
 *    5xx from the provider at a moment of our choosing. The code path is read
 *    (`_willRetryAfterAgentEnd` → `isRetryableAssistantError`, a regex over the
 *    error text) and the *handling* is covered by the fixture's
 *    `willRetryFirst` script, but a real retry has never been observed.
 *  - **`streamingBehavior: "steer"` mid-turn.** The adapter does not send it:
 *    `AgentQuery` has no mid-turn input surface, so callboard queues a follow-up
 *    message as a new turn instead. Testing pi's steering would test pi, not the
 *    adapter. It becomes relevant only if callboard grows mid-turn input.
 *  - **Compaction.** `compaction_start`/`end` translate to
 *    `compaction_boundary`, asserted in `messageAdapter.test.ts`. Triggering a
 *    real one means filling a 1M-token context window, which is neither cheap
 *    nor fast. The `overflow` reason in particular has never been seen.
 *  - **Two concurrent pi chats.** `PiAgentQuery.test.ts` proves each query
 *    builds its own `ModelRuntime`, which is the property that matters for
 *    credential bleed. Two *live* chats on different keys at once has not been
 *    run.
 */
