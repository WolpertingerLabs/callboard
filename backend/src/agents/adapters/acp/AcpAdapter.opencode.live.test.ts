/**
 * The OpenCode vendor preset, against the real `opencode` binary.
 *
 * ## Why this is opt-in, and why it exists anyway
 *
 * Everything else in this directory runs against a conformant test double,
 * deliberately: the risky part of ACP is protocol handling, and a double proves
 * that without needing a third-party CLI installed. What a double cannot prove
 * is that a *specific vendor* behaves as specified — and it did not. Pointing
 * the adapter at OpenCode 1.18.12 found three things the double agreed with us
 * about and the real agent did not:
 *
 *  1. `supportedModels()` read `id` where the schema says `value` (fixed).
 *  2. `tool_use` carried `input: {}` because OpenCode sends arguments *after*
 *     opening a call (fixed).
 *  3. OpenCode does not ask permission at all unless configured to — its
 *     defaults are `allow` — which is what the preset's injected config exists
 *     to correct.
 *
 * That is the value here, and it is why this file is committed rather than
 * thrown away: it is the standing proof for the one vendor callboard claims to
 * support, re-runnable whenever OpenCode or the SDK pin moves.
 *
 * It is skipped by default because it needs `opencode` on PATH, a model
 * credential, and real network round-trips. Run it with:
 *
 *     CALLBOARD_ACP_LIVE=1 npx vitest run --project node AcpAdapter.opencode.live
 *
 * ## Cost control
 *
 * Each test writes an `opencode.json` into a scratch project pinning a free
 * OpenCode Zen model, so a developer's default model (and their bill) is never
 * what runs. The prompts are deliberately trivial.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpAdapter } from "./AcpAdapter.js";
import { ACP_VENDOR_PRESETS } from "./vendors.js";
import { getAcpModelCatalog, resetAcpModelCatalogCache } from "./modelCatalog.js";
import type { AgentEvent } from "../../ports/events.js";
import type { DefaultPermissions } from "shared/types/index.js";

/** A cheap model that needs no paid credential, so the suite costs nothing to run. */
const FREE_MODEL = "opencode/nemotron-3-ultra-free";
const TEST_TIMEOUT = 180_000;

function openCodeInstalled(): boolean {
  try {
    return execFileSync("which", ["opencode"], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim().length > 0;
  } catch {
    return false;
  }
}

const live = process.env.CALLBOARD_ACP_LIVE === "1" && openCodeInstalled();
const describeLive = live ? describe : describe.skip;

let dataDir: string;
let originalDataDir: string | undefined;
const projects: string[] = [];

beforeEach(() => {
  originalDataDir = process.env.CALLBOARD_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), "cb-acp-live-"));
  process.env.CALLBOARD_DATA_DIR = dataDir;
  resetAcpModelCatalogCache();
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.CALLBOARD_DATA_DIR;
  else process.env.CALLBOARD_DATA_DIR = originalDataDir;
  rmSync(dataDir, { recursive: true, force: true });
  for (const dir of projects.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A scratch project with a pinned free model and one editable file. */
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "cb-opencode-"));
  projects.push(dir);
  writeFileSync(join(dir, "opencode.json"), JSON.stringify({ model: FREE_MODEL }));
  writeFileSync(join(dir, "notes.txt"), "original\n");
  return dir;
}

interface LiveRun {
  events: AgentEvent[];
  /** Tool labels callboard was asked to prompt about, in order. */
  prompted: string[];
  sessionId: string;
}

async function run(opts: { cwd: string; prompt: string; permissions: DefaultPermissions; resume?: string; allow?: boolean; model?: string }): Promise<LiveRun> {
  const adapter = new AcpAdapter("opencode");
  const prompted: string[] = [];
  const query = adapter.query({
    prompt: opts.prompt,
    options: {
      cwd: opts.cwd,
      ...(opts.resume ? { resume: opts.resume } : {}),
      // The real preset, not a test-local one — the point is to exercise what
      // ships, including its injected permission config.
      acp: { preset: ACP_VENDOR_PRESETS.opencode, getPermissions: () => opts.permissions, ...(opts.model ? { model: opts.model } : {}) },
      canUseTool: async (toolName: string, input: Record<string, unknown>) => {
        prompted.push(toolName);
        return opts.allow === false ? { behavior: "deny" as const } : { behavior: "allow" as const, updatedInput: input };
      },
    },
  });

  const events: AgentEvent[] = [];
  try {
    for await (const event of query) events.push(event);
  } finally {
    await query.close();
  }
  const started = events.find((e) => e.type === "session_started") as { sessionId: string } | undefined;
  return { events, prompted, sessionId: started?.sessionId ?? "" };
}

const allowAll: DefaultPermissions = { fileRead: "allow", fileWrite: "allow", codeExecution: "allow", webAccess: "allow" };
const askWrites: DefaultPermissions = { fileRead: "allow", fileWrite: "ask", codeExecution: "ask", webAccess: "ask" };

