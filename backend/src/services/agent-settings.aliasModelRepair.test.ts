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
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSettings } from "shared";
import { DATA_DIR } from "../utils/paths.js";

const logs = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../utils/logger.js", () => ({ createLogger: () => logs, default: () => logs }));

import { getAgentSettings, getApiEnvOverrides } from "./agent-settings.js";
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
      codexOpenRouterModel: "worker",
      modelAliases: [{ name: "worker", targets: { codex: "gpt-5.5" } }],
    });
    const before = readFileSync(SETTINGS_FILE, "utf-8");

    const s = getAgentSettings();
    expect(s.claudeCodeOpenRouterModel).toBe("worker");
    expect(s.codexOpenRouterModel).toBe("worker");
    expect(readFileSync(SETTINGS_FILE, "utf-8")).toBe(before);
    const logged = logs.warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toMatch(/claudeCodeOpenRouterModel.*"worker".*no openrouter target/i);
    expect(logged).toMatch(/codexOpenRouterModel.*"worker".*no openrouter target/i);
  });
});
