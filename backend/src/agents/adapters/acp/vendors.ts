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
 * The OpenCode config callboard injects into the agent it spawns.
 *
 * **Why this exists at all.** ACP is explicit that requesting permission is the
 * agent's prerogative — nothing on the client side compels it — and OpenCode
 * defaults [most permissions to `allow`](https://opencode.ai/docs/permissions/).
 * Measured, not assumed: an unconfigured `opencode acp` overwrote a file with no
 * `session/request_permission` at all. Left alone, callboard would render a
 * four-axis permission UI that governed nothing, which is worse than not
 * offering the vendor. Setting every tool to `ask` moves the decision onto the
 * wire, where callboard's own policy answers it — auto-allowing what the user's
 * axes already allow, prompting only where they say `ask`.
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
export const OPENCODE_FORCE_ASK_CONFIG = JSON.stringify({ permission: { "*": "ask" } });

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
    // See OPENCODE_FORCE_ASK_CONFIG. Without this the gate is decorative.
    env: { OPENCODE_CONFIG_CONTENT: OPENCODE_FORCE_ASK_CONFIG },
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
