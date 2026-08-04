/**
 * ACP vendor presets — the per-vendor delta, expressed as **data**.
 *
 * The whole point of the ACP adapter is that a vendor is configuration, not
 * code: one base client speaks the protocol, and everything a specific CLI
 * needs collapses into the handful of fields below. Anything discoverable at
 * runtime (capabilities, models, modes, slash commands) deliberately does NOT
 * appear here — it comes back from `initialize` / `session/new` and is read off
 * the live connection. That rule is what keeps this file thin; if you find
 * yourself wanting to add a field that the agent could have told us, add the
 * capability read instead.
 *
 * @see plans/acp-adapter.md (Phase 2 — vendor presets)
 */
import type { DefaultPermissions } from "shared/types/index.js";

/**
 * Everything callboard needs to know about an ACP-speaking CLI that it cannot
 * learn by asking the CLI itself.
 */
export interface AcpVendorPreset {
  /** Stable identifier. Pairs with `kind: "acp"` to select an adapter instance. */
  id: string;
  /** Human-readable name for pickers and logs. */
  label: string;
  /** Argv used to spawn the agent. `command[0]` is the binary. */
  command: readonly [string, ...string[]];
  /**
   * Some agents only publish their slash-command list a moment AFTER
   * `session/new` returns, via an `available_commands_update` notification. When
   * true, the client waits (briefly) for that notification before sending the
   * first prompt so the command list is not missed.
   */
  waitForInitialCommands?: boolean;
  /** Cap on the {@link waitForInitialCommands} wait. Defaults to {@link DEFAULT_INITIAL_COMMANDS_WAIT_MS}. */
  initialCommandsWaitTimeoutMs?: number;
  /**
   * Cap on the `initialize` handshake. Defaults to
   * {@link DEFAULT_INITIALIZE_TIMEOUT_MS}.
   *
   * A field rather than a constant because "how long may a CLI take to answer
   * its first request" is genuinely per-vendor — a binary that JIT-compiles or
   * checks for updates on startup is slow in a way the protocol cannot report.
   * It is not something the agent could tell us (it has not spoken yet), which
   * is what qualifies it for this file.
   */
  initializeTimeoutMs?: number;
  /**
   * Extra vendor-specific keys merged into `clientCapabilities._meta` on
   * `initialize`. `_meta` is ACP's sanctioned extension point, so this stays
   * inside the protocol rather than bolting a side channel onto it.
   */
  clientCapabilityMeta?: Record<string, unknown>;
  /** Extra environment variables layered onto the spawned process. */
  env?: Record<string, string>;
  /**
   * Environment that has to be computed from callboard's four permission axes,
   * evaluated once per spawn and layered over {@link env}.
   *
   * Separate from `env` because it is not constant: a vendor whose own config
   * decides which tool calls reach the wire cannot be configured until the
   * policy those calls will be judged against is known. Still a per-vendor
   * delta, and still nothing the agent could tell us — it is the shape of the
   * vendor's *config file*, which is exactly what this file is for.
   *
   * Called with the policy in force at spawn time, or null when there is none
   * (which every implementation must read as "ask about everything").
   */
  permissionEnv?: (permissions: DefaultPermissions | null) => Record<string, string>;
  /**
   * The environment variable this CLI reads an OpenRouter API key from, when it
   * supports OpenRouter at all.
   *
   * Declaring it is what *opts a vendor in* to receiving the user's key: an
   * agent with no entry here is never handed one, however the setting is
   * configured. That matters because an ACP vendor is an arbitrary third-party
   * binary — the same reasoning that keeps `options.env` from being forwarded
   * wholesale (see AcpAdapter) — so the credential goes only where a human has
   * recorded that it belongs.
   *
   * Qualifies for a preset because the agent cannot tell us: nothing in ACP
   * describes how a CLI takes third-party credentials. Verified for OpenCode by
   * opening a session with and without the variable set — the model list it
   * advertises grows from 39 entries to 376.
   */
  openRouterApiKeyEnv?: string;
}

/** Default ceiling on the post-`session/new` wait for `available_commands_update`. */
export const DEFAULT_INITIAL_COMMANDS_WAIT_MS = 2000;

