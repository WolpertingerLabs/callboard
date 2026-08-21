/**
 * Is a configured ACP vendor actually runnable on this machine?
 *
 * The UI needs an answer before it offers a provider, for the same reason
 * `codexConfigured` exists: an enabled button that spawns ENOENT is worse than a
 * disabled one that says why. `provider-availability` is the behaviour this
 * mirrors — degrade to a clear "not installed" state, never a crash.
 *
 * ## What this can and cannot tell you
 *
 * It answers **"is the binary there"** and nothing else. It deliberately does
 * NOT try to answer "is the user authenticated", even though that is the
 * question a user actually cares about, because:
 *
 * - ACP has no authentication introspection. `initialize` returns `authMethods`
 *   — what the agent *offers* — and never who is signed in. Reporting the offer
 *   as a login state would be a fabrication (`AcpAgentQuery.accountInfo` refuses
 *   the same thing for the same reason).
 * - Finding out for real means spawning the CLI and completing a handshake. That
 *   is seconds of process startup per vendor on an endpoint the settings page
 *   polls, and it would spawn third-party binaries as a side effect of loading a
 *   page.
 *
 * So an unauthenticated vendor reports as available and fails at send time with
 * the CLI's own error, which is the message the user needs anyway. Credentials
 * belong to the vendor CLI — that is ACP's model, and callboard does not manage
 * them.
 *
 * Results are cached for the process lifetime: PATH does not change under a
 * running daemon, and the alternative is an `execFile` per settings poll.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "../../../utils/logger.js";
import { ACP_VENDOR_PRESETS, type AcpVendorPreset } from "./vendors.js";

const log = createLogger("acp-availability");

const execFileAsync = promisify(execFile);

/** One vendor, as the UI needs to render it. */
export interface AcpProviderAvailability {
  id: string;
  label: string;
  /** The binary resolves on PATH. Says nothing about credentials — see the module doc. */
  available: boolean;
  /** The binary the check looked for, so a "not installed" message can name it. */
  command: string;
}

/** Resolved absolute path per command, or `null` for "looked, not there". */
const cache = new Map<string, string | null>();

/**
 * Where does `command` resolve to on PATH, if anywhere?
 *
 * `execFileSync` rather than `execSync` so the binary name is an argument and
 * never reaches a shell — preset commands are data, and Phase 3 will let users
 * supply them.
 *
 * The cache holds the resolved *path* rather than a boolean so the engine status
 * card can name the binary it found; `available` is derived from it, which is
 * exactly the answer the boolean cache gave before.
 */
export function resolveAcpBinaryPath(command: string): string | null {
  const cached = cache.get(command);
  if (cached !== undefined) return cached;

  let resolved: string | null = null;
  try {
    const which = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(which, [command], { timeout: 3_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    // `where` can list several matches; the first line is the one that wins.
    resolved = out.split("\n")[0].trim() || null;
  } catch {
    // Non-zero exit is the normal "not found" answer, not an error worth raising.
    resolved = null;
  }
  cache.set(command, resolved);
  log.debug(`ACP binary "${command}" ${resolved ? `found at ${resolved}` : "not found"} on PATH`);
  return resolved;
}

/** Availability of one preset. */
export function acpProviderAvailability(preset: AcpVendorPreset): AcpProviderAvailability {
  const command = preset.command[0];
  return { id: preset.id, label: preset.label, available: resolveAcpBinaryPath(command) !== null, command };
}

/** Version probes per command, or `null` when the CLI would not say. */
const versionCache = new Map<string, string | null>();

/**
 * What does `<command> --version` report?
 *
 * Deliberately **not** a field on {@link AcpProviderAvailability}: that type is
 * serialized into `/api/system-info`'s `acpProviders`, which several pages poll
 * and which this feature is under orders not to grow. Availability is a `which`
 * lookup; this actually *executes the vendor's binary*, so it stays opt-in and
 * is called only from the engine-status route.
 *
 * ## Why this one is async when its neighbours are not
 *
 * `execFileSync`'s `timeout` does not bound wall-clock. Node sends `killSignal`
 * (SIGTERM by default) at the deadline and then keeps waiting; a child that
 * ignores it runs as long as it likes — measured at 30s against a 5s timeout.
 * On a single-threaded server a sync call that stalls stalls *everything*: every
 * open SSE stream and in-flight chat, not just the request that made it.
 *
 * `which` and `claude --version` inherit that risk from `main` and are left
 * alone. This is the new call, and it is the worst-shaped one — an arbitrary
 * third-party binary that the user installed and callboard has never seen. So
 * it runs off the event loop, and `killSignal: "SIGKILL"` means the deadline is
 * actually enforceable rather than merely requested.
 *
 * Cached for the process lifetime for the same reason availability is — a
 * settings poll must not fork a third-party CLI every time. Concurrent callers
 * share one in-flight probe rather than racing two spawns.
 *
 * Resolves `undefined` when the binary is absent or refuses the flag. Vendors
 * print anything from a bare semver to a banner, so only the first line is kept
 * and no attempt is made to parse it further.
 */
const versionProbes = new Map<string, Promise<string | undefined>>();

export async function acpProviderVersion(command: string): Promise<string | undefined> {
  const cached = versionCache.get(command);
  if (cached !== undefined) return cached ?? undefined;

  const inFlight = versionProbes.get(command);
  if (inFlight) return inFlight;

  const probe = (async (): Promise<string | undefined> => {
    let version: string | null = null;
    if (resolveAcpBinaryPath(command) !== null) {
      try {
        const { stdout } = await execFileAsync(command, ["--version"], {
          timeout: 5_000,
          killSignal: "SIGKILL",
          encoding: "utf-8",
          maxBuffer: 1024 * 1024,
        });
        version = stdout.split("\n")[0].trim() || null;
      } catch {
        // A CLI that does not implement --version is not an error state; it just
        // has no version to report. Same for one we had to kill.
        version = null;
      }
    }
    versionCache.set(command, version);
    versionProbes.delete(command);
    return version ?? undefined;
  })();

  versionProbes.set(command, probe);
  return probe;
}

/**
 * Every built-in vendor, with availability, sorted so installed ones come first.
 *
 * Unavailable vendors are still listed rather than filtered out: the picker
 * shows them disabled with the binary name, which is how a user learns that
 * installing `opencode` is all that stands between them and the provider.
 */
export function listAcpProviderAvailability(): AcpProviderAvailability[] {
  return Object.values(ACP_VENDOR_PRESETS)
    .map(acpProviderAvailability)
    .sort((a, b) => Number(b.available) - Number(a.available) || a.label.localeCompare(b.label));
}

/**
 * Forget cached PATH lookups and version probes.
 *
 * Began as a test seam and is now also production: `POST /api/engines/refresh`
 * calls it (through `services/engine-status.ts`'s `resetEngineProbeCaches`) so a
 * user who installs a vendor CLI can be told it is there without restarting the
 * daemon. Clearing `versionProbes` matters as much as the other two — an
 * in-flight probe left behind would resolve with the pre-install answer.
 */
export function resetAcpAvailabilityCache(): void {
  cache.clear();
  versionCache.clear();
  versionProbes.clear();
}
