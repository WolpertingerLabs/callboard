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
   * Extra vendor-specific keys merged into `clientCapabilities._meta` on
   * `initialize`. `_meta` is ACP's sanctioned extension point, so this stays
   * inside the protocol rather than bolting a side channel onto it.
   */
  clientCapabilityMeta?: Record<string, unknown>;
  /** Extra environment variables layered onto the spawned process. */
  env?: Record<string, string>;
}

/** Default ceiling on the post-`session/new` wait for `available_commands_update`. */
export const DEFAULT_INITIAL_COMMANDS_WAIT_MS = 2000;

/**
 * Built-in presets.
 *
 * Deliberately minimal. Phase 1 ships against a conformant test double because
 * no ACP-speaking CLI is installed or authenticated on the build machine, so
 * every entry here is unverified against a live binary — the commands are
 * recorded from vendor documentation, not from a run. Phase 2 is where each one
 * gets exercised and where the remaining vendors land.
 *
 * Gemini CLI is the single entry because its ACP flag (`--experimental-acp`) is
 * the one this adapter's author could cite without guessing. Adding a vendor
 * whose invocation we would have had to invent is worse than shipping none:
 * a wrong `command` fails at spawn time with a confusing error and looks like
 * an adapter bug.
 */
export const ACP_VENDOR_PRESETS: Readonly<Record<string, AcpVendorPreset>> = Object.freeze({
  gemini: Object.freeze({
    id: "gemini",
    label: "Gemini CLI",
    command: ["gemini", "--experimental-acp"] as const,
    // Gemini publishes its command list after session creation.
    waitForInitialCommands: true,
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
