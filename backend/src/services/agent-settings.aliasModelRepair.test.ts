/**
 * Repairing alias names already saved in the OpenRouter-only model fields.
 *
 * The OpenRouter model picker used to pin the deprecated OpenRouter-only aliases
 * at the top of its list, so a user could save `planner` into a field that is
 * sent to OpenRouter verbatim:
 *
 *  - the five `claudeCodeOpenRouter*Model` role fields (→ `ANTHROPIC_*MODEL`);
 *  - `codexOpenRouterModel`;
 *  - the three `openRouterUtility*Model` tiers.
 *
 * #465 stopped offering those aliases, but values saved before it still went
 * out as `ANTHROPIC_MODEL="planner"`. Every one of these fields holds an
 * OpenRouter slug and nothing else, so the alias's `openrouter` target is the
 * unambiguous replacement. The load path now swaps it in and persists the result.
 *
 * Settings are written to the real file in the worker's scratch data dir
 * (`vitest.setup.node.ts`), because "persisted" is a claim about that file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSettings } from "shared";
import { DATA_DIR } from "../utils/paths.js";

const logs = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../utils/logger.js", () => ({ createLogger: () => logs, default: () => logs }));

/**
 * A disk that fills up mid-write: the matched path is opened (and so truncated
 * or created) and then the write fails, exactly as ENOSPC leaves it. Off unless
 * a test sets `match`. Only the `fs` specifier the service imports is wrapped;
 * this file reads and writes through `node:fs`, which stays real.
 */
const diskFull = vi.hoisted(() => ({ match: null as null | ((path: string) => boolean) }));
vi.mock("fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("fs")>();
  const writeFileSync = ((path: any, data: any, options?: any) => {
    if (diskFull.match?.(String(path))) {
      real.writeFileSync(path, "", options);
      throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    }
    return real.writeFileSync(path, data, options);
  }) as typeof real.writeFileSync;
  return { ...real, default: { ...real, writeFileSync }, writeFileSync };
});

import { getAgentSettings, getApiEnvOverrides, readAgentSettings, updateAgentSettings } from "./agent-settings.js";
import { resolveUtilityModel } from "./openrouter-completion.js";

const SETTINGS_FILE = join(DATA_DIR, "agent-settings.json");

const ROLE_FIELDS = [
  "claudeCodeOpenRouterModel",
  "claudeCodeOpenRouterOpusModel",
  "claudeCodeOpenRouterSonnetModel",
  "claudeCodeOpenRouterHaikuModel",
  "claudeCodeOpenRouterSubagentModel",
] as const;
const UTILITY_FIELDS = ["openRouterUtilityHaikuModel", "openRouterUtilitySonnetModel", "openRouterUtilityOpusModel"] as const;
const ALL_FIELDS = [...ROLE_FIELDS, "codexOpenRouterModel", ...UTILITY_FIELDS] as const;

const SLUG = "deepseek/deepseek-chat";

function writeSettings(settings: Partial<AgentSettings>): void {
  writeFileSync(SETTINGS_FILE, JSON.stringify({ proxyMode: "local", ...settings }, null, 2));
}

const onDisk = (): AgentSettings => JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));

/** Every OpenRouter-only field set to `value`. */
const everyField = (value: string) => Object.fromEntries(ALL_FIELDS.map((f) => [f, value])) as Partial<AgentSettings>;

beforeEach(() => {
  rmSync(SETTINGS_FILE, { force: true });
});

afterEach(() => {
  diskFull.match = null;
  rmSync(SETTINGS_FILE, { force: true });
  for (const fn of Object.values(logs)) fn.mockClear();
});

