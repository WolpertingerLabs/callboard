/**
 * Contract with the real Agent SDK: what it puts on Claude Code's command line
 * for `permissionMode`. No model call — `spawnClaudeCodeProcess` records the
 * argv and launches a process that exits at once.
 *
 * Why this matters: since Agent SDK 0.3.286 an omitted `permissionMode` is
 * left to Claude Code, which then takes `permissions.defaultMode` from the
 * settings files callboard loads (`settingSources: ["user", "project",
 * "local"]`). A repo committing `defaultMode: "acceptEdits"` ran Write under a
 * deny-everything canUseTool (reproduced against CLI 2.1.332). callboard
 * therefore always passes `permissionMode: "default"` (claude.ts, pinned by
 * the queryOptions characterization test); this file pins the SDK half: that
 * the explicit value reaches the CLI as a flag, which outranks settings.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { query } from "@anthropic-ai/claude-agent-sdk";

const cwd = mkdtempSync(join(tmpdir(), "callboard-pm-sdk-"));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

async function argvFor(permissionMode: "default" | undefined, extra: Record<string, unknown> = {}): Promise<string[]> {
  let args: string[] = [];
  const q = query({
    prompt: "unused",
    options: {
      cwd,
      settingSources: ["user", "project", "local"],
      persistSession: false,
      ...(permissionMode && { permissionMode }),
      ...extra,
      canUseTool: async () => ({ behavior: "deny", message: "test" }),
      spawnClaudeCodeProcess: (opts) => {
        args = opts.args;
        return spawn(process.execPath, ["-e", ""], { stdio: ["pipe", "pipe", "pipe"] });
      },
    },
  });
  try {
    for await (const _ of q) {
      // The stand-in exits at once; the stream ends or throws.
    }
  } catch {
    // Expected: "Claude Code process exited …".
  }
  return args;
}

/** `--flag=value` (what 0.3.332 sends) or `--flag value`. */
function flagValue(args: string[], flag: string): string | undefined {
  const joined = args.find((a) => a.startsWith(`${flag}=`));
  if (joined) return joined.slice(flag.length + 1);
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

describe("Agent SDK — permissionMode on the Claude Code command line", () => {
  it("passes an explicit permissionMode: 'default' as --permission-mode default", async () => {
    expect(flagValue(await argvFor("default"), "--permission-mode")).toBe("default");
  });

  it("omits the flag when permissionMode is omitted — which is why callboard must never omit it", async () => {
    // If a future SDK goes back to defaulting the flag, this fails and the
    // explicit value in claude.ts becomes belt-and-braces rather than load-bearing.
    expect(flagValue(await argvFor(undefined), "--permission-mode")).toBeUndefined();
  });
});

describe("Agent SDK — options.settings on the Claude Code command line", () => {
  it("passes the repo-config lockdown (repo-config-trust.ts) as --settings JSON with the same keys and values", async () => {
    // claude.repoHooks.sdk.test.ts proves the CLI honours the object; this pins
    // that the SDK still hands it over as a flag, which is the tier that
    // outranks project and local settings.
    const { repoLockdownSettings } = await import("../../../services/repo-config-trust.js");
    const settings = repoLockdownSettings(cwd, { HOME: "/nonexistent" });
    const raw = flagValue(await argvFor("default", { settings }), "--settings");
    expect(raw).toBeDefined();
    expect(JSON.parse(raw!)).toEqual(settings);
  });
});