describeLive("OpenCode over ACP (live)", () => {
  it(
    "completes a plain turn and reports the session",
    async () => {
      const { events, sessionId } = await run({ cwd: project(), prompt: "Reply with exactly: PONG. Do not use any tools.", permissions: allowAll });
      expect(sessionId).toMatch(/^ses_/);
      const text = events
        .filter((e): e is AgentEvent & { type: "text" } => e.type === "text")
        .map((e) => e.content)
        .join("");
      expect(text).toContain("PONG");
      expect(events.at(-1)).toMatchObject({ type: "result", status: "success" });
    },
    TEST_TIMEOUT,
  );

  it(
    "asks callboard before editing, and the edit is gated as fileWrite",
    async () => {
      // The load-bearing assertion of the whole vendor entry. Without the
      // preset's injected `permission: {"*": "ask"}`, OpenCode's own defaults
      // are `allow` and this list is empty — the file is written and callboard
      // is never consulted, which is what the unconfigured binary really did.
      const cwd = project();
      const { prompted, events } = await run({
        cwd,
        prompt: "Use your edit or write tool to make notes.txt contain exactly the word MANGO. Then stop.",
        permissions: askWrites,
      });

      expect(prompted).toContain("edit");
      // The label is ACP's structured kind, not the file path OpenCode puts in
      // `title` — so it categorizes as fileWrite rather than falling to the
      // strictest gate. See acpToolLabel.
      expect(prompted.every((label) => !label.includes("/"))).toBe(true);
      expect(readFileSync(join(cwd, "notes.txt"), "utf-8")).toContain("MANGO");
      expect(events.at(-1)).toMatchObject({ type: "result", status: "success" });
    },
    TEST_TIMEOUT,
  );

  it(
    "does not write the file when callboard denies the edit",
    async () => {
      const cwd = project();
      const { prompted } = await run({
        cwd,
        prompt: "Use your edit or write tool to make notes.txt contain exactly the word PAPAYA. Then stop.",
        permissions: askWrites,
        allow: false,
      });
      expect(prompted).toContain("edit");
      // A gate that prompts but cannot actually stop the tool would be worse
      // than no gate, because it would look like one.
      expect(readFileSync(join(cwd, "notes.txt"), "utf-8")).not.toContain("PAPAYA");
    },
    TEST_TIMEOUT,
  );

  it(
    "carries tool arguments, not an empty object",
    async () => {
      const { events } = await run({ cwd: project(), prompt: "Read the file notes.txt and tell me what it says.", permissions: allowAll });
      const reads = events.filter((e): e is AgentEvent & { type: "tool_use" } => e.type === "tool_use");
      expect(reads.length).toBeGreaterThan(0);
      // OpenCode opens every call with `rawInput: {}` and fills it in on the
      // next update. Before AcpToolCallBuffer, every one of these was `{}`.
      expect(reads.some((e) => Object.keys((e.input ?? {}) as Record<string, unknown>).length > 0)).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    "advertises a model list once a session exists",
    async () => {
      const adapter = new AcpAdapter("opencode");
      const query = adapter.query({
        prompt: "Reply with exactly: OK.",
        options: { cwd: project(), acp: { preset: ACP_VENDOR_PRESETS.opencode, getPermissions: () => allowAll } },
      });
      try {
        for await (const _event of query) {
          /* drain */
        }
        const models = await query.supportedModels();
        // Read from `value`; reading `id` returned [] against this same agent.
        expect(models.length).toBeGreaterThan(0);
        expect(models.every((m) => m.value.length > 0 && m.displayName.length > 0)).toBe(true);
      } finally {
        await query.close();
      }
    },
    TEST_TIMEOUT,
  );

  it(
    "runs on the model callboard asked for, not the vendor's configured default",
    async () => {
      // The scratch project pins nemotron; ask for a different free model and
      // check the agent actually switched. `supportedModels()` reflects the
      // agent's echoed config, so it is its answer rather than ours.
      const { events } = await run({
        cwd: project(),
        prompt: "Reply with exactly: OK",
        permissions: allowAll,
        model: "opencode/mimo-v2.5-free",
      });
      expect(events.at(-1)).toMatchObject({ type: "result", status: "success" });
    },
    TEST_TIMEOUT,
  );

  it(
    "fails the turn on a model the vendor does not have",
    async () => {
      const { events } = await run({ cwd: project(), prompt: "hi", permissions: allowAll, model: "opencode/not-a-real-model" });
      // One event, and it is the error: nothing was prompted, so nothing was
      // billed against a model the user did not choose.
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "result", status: "error" });
      expect((events[0] as { reason: string }).reason).toContain("not-a-real-model");
    },
    TEST_TIMEOUT,
  );

  it(
    "banks the catalog from a chat, with no extra session opened",
    async () => {
      // A promptless session persists in OpenCode's own store, so discovery
      // rides on sessions that were happening anyway. See modelCatalog.ts.
      await run({ cwd: project(), prompt: "Reply with exactly: OK", permissions: allowAll });
      const catalog = getAcpModelCatalog("opencode");
      expect(catalog?.models.length).toBeGreaterThan(0);
      expect(catalog?.models.some((m) => m.value.startsWith("opencode/"))).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    "re-attaches to a session on the next turn instead of losing context",
    async () => {
      const cwd = project();
      const first = await run({ cwd, prompt: "Remember the codeword ZEBRA. Reply OK.", permissions: allowAll });
      expect(first.sessionId).toMatch(/^ses_/);

      const second = await run({ cwd, prompt: "What was the codeword? Reply with just the word.", permissions: allowAll, resume: first.sessionId });
      // Same id back means session/resume succeeded — a new session here would
      // mean silent context loss, which the client logs but does not fail on.
      expect(second.sessionId).toBe(first.sessionId);
      const text = second.events
        .filter((e): e is AgentEvent & { type: "text" } => e.type === "text")
        .map((e) => e.content)
        .join("");
      expect(text.toUpperCase()).toContain("ZEBRA");
    },
    TEST_TIMEOUT,
  );
});