describe("alias names saved in OpenRouter-only model fields", () => {
  it("are replaced by the legacy alias's OpenRouter slug in every field class", () => {
    writeSettings({ ...everyField("planner"), openRouterModelAliases: { planner: SLUG } });

    const s = getAgentSettings();
    for (const field of ALL_FIELDS) expect(s[field], field).toBe(SLUG);
  });

  it("reach the places the reviewer probed as the slug, not the alias name", () => {
    writeSettings({
      claudeCodeUseOpenRouter: true,
      claudeCodeOpenRouterApiKey: "sk-or-test",
      claudeCodeOpenRouterModel: "planner",
      openRouterUtilityHaikuModel: "planner",
      openRouterModelAliases: { planner: SLUG },
    });

    expect(getApiEnvOverrides().ANTHROPIC_MODEL).toBe(SLUG);
    expect(resolveUtilityModel("haiku")).toBe(SLUG);
  });

  it("are repaired from the cross-harness registry too, case-insensitively", () => {
    writeSettings({
      ...everyField("Planner"),
      modelAliases: [{ name: "planner", targets: { openrouter: SLUG, "claude-code": "opus" } }],
    });

    const s = getAgentSettings();
    for (const field of ALL_FIELDS) expect(s[field], field).toBe(SLUG);
  });

  it("persist the repaired value to the settings file", () => {
    writeSettings({ ...everyField("planner"), openRouterModelAliases: { planner: SLUG } });

    getAgentSettings();
    const saved = onDisk();
    for (const field of ALL_FIELDS) expect(saved[field], field).toBe(SLUG);
  });

  it("leave real model ids untouched", () => {
    writeSettings({ ...everyField("anthropic/claude-opus-4.8"), codexOpenRouterModel: "openai/gpt-5.5", openRouterModelAliases: { planner: SLUG } });
    const before = readFileSync(SETTINGS_FILE, "utf-8");

    const s = getAgentSettings();
    expect(s.claudeCodeOpenRouterModel).toBe("anthropic/claude-opus-4.8");
    expect(s.openRouterUtilityOpusModel).toBe("anthropic/claude-opus-4.8");
    expect(s.codexOpenRouterModel).toBe("openai/gpt-5.5");
    // Nothing to repair, so nothing is written.
    expect(readFileSync(SETTINGS_FILE, "utf-8")).toBe(before);
  });

  it("change nothing on a second pass", () => {
    writeSettings({ ...everyField("planner"), openRouterModelAliases: { planner: SLUG } });

    const first = getAgentSettings();
    expect(first.claudeCodeOpenRouterModel).toBe(SLUG);
    const fileAfterFirst = readFileSync(SETTINGS_FILE, "utf-8");
    const second = getAgentSettings();

    expect(second).toEqual(first);
    expect(readFileSync(SETTINGS_FILE, "utf-8")).toBe(fileAfterFirst);
  });

  it("are left as-is, with a warning, when the alias has no OpenRouter target", () => {
    writeSettings({
      claudeCodeOpenRouterModel: "worker",
      modelAliases: [{ name: "worker", targets: { codex: "gpt-5.5" } }],
    });
    const before = readFileSync(SETTINGS_FILE, "utf-8");

    expect(getAgentSettings().claudeCodeOpenRouterModel).toBe("worker");
    expect(readFileSync(SETTINGS_FILE, "utf-8")).toBe(before);
    expect(logs.warn.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/claudeCodeOpenRouterModel.*"worker".*no openrouter target/i);
  });
});

/**
 * `codexOpenRouterModel` is not sent verbatim: routed Codex resolves it through
 * the alias's **codex** target (`resolveReasoningTarget` →
 * `resolveSessionModel(…, "codex")`), and an alias there is a supported setup.
 * Only an alias with no codex target is broken today (it falls back to the
 * default), and only that one is repaired.
 */
describe("alias names in codexOpenRouterModel", () => {
  it("are left alone, file untouched, when the alias has a codex target as well as an openrouter one", () => {
    writeSettings({
      codexUseOpenRouter: true,
      codexOpenRouterModel: "fast",
      modelAliases: [{ name: "fast", targets: { codex: "openai/gpt-5.5-mini", openrouter: "openai/gpt-4o-mini" } }],
    });
    const before = readFileSync(SETTINGS_FILE, "utf-8");

    expect(getAgentSettings().codexOpenRouterModel).toBe("fast");
    expect(readFileSync(SETTINGS_FILE, "utf-8")).toBe(before);
    expect(logs.warn).not.toHaveBeenCalled();
  });

  it("are left alone, with no warning, when the alias has only a codex target", () => {
    writeSettings({ codexOpenRouterModel: "worker", modelAliases: [{ name: "worker", targets: { codex: "openai/gpt-5.5" } }] });
    const before = readFileSync(SETTINGS_FILE, "utf-8");

    expect(getAgentSettings().codexOpenRouterModel).toBe("worker");
    expect(readFileSync(SETTINGS_FILE, "utf-8")).toBe(before);
    expect(logs.warn).not.toHaveBeenCalled();
  });

  it("warn, and stay as-is, when the alias has neither a codex nor an openrouter target", () => {
    writeSettings({ codexOpenRouterModel: "thinker", modelAliases: [{ name: "thinker", targets: { "claude-code": "opus" } }] });

    expect(getAgentSettings().codexOpenRouterModel).toBe("thinker");
    expect(logs.warn.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/codexOpenRouterModel.*"thinker".*no openrouter target/i);
  });
});

