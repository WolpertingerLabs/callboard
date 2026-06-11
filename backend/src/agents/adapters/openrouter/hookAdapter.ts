/**
 * Plugin hook dispatch for the OpenRouter adapter.
 *
 * The OR library v1 does NOT execute plugin hook commands — it parses them onto
 * {@link LoadedPlugin.hookConfigs} and expects the host to dispatch (agent.ts
 * spec note on `plugins`). The run accepts a single `onHook(event, payload)`
 * callback that fires on every lifecycle event (`PreToolUse`, `PostToolUse`,
 * `SessionStart`, `SessionEnd`, `Stop`, …). This module builds an `onHook` that,
 * for each fired event, runs the matching plugin `hooks/hooks.json` command(s) —
 * the same configs the Claude path runs via claude.ts#buildHookOptions, but
 * driven off the OR library's own loaded-plugin output so the two paths stay
 * independent.
 *
 * Scope note: this implements the full dispatch plumbing AND bash-command
 * execution. Each command receives a Claude-shaped {@link HookInput} JSON on
 * stdin and may emit a {@link HookJSONOutput} JSON on stdout. PreToolUse
 * decisions honored under OR:
 *
 * - `deny`/`block` → the library's `{ action: "block" }` (tool never runs).
 * - `ask` → stash the reason on the shared {@link HookContext.hookAskOverride}
 *   and continue. The OR `onHook` contract has no `ask` channel, but it
 *   doesn't need one: in the harness, PreToolUse hooks fire BEFORE canUseTool
 *   (the hook wrapper composes OUTSIDE the permission wrapper — see harness
 *   agent.ts `wrapTool`), and the canUseTool callboard forwards to the OR run
 *   is the SAME buildCanUseTool product the Claude path uses, which checks
 *   the override, skips auto-approval, and prompts the user. Identical
 *   stash-then-check sequencing to the Claude path.
 * - `hookSpecificOutput.updatedInput` → the library's `{ action: "modify",
 *   input }` (the substituted input is what canUseTool and the tool see).
 */
import { execFile } from "node:child_process";
import {
  type HookEvent,
  type HookPayload,
  type LoadedPlugin,
  type OnHook,
  type PreToolUseAction,
} from "@wolpertingerlabs/openrouter-agent-harness";
import type { OrAdapterLogger } from "./pluginAdapter.js";

/** One executable hook command resolved from a plugin's hooks.json matcher. */
interface ResolvedHook {
  /** Tool-name matcher pattern (regex source). `undefined`/"" → match all tools. */
  matcher?: string;
  command: string;
  /** Plugin root for ${CLAUDE_PLUGIN_ROOT} substitution + as the child cwd-ish env. */
  pluginRoot: string;
  timeoutMs: number;
}

interface HookContext {
  signal?: AbortSignal;
  getSessionId: () => string;
  cwd: string;
  logger?: OrAdapterLogger;
  /**
   * Shared mutable cell claude.ts threads through the options blob (same
   * object instance buildCanUseTool closes over). A PreToolUse hook that
   * decides `ask` writes its reason here; the forwarded canUseTool sees a
   * non-empty reason, skips auto-approval, prompts the user, and resets it.
   */
  hookAskOverride?: { reason: string };
}

/**
 * Build an OR `onHook` that dispatches plugin hook commands. Returns `undefined`
 * when no plugin contributes any command hooks (so the caller can skip wiring
 * and leave any caller-supplied `onHook` untouched).
 */
export function buildOpenRouterHookDispatcher(
  loadedPlugins: readonly LoadedPlugin[],
  ctx: HookContext,
): OnHook | undefined {
  // event name → list of resolved command hooks, merged across all plugins.
  const byEvent = new Map<string, ResolvedHook[]>();

  for (const plugin of loadedPlugins) {
    for (const config of plugin.hookConfigs) {
      const hooks = config.hooks;
      if (!hooks || typeof hooks !== "object") continue;
      for (const [eventName, rawMatchers] of Object.entries(hooks)) {
        if (!Array.isArray(rawMatchers)) continue;
        for (const matcher of rawMatchers) {
          if (!matcher || typeof matcher !== "object") continue;
          const m = matcher as { matcher?: unknown; timeout?: unknown; hooks?: unknown };
          if (!Array.isArray(m.hooks)) continue;
          for (const entry of m.hooks) {
            if (!entry || typeof entry !== "object") continue;
            const e = entry as { type?: unknown; command?: unknown; timeout?: unknown };
            if (e.type !== "command" || typeof e.command !== "string") continue;
            // ${CLAUDE_PLUGIN_ROOT} is substituted here (parity with claude.ts);
            // the same value is also exported to the child env below.
            const command = e.command.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, plugin.root);
            const timeoutSec =
              (typeof e.timeout === "number" ? e.timeout : undefined) ??
              (typeof m.timeout === "number" ? m.timeout : undefined) ??
              60;
            const list = byEvent.get(eventName) ?? [];
            list.push({
              ...(typeof m.matcher === "string" && { matcher: m.matcher }),
              command,
              pluginRoot: plugin.root,
              timeoutMs: timeoutSec * 1000,
            });
            byEvent.set(eventName, list);
          }
        }
      }
    }
  }

  if (byEvent.size === 0) return undefined;

  return async (event: HookEvent, payload: HookPayload): Promise<void | PreToolUseAction> => {
    const hooks = byEvent.get(event);
    if (!hooks || hooks.length === 0) return;

    const toolName = toolNameForEvent(payload);
    const input = buildHookInput(event, payload, ctx);

    // Last `updatedInput` seen across matching hooks. Held until the loop
    // ends so a later hook's deny still wins over an earlier hook's modify
    // (parity with the Claude SDK, which runs every matching hook before
    // acting on the merged output).
    let pendingModify: PreToolUseAction | undefined;

    for (const hook of hooks) {
      if (toolName !== undefined && !matchesTool(hook.matcher, toolName)) continue;
      const output = await runHookCommand(hook, input, ctx);
      // Only PreToolUse can short-circuit the call. Map a deny/block decision to
      // the library's block action; everything else continues.
      if (event === "PreToolUse" && output) {
        const decision =
          output.hookSpecificOutput?.permissionDecision ?? output.decision ?? undefined;
        if (decision === "deny" || decision === "block") {
          const reason =
            output.hookSpecificOutput?.permissionDecisionReason ??
            output.reason ??
            "Blocked by plugin hook";
          return { action: "block", reason };
        }
        if (decision === "ask" && ctx.hookAskOverride) {
          // No `ask` action exists on the OR PreToolUseAction union — none is
          // needed. Stash the reason and continue: the harness runs PreToolUse
          // hooks before canUseTool, and the forwarded canUseTool (claude.ts
          // buildCanUseTool) treats a non-empty override reason as "skip
          // auto-approval, prompt the user" — exactly the Claude-path flow.
          ctx.hookAskOverride.reason =
            output.hookSpecificOutput?.permissionDecisionReason || "Hook requested user approval";
        }
        const updatedInput = output.hookSpecificOutput?.updatedInput;
        if (updatedInput && typeof updatedInput === "object") {
          pendingModify = { action: "modify", input: updatedInput };
        }
      }
    }
    return pendingModify;
  };
}