/**
 * Default ceiling on the `initialize` handshake.
 *
 * Generous, because a cold vendor CLI can legitimately take seconds to boot, and
 * a false timeout looks like an outage. Its job is not to be tight but to be
 * *finite*: an agent that spawns and then never answers would otherwise wedge
 * the turn forever, with `close()` reporting success while the child lives on.
 */
export const DEFAULT_INITIALIZE_TIMEOUT_MS = 30_000;

/**
 * The channel callboard injects OpenCode's permission config through.
 *
 * **Why this exists at all.** ACP is explicit that requesting permission is the
 * agent's prerogative — nothing on the client side compels it — and OpenCode
 * defaults [most permissions to `allow`](https://opencode.ai/docs/permissions/).
 * Measured, not assumed: an unconfigured `opencode acp` overwrote a file with no
 * `session/request_permission` at all. Left alone, callboard would render a
 * four-axis permission UI that governed nothing, which is worse than not
 * offering the vendor. Moving the decision onto the wire is what makes the gate
 * real — callboard's own policy answers there, auto-allowing what the user's
 * axes already allow and prompting only where they say `ask`.
 *
 * {@link openCodePermissionConfig} builds the value that goes in this variable,
 * which depends on the axes — read it for why a blanket `ask` is not always the
 * right answer.
 *
 * **Why the highest-precedence channel.** OpenCode reads config from several
 * sources; two can carry ours. Both were tried against a project whose own
 * `opencode.json` said `permission: {edit: "deny"}`:
 *
 * | Channel | Precedence | User's `edit: deny` | Result |
 * | --- | --- | --- | --- |
 * | `OPENCODE_CONFIG` (a file path) | *below* project config | survives | edit denied by OpenCode, `execute` still asked |
 * | `OPENCODE_CONFIG_CONTENT` (inline) | above project config | overridden | both asked, callboard decides |
 *
 * The lower-precedence channel looks more deferential and is the wrong choice:
 * it lets the user's file *loosen* us too. A project with
 * `permission: {"*": "allow"}` would stop OpenCode asking altogether and
 * silently switch callboard's gate off, which is exactly the failure the plan
 * names as disqualifying for a vendor. So callboard takes the authoritative
 * channel: for chats **callboard runs**, callboard's four axes are the policy.
 *
 * The cost, stated plainly: a user's own `deny` is weakened to `ask` inside
 * callboard-launched sessions. It is bounded — `ask` still requires an explicit
 * human approval, `deny` is available on the matching callboard axis, and the
 * env var is set only on the process callboard spawns, so the user's own
 * terminal sessions are untouched.
 */
export const OPENCODE_CONFIG_CONTENT_ENV = "OPENCODE_CONFIG_CONTENT";

/**
 * The OpenCode config for one spawn, given the policy the turn will run under.
 *
 * ## The bug this exists to route around
 *
 * OpenCode's `task` tool runs a subagent in a **child session**, and OpenCode
 * 1.18.13 never forwards a child session's permission requests to its ACP
 * client. Its own log shows the ask (`asking id=… permission=read`); no
 * `session/request_permission` is ever written to the wire. Nothing answers it,
 * so the subagent blocks, the parent turn blocks behind it, and the chat sits
 * on an in-progress `task` card forever with no error and no result.
 *
 * Reproduced against the real binary with a raw JSON-RPC client — no callboard
 * code, no SDK — so it is upstream, and no amount of client-side handling makes
 * a request that was never sent arrive. What callboard *can* do is stop asking
 * OpenCode to ask.
 *
 * ## What this returns, and why each branch is right
 *
 * - **Every axis `allow` → `{"*": "allow"}`.** With all four axes open,
 *   `resolveAcpPermission` auto-allows every tool anyway (`categorizeAcpToolName`
 *   always lands on one of the four categories), so the round trip decides
 *   nothing and only creates the opportunity to deadlock. Removing it is
 *   behaviour-preserving for the gate and subagents work again — verified end to
 *   end against 1.18.13.
 * - **Anything else → `{"*": "ask", "task": "deny"}`.** Here the round trip is
 *   load-bearing: at least one axis is `ask` or `deny`, so callboard must see
 *   the calls. `task` is denied because it is the only route to a child session,
 *   and a child session's calls are exactly the ones that never arrive. The cost
 *   is real — no subagents in a chat with a non-`allow` axis — and it buys the
 *   difference between "OpenCode declined to delegate" (which the model reads
 *   and works around, verified) and a turn that hangs indefinitely.
 *
 * ## The one invariant this bends
 *
 * `permissionAdapter`'s rule 1 wants both permission passes reading the policy
 * at *decision* time. A config baked into the process env is read at *spawn*
 * time instead, so tightening a policy mid-turn no longer binds on the current
 * turn's remaining tool calls. The window is one turn — the adapter spawns a
 * fresh agent per turn — and it is the same window the Codex adapter has always
 * had, which flattens the axes once at thread start. Loosening mid-turn is
 * unaffected in the direction that matters: the `ask` branch still round-trips
 * everything, so it is only the all-`allow` branch that is fixed in advance, and
 * that branch grants nothing the live policy did not already grant when the turn
 * began.
 */
