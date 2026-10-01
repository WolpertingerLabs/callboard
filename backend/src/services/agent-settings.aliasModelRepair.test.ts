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
 * out as `ANTHROPIC_MODEL="planner"`. The load path now swaps in the alias's
 * OpenRouter slug and persists the result, but only where the name cannot
 * resolve today. That is not true of every field: routed Codex resolves an alias
 * through its codex target, and the Claude Code CLI resolves its own model names
 * in `ANTHROPIC_MODEL` and `CLAUDE_CODE_SUBAGENT_MODEL`. Both cases are left
 * alone (see the describe blocks below). And while the legacy map still exists,
 * only names from it are touched, since it was the picker's only source.
 *
 * Settings are written to the real file in the worker's scratch data dir
 * (`vitest.setup.node.ts`), because "persisted" is a claim about that file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, linkSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
/** Every `fchownSync` the service makes, and an optional error to throw from it. */
const chown = vi.hoisted(() => ({ calls: [] as [number, number, number][], fail: null as null | string }));
vi.mock("fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("fs")>();
  const writeFileSync = ((path: any, data: any, options?: any) => {
    if (diskFull.match?.(String(path))) {
      real.writeFileSync(path, "", options);
      throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    }
    return real.writeFileSync(path, data, options);
  }) as typeof real.writeFileSync;
  const fchownSync = ((fd: number, uid: number, gid: number) => {
    chown.calls.push([fd, uid, gid]);
    if (chown.fail) throw Object.assign(new Error(`${chown.fail}: operation not permitted, fchown`), { code: chown.fail });
    return real.fchownSync(fd, uid, gid);
  }) as typeof real.fchownSync;
  return { ...real, default: { ...real, writeFileSync, fchownSync }, writeFileSync, fchownSync };
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
  chown.calls = [];
  chown.fail = null;
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

  it("are repaired from the cross-harness registry once the legacy map has been retired, case-insensitively", () => {
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
 * While the legacy `openRouterModelAliases` map still exists, it is the only
 * source of names the picker could have written, so only its names are
 * candidates, and its slug (the one the picker showed) is the replacement.
 */
describe("while the legacy alias map still exists", () => {
  it("leaves names that only the registry knows alone", () => {
    writeSettings({
      claudeCodeOpenRouterModel: "planner",
      openRouterUtilityHaikuModel: "coder",
      openRouterModelAliases: { planner: SLUG },
      modelAliases: [{ name: "coder", targets: { openrouter: "qwen/qwen3-coder" } }],
    });

    const s = getAgentSettings();
    expect(s.claudeCodeOpenRouterModel).toBe(SLUG);
    expect(s.openRouterUtilityHaikuModel).toBe("coder");
  });

  it("uses the legacy map's slug, which is what the picker showed, over a registry target that differs", () => {
    writeSettings({
      openRouterUtilitySonnetModel: "Planner",
      openRouterModelAliases: { planner: SLUG },
      modelAliases: [{ name: "planner", targets: { openrouter: "other/model" } }],
    });

    expect(getAgentSettings().openRouterUtilitySonnetModel).toBe(SLUG);
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

  // The CLI strips a trailing `[1m]` and checks the base, so these resolve
  // although they are not in its list of names.
  it.each(["haiku[1m]", "best[1m]", "opusplan[1m]", "OPUS[1M]"])("leave %s alone in ANTHROPIC_MODEL and the subagent field", (name) => {
    writeSettings({
      claudeCodeOpenRouterModel: name,
      claudeCodeOpenRouterSubagentModel: name,
      openRouterModelAliases: { [name]: SLUG },
    });

    const s = getAgentSettings();
    expect(s.claudeCodeOpenRouterModel).toBe(name);
    expect(s.claudeCodeOpenRouterSubagentModel).toBe(name);
  });

  it("treat `inherit` as a CLI name only in the subagent field", () => {
    writeSettings({
      claudeCodeOpenRouterModel: "inherit",
      claudeCodeOpenRouterSubagentModel: "inherit",
      openRouterModelAliases: { inherit: SLUG },
    });

    const s = getAgentSettings();
    expect(s.claudeCodeOpenRouterModel).toBe(SLUG);
    expect(s.claudeCodeOpenRouterSubagentModel).toBe("inherit");
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

  it("keeps the file's exact mode, even where the umask would strip bits from it", () => {
    writeSettings({ codexModel: "a" });
    chmodSync(SETTINGS_FILE, 0o664);
    // pm2's and systemd's default; it alone would turn a new 0664 into 0644.
    const previous = process.umask(0o022);
    try {
      updateAgentSettings({ codexModel: "b" });
    } finally {
      process.umask(previous);
    }

    expect(onDisk().codexModel).toBe("b");
    expect(statSync(SETTINGS_FILE).mode & 0o777).toBe(0o664);
  });

  it("gives the new file the original's owner and group", () => {
    writeSettings({ codexModel: "a" });
    const { uid, gid } = statSync(SETTINGS_FILE);

    updateAgentSettings({ codexModel: "b" });

    expect(chown.calls.map(([, u, g]) => [u, g])).toEqual([[uid, gid]]);
  });

  it("still saves when it is not allowed to set the owner", () => {
    writeSettings({ codexModel: "a" });
    chown.fail = "EPERM";

    updateAgentSettings({ codexModel: "b" });

    expect(onDisk().codexModel).toBe("b");
    expect(leftovers()).toEqual([]);
  });

  it("creates the file on the first save", () => {
    updateAgentSettings({ codexModel: "first" });

    expect(lstatSync(SETTINGS_FILE).isFile()).toBe(true);
    expect(onDisk().codexModel).toBe("first");
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

/**
 * A rename replaces whatever is at the path it targets. A settings file kept as
 * a link (dotfiles, a synced folder) must stay a link, and the write must land
 * in the file it points at, including when a plain read triggers the repair.
 */
describe("saving a linked settings file", () => {
  let elsewhere: string;
  beforeEach(() => {
    elsewhere = mkdtempSync(join(tmpdir(), "cb-settings-link-"));
  });
  afterEach(() => {
    rmSync(elsewhere, { recursive: true, force: true });
  });

  const real = () => join(elsewhere, "agent-settings.json");
  const readReal = (): AgentSettings => JSON.parse(readFileSync(real(), "utf-8"));

  it("writes through a symlink and keeps it a symlink", () => {
    writeFileSync(real(), JSON.stringify({ proxyMode: "local", codexModel: "a" }));
    symlinkSync(real(), SETTINGS_FILE);

    updateAgentSettings({ codexModel: "b" });

    expect(lstatSync(SETTINGS_FILE).isSymbolicLink()).toBe(true);
    expect(readReal().codexModel).toBe("b");
    expect(readdirSync(elsewhere)).toEqual(["agent-settings.json"]);
  });

  it("keeps the symlink when a plain read triggers the alias repair", () => {
    writeFileSync(real(), JSON.stringify({ proxyMode: "local", claudeCodeOpenRouterModel: "planner", openRouterModelAliases: { planner: SLUG } }));
    symlinkSync(real(), SETTINGS_FILE);

    getAgentSettings();

    expect(lstatSync(SETTINGS_FILE).isSymbolicLink()).toBe(true);
    expect(readReal().claudeCodeOpenRouterModel).toBe(SLUG);
  });

  it("creates the target of a symlink that points at nothing yet, and keeps the link", () => {
    symlinkSync(real(), SETTINGS_FILE);

    updateAgentSettings({ codexModel: "first" });

    expect(lstatSync(SETTINGS_FILE).isSymbolicLink()).toBe(true);
    expect(readReal().codexModel).toBe("first");
  });

  it("keeps a hard-linked file linked: both names see the new value", () => {
    writeSettings({ codexModel: "a" });
    linkSync(SETTINGS_FILE, real());

    updateAgentSettings({ codexModel: "b" });

    expect(statSync(SETTINGS_FILE).nlink).toBe(2);
    expect(readReal().codexModel).toBe("b");
  });
});