/** Compose a plugin dispatcher with any caller-supplied `onHook` (dispatcher first). */
export function composeOnHook(
  dispatcher: OnHook | undefined,
  passthrough: OnHook | undefined,
): OnHook | undefined {
  if (!dispatcher) return passthrough;
  if (!passthrough) return dispatcher;
  return async (event, payload) => {
    const a = await dispatcher(event, payload);
    if (a && event === "PreToolUse" && (a as PreToolUseAction).action === "block") return a;
    const b = await passthrough(event, payload);
    return b ?? a;
  };
}

/** Tool name carried by tool-scoped events; `undefined` for non-tool events. */
function toolNameForEvent(payload: HookPayload): string | undefined {
  if (payload.event === "PreToolUse" || payload.event === "PostToolUse") {
    return payload.toolName;
  }
  return undefined;
}

/**
 * Match a hooks.json matcher pattern against a tool name. An empty / undefined /
 * "*" matcher matches every tool (Claude semantics). Otherwise the pattern is
 * treated as a regex; an invalid pattern falls back to a literal compare.
 */
function matchesTool(pattern: string | undefined, toolName: string): boolean {
  if (!pattern || pattern === "*" || pattern === ".*") return true;
  try {
    return new RegExp(pattern).test(toolName);
  } catch {
    return pattern === toolName;
  }
}

/** Shape a Claude-style HookInput JSON for the command's stdin. */
function buildHookInput(
  event: HookEvent,
  payload: HookPayload,
  ctx: HookContext,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    hook_event_name: event,
    session_id: ctx.getSessionId(),
    cwd: ctx.cwd,
  };
  if (payload.event === "PreToolUse") {
    base.tool_name = payload.toolName;
    base.tool_input = payload.input;
  } else if (payload.event === "PostToolUse") {
    base.tool_name = payload.toolName;
    base.tool_input = payload.input;
    base.tool_response = payload.output;
  }
  return base;
}

/** Parsed subset of a hook command's stdout JSON we act on. */
interface HookJSONOutput {
  decision?: string;
  reason?: string;
  hookSpecificOutput?: {
    permissionDecision?: string;
    permissionDecisionReason?: string;
    /** Substituted tool input (Claude SDK PreToolUseHookSpecificOutput shape). */
    updatedInput?: Record<string, unknown>;
  };
}

/**
 * Run one hook command: pipe `input` as JSON to stdin, parse stdout as JSON.
 * Failures (non-zero exit, timeout, non-JSON output) are logged and treated as
 * "continue" — a broken hook never blocks the run.
 */
function runHookCommand(
  hook: ResolvedHook,
  input: Record<string, unknown>,
  ctx: HookContext,
): Promise<HookJSONOutput | null> {
  return new Promise<HookJSONOutput | null>((resolve) => {
    const child = execFile(
      "bash",
      ["-c", hook.command],
      { timeout: hook.timeoutMs, env: { ...process.env, CLAUDE_PLUGIN_ROOT: hook.pluginRoot } },
      (error, stdout) => {
        if (error) {
          ctx.logger?.("warn", `[openrouter] hook command failed: ${hook.command} — ${error.message}`);
          resolve(null);
          return;
        }
        const text = stdout.trim();
        if (text.length === 0) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(text) as HookJSONOutput);
        } catch {
          ctx.logger?.("warn", `[openrouter] hook returned non-JSON output: ${hook.command}`);
          resolve(null);
        }
      },
    );

    ctx.signal?.addEventListener("abort", () => child.kill(), { once: true });

    if (child.stdin) {
      // A hook command that never reads stdin (e.g. a bare `echo`) may close its
      // input before we finish writing, surfacing an async EPIPE on the stream.
      // Swallow it — the command's own exit/output is what we act on.
      child.stdin.on("error", () => {});
      child.stdin.write(JSON.stringify(input), () => {});
      child.stdin.end();
    }
  });
}