/**
 * `ANTHROPIC_MODEL` and `CLAUDE_CODE_SUBAGENT_MODEL` go to the Claude Code CLI,
 * which resolves its own model names there (`opus`, `sonnet`, …). A callboard
 * alias can share such a name, and the value already works, so it is left
 * alone. The three `ANTHROPIC_DEFAULT_*_MODEL` tiers are read by the CLI as
 * concrete ids, so the same name there is broken and is repaired.
 */
describe("Claude Code's own model names in the routed role fields", () => {
  it("are left alone where the CLI resolves them, and repaired where it does not", () => {
    writeSettings({
      claudeCodeOpenRouterModel: "opus",
      claudeCodeOpenRouterSubagentModel: "Sonnet",
      claudeCodeOpenRouterOpusModel: "opus",
      modelAliases: [
        { name: "opus", targets: { openrouter: "anthropic/claude-opus-4.8" } },
        { name: "sonnet", targets: { openrouter: "anthropic/claude-sonnet-4.6" } },
      ],
    });

    const s = getAgentSettings();
    expect(s.claudeCodeOpenRouterModel).toBe("opus");
    expect(s.claudeCodeOpenRouterSubagentModel).toBe("Sonnet");
    expect(s.claudeCodeOpenRouterOpusModel).toBe("anthropic/claude-opus-4.8");
    expect(logs.warn).not.toHaveBeenCalled();
  });
});

const isRoot = process.getuid?.() === 0;

describe("a repair that cannot be written", () => {
  // Root ignores file permissions, so there is no read-only file to test with.
  it.skipIf(isRoot)("still reads as ok, with the repaired value, and logs once per field and value", () => {
    writeSettings({ claudeCodeOpenRouterModel: "planner-ro", openRouterModelAliases: { "planner-ro": SLUG } });
    chmodSync(SETTINGS_FILE, 0o444);
    const before = readFileSync(SETTINGS_FILE, "utf-8");

    for (let i = 0; i < 3; i++) {
      const read = readAgentSettings();
      expect(read.state).toBe("ok");
      expect(read.settings.claudeCodeOpenRouterModel).toBe(SLUG);
    }
    expect(readFileSync(SETTINGS_FILE, "utf-8")).toBe(before);

    const infos = logs.info.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('"planner-ro"'));
    const warns = logs.warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("Could not persist"));
    expect(infos).toHaveLength(1);
    expect(warns).toHaveLength(1);
  });
});

describe("saving settings", () => {
  const leftovers = () => readdirSync(DATA_DIR).filter((f) => f.startsWith(".agent-settings.json.") && f.endsWith(".tmp"));

  it("keeps the file's existing mode", () => {
    writeSettings({ codexModel: "a" });
    chmodSync(SETTINGS_FILE, 0o600);

    updateAgentSettings({ codexModel: "b" });

    expect(onDisk().codexModel).toBe("b");
    expect(statSync(SETTINGS_FILE).mode & 0o777).toBe(0o600);
  });

  it("leaves the original file intact, and no temp file behind, when the write fails part-way", () => {
    writeSettings({ codexModel: "kept", openRouterApiKey: "sk-or-keep-me" });
    const before = readFileSync(SETTINGS_FILE, "utf-8");
    diskFull.match = (path) => path.includes("agent-settings.json");

    expect(() => updateAgentSettings({ codexModel: "lost" })).toThrow(/ENOSPC/);

    diskFull.match = null;
    expect(readFileSync(SETTINGS_FILE, "utf-8")).toBe(before);
    expect(leftovers()).toEqual([]);
  });
});