export function openCodePermissionConfig(permissions: DefaultPermissions | null): string {
  const axes: Array<keyof DefaultPermissions> = ["fileRead", "fileWrite", "codeExecution", "webAccess"];
  const allAllowed = !!permissions && axes.every((axis) => permissions[axis] === "allow");
  if (allAllowed) return JSON.stringify({ permission: { "*": "allow" } });
  return JSON.stringify({ permission: { "*": "ask", task: "deny" } });
}

/**
 * Built-in presets.
 *
 * **One entry, and that is the bar rather than an accident.** OpenCode is
 * verified against its real binary (1.18.12): the handshake, capability set,
 * permission flow, tool arguments, model selection, resume and cancellation were
 * all exercised end to end, and several adapter defects were found that way.
 * `AcpAdapter.opencode.live.test.ts` re-runs that proof on demand.
 *
 * A Gemini CLI entry shipped here briefly and was removed, unrun. It was
 * recorded from vendor documentation, which is enough to be *plausible* and not
 * enough to be *offered*: an unverified vendor cannot be shown to request
 * permission reliably, and one that does not is one callboard cannot gate — the
 * criterion the plan sets for onboarding. Listing it also cost something real,
 * since a disabled button in the picker implies callboard knows the CLI would
 * work if installed, and nobody here had ever seen it run.
 *
 * The seam is unchanged by having one entry. A vendor is still data: adding the
 * next one is this object plus a live run, and `resolveAcpVendorPreset`'s
 * `override` already takes a full preset for anyone wiring one by hand.
 */
export const ACP_VENDOR_PRESETS: Readonly<Record<string, AcpVendorPreset>> = Object.freeze({
  opencode: Object.freeze({
    id: "opencode",
    label: "OpenCode",
    command: ["opencode", "acp"] as const,
    // See OPENCODE_CONFIG_CONTENT_ENV for why callboard injects a config at all,
    // and openCodePermissionConfig for why the value depends on the axes.
    // Without this the gate is decorative.
    permissionEnv: (permissions) => ({ [OPENCODE_CONFIG_CONTENT_ENV]: openCodePermissionConfig(permissions) }),
    // OpenCode's own documented channel is `opencode auth login` writing
    // ~/.local/share/opencode/auth.json, which callboard must not touch — it is
    // the user's credential store, shared with their terminal sessions. The
    // environment variable reaches the same provider without writing anything,
    // and is scoped to the process callboard spawns.
    openRouterApiKeyEnv: "OPENROUTER_API_KEY",
  } satisfies AcpVendorPreset),
});

/**
 * Resolve the preset for a provider id.
 *
 * `override` wins outright when supplied — that is the seam Phase 3's
 * user-defined providers plug into (a settings entry is just a preset that did
 * not ship in this file), and it is how tests point the adapter at a local
 * test-double binary without mutating global state.
 *
 * Returns null for an unknown id so callers can produce a clear
 * "no such ACP provider" error rather than spawning something arbitrary.
 */
export function resolveAcpVendorPreset(providerId: string, override?: AcpVendorPreset | null): AcpVendorPreset | null {
  if (override) return override;
  if (!providerId) return null;
  return ACP_VENDOR_PRESETS[providerId] ?? null;
}

/** Ids of the presets that ship in this file. */
export function listAcpVendorIds(): string[] {
  return Object.keys(ACP_VENDOR_PRESETS);
}
