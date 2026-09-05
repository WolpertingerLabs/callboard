/**
 * The `/api/system-info` payload — versions, credentials, and which engines this
 * machine can actually run.
 *
 * Assembled here rather than inline in the route for one reason: the route is
 * registered directly on `app` in `index.ts`, and `index.ts` starts a listener,
 * a scheduler, a job runner and three watchers at import time. A handler that
 * cannot be imported cannot be tested, and the property this module most needs
 * a test for is precisely a *failure* path — see the probe block below.
 *
 * ## Nothing here throws
 *
 * Every field degrades to a stated fallback. The caller is a **polled** endpoint
 * that several pages read on mount, and Express 4 does not catch an async
 * handler's rejection: a throw does not become a 500, it becomes a request that
 * never answers at all. So "could not tell" is spelled as a value — `"unknown"`,
 * `"not installed"`, an empty vendor list — and never as a rejection.
 *
 * ## The response shape is a published interface
 *
 * Browser tabs run bundles older than the daemon they talk to, and this payload
 * is read by the New Chat picker, the model selectors, Settings → API and
 * Settings → About. The same rule `shared/types/stream.ts` states applies:
 * fields are added, never removed or renamed, and an existing field's meaning
 * never changes. The returned object is deliberately left un-annotated so its
 * type is inferred from the literal — a hand-written interface alongside it is
 * one more thing that can drift from what is actually sent.
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { DATA_DIR } from "../utils/paths.js";
import { binaryVersionLine } from "../utils/binary-version.js";
import { resolveClaudeBinary } from "./claude-binary.js";
import { getSdkInfoAsync } from "./sdk-info.js";
import { listAcpProviderAvailability } from "../agents/adapters/acp/availability.js";
import { DEFAULT_CLINE_PROVIDER_ID } from "../agents/adapters/cline/optionsAdapter.js";
import { getCodexAuthSource, detectCodexOpenRouterEnv, isCodexRoutedThroughOpenRouter, type CodexAuthSource } from "../agents/adapters/codex/codexAuth.js";
import { getAgentSettings, detectClaudeCodeOpenRouterEnv, isClaudeCodeRoutedThroughOpenRouter } from "./agent-settings.js";

export interface BuildSystemInfoOptions {
  /**
   * Callboard's own package root, for reading its `package.json` and the SDK's.
   *
   * Passed in rather than derived here. `index.ts` computes it from its own
   * `import.meta.url` with a fixed `../..`, which is correct for
   * `backend/dist/index.js` and wrong by one level for anything under
   * `backend/dist/services/` — a module that moved would silently start
   * reporting `installedVersion: undefined`.
   */
  pkgRoot: string;
  /**
   * The version of the code this process is **executing**, captured at boot.
   *
   * Passed in for the same reason `pkgRoot` is — this module cannot honestly
   * derive it, and here the reason is timing rather than depth: the value has to
   * be read before anything could have rewritten it, and this function first
   * runs on a request. `index.ts` supplies `BOOT_VERSION` from
   * `utils/package-manifest.ts`.
   *
   * Required, not defaulted. A default would be a silent path back to reading
   * the manifest per request, which is the bug this parameter exists to close.
   */
  runningVersion: string | null;
}

/**
 * ## `version` is what is running, not what is on disk
 *
 * These used to be the same read and are not the same fact. `npm install -g`
 * replaces Callboard's package tree **in place**, so from the moment npm exits,
 * `<pkgRoot>/package.json` describes code that is not executing and will not be
 * until the daemon restarts. This endpoint reported that read as `version`, and
 * three things went wrong at once: the About page's "Version" row named a
 * version nothing was running; `isNewerVersion(version, latestVersion)` went
 * false, which is the condition the whole update banner is rendered behind, so
 * the banner deleted itself — verdicts, retry button and reattach path with it —
 * in precisely the window it was written for; and the update poll, which watches
 * this field to decide the daemon has come back, could be satisfied by the *old*
 * daemon answering before the SIGTERM landed.
 *
 * So `version` keeps its documented meaning ("the version this daemon is") and
 * gets an implementation that matches it, and the genuinely new datum — what npm
 * has put on disk — arrives as its own optional field. That is the direction the
 * compatibility rule points: an old bundle reading `version` now gets a more
 * correct answer to the question it was already asking, and nothing has to
 * understand a redefinition.
 */
export async function buildSystemInfo({ pkgRoot, runningVersion }: BuildSystemInfoOptions) {
  let installedVersion: string | undefined;
  let pkgName = "@wolpertingerlabs/callboard";
  try {
    const pkgPath = path.join(pkgRoot, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    if (typeof pkg.version === "string" && pkg.version) installedVersion = pkg.version;
    pkgName = pkg.name || pkgName;
  } catch {
    // ignore
  }

  // What is running, falling back to what is on disk only when the boot read
  // failed — in which case they are the same guess and this is the more useful
  // of the two ways to be wrong.
  const version = runningVersion ?? installedVersion ?? "unknown";
  const restartPending = installedVersion !== undefined && runningVersion !== null && installedVersion !== runningVersion;

  let sdkVersion = "unknown";
  try {
    const sdkPkgPath = path.join(pkgRoot, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json");
    const sdkPkg = JSON.parse(readFileSync(sdkPkgPath, "utf-8"));
    sdkVersion = sdkPkg.version;
  } catch {
    // ignore
  }

  // ── The four independent probes, started together ────────────────
  //
  // These used to be four sequential `await`s, so the response shipped at the
  // *sum* of their latencies. Nothing below reads anything the probe above it
  // produced, and the cost was not evenly spread: measured against a warm
  // daemon, the whole endpoint was ~120ms and `claude --version` alone was
  // ~108ms of it. The ACP vendor list is cheap — its PATH lookups are cached
  // for the process lifetime — but it was computed last, so the New Chat
  // picker's OpenCode button (the only provider button that comes from this
  // payload rather than from hardcoded JSX) could not paint until a `claude`
  // spawn it has nothing to do with had finished. Started together, the
  // response costs the slowest probe instead of all of them.
  //
  // Each probe carries its own guard rather than relying on a wrapper, because
  // `Promise.all` rejects on the *first* rejection: a shared handler would
  // discard three good answers to report one failure, and — since Express 4
  // does not catch an async handler's rejection — would hang the request rather
  // than failing it.

  // Same resolver as chats and the login check. `"not installed"` rather than
  // `"unknown"` when nothing resolved: this used to run the bare name
  // `"claude"` through a shell and report `unknown` on the resulting
  // not-found, which reads as "Callboard could not tell" when in fact it
  // looked and there was nothing there.
  //
  // The `.catch` is not defensive padding. `resolveClaudeBinary()` has no
  // try/catch of its own, and its first act is to read settings —
  // `getClaudeCodeExecutableOverride()` → `getAgentSettings()` →
  // `readAgentSettings()` (`services/agent-settings.ts`), whose first line is an
  // `ensureDataDir()` sitting *above* its try/catch rather than inside it. An
  // `mkdirSync` EACCES (a read-only `$HOME`, or `~/.callboard`
  // removed under a parent nobody can write) therefore throws straight out of
  // the resolver, and before this guard that took the whole payload with it —
  // including the ACP vendor list the New Chat picker needs, which had already
  // succeeded. `engine-status.ts` puts the identical `.catch` on the identical
  // call for the identical reason.
  //
  // The fallback is the empty resolution, so an unreadable-settings daemon
  // reports exactly what a daemon with no `claude` installed reports: no
  // binary, `"not installed"`. That is the honest answer — Callboard cannot
  // run a chat in that state either.
  //
  // The spawn itself lives in `utils/binary-version.ts`, which memoizes it per
  // resolved path and revalidates in the background once the answer is stale.
  // It is the same argument `adapters/acp/availability.ts` makes for its own
  // probes: this is a *polled* endpoint, so an `execFile` per poll bought
  // nothing. Keyed on the resolved path rather than the name `claude`, so a
  // user who repoints the binary-override setting is not answered from the old
  // binary's entry — and dropped outright by `POST /api/engines/refresh`
  // (through `resetEngineProbeCaches`), so Recheck is immediate where the TTL
  // is merely eventual.
  //
  // `binaryVersionLine`, not `binaryVersion`: this field is *displayed*, and
  // `"2.0.1 (Claude Code)"` is what the About page has always rendered. The
  // dotted-token accessor is for the callers that compare versions.
  const claudeCliProbe = (async (): Promise<{ binary: string | undefined; version: string }> => {
    const binary = (await resolveClaudeBinary().catch(() => ({ path: undefined }))).path;
    if (!binary) return { binary, version: "not installed" };
    return { binary, version: (await binaryVersionLine(binary)) ?? "unknown" };
  })();

  // Fetch latest version from npm (cached, best effort)
  const latestVersionProbe = (async (): Promise<string | undefined> => {
    let latest: string | undefined;
    try {
      const cacheFile = path.join(DATA_DIR, "version-check.json");
      const cacheTtl = 4 * 60 * 60 * 1000; // 4 hours
      let cached: { latestVersion: string; ts: number } | null = null;
      try {
        if (existsSync(cacheFile)) {
          cached = JSON.parse(readFileSync(cacheFile, "utf-8"));
        }
      } catch {
        // ignore corrupt cache
      }
      if (cached && Date.now() - cached.ts < cacheTtl) {
        latest = cached.latestVersion;
      } else {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const npmRes = await fetch(`https://registry.npmjs.org/${pkgName}/latest`, {
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        clearTimeout(timeout);
        if (npmRes.ok) {
          const npmData = (await npmRes.json()) as { version?: string };
          if (npmData.version) {
            latest = npmData.version;
            try {
              writeFileSync(cacheFile, JSON.stringify({ latestVersion: latest, ts: Date.now() }) + "\n");
            } catch {
              // best effort
            }
          }
        }
      }
    } catch {
      // best effort — don't fail the endpoint
    }
    return latest;
  })();

  // Include cached SDK info (account + models) if available. `fetchSdkInfo`
  // catches its own failures and resolves with an empty cache, so the `.catch`
  // here is for the one thing it cannot cover — a throw on the way *in*, before
  // that try block is entered — rather than a claim that the fetch is fragile.
  const sdkInfoProbe = getSdkInfoAsync().catch(() => ({ account: null, models: [], fetchedAt: 0 }));

  // ACP vendors are one kind covering many CLIs, so there is no single
  // "acpConfigured" flag — the picker needs the per-vendor list. Cached after
  // the first PATH lookup, so this is cheap on every subsequent poll.
  //
  // A failed PATH probe must not take the whole system-info payload down; an
  // empty list reads as "no ACP vendors", which is the safe answer.
  const acpProvidersProbe: Promise<Awaited<ReturnType<typeof listAcpProviderAvailability>>> = listAcpProviderAvailability().catch(() => []);

  const [claudeCli, latestVersion, sdkInfo, acpProviders] = await Promise.all([claudeCliProbe, latestVersionProbe, sdkInfoProbe, acpProvidersProbe]);
  const { binary: claudeCliBinary, version: claudeCliVersion } = claudeCli;

  // Whether each native harness is EFFECTIVELY routed through OpenRouter —
  // toggle on and credentials available, from settings or from the ambient
  // env. The model selectors and New Chat panel read these to switch their
  // catalog/ordering to OpenRouter, so they must agree with what the session
  // actually does; the predicates are the same ones getApiEnvOverrides and the
  // Codex options adapter resolve from. Keys themselves are never exposed.
  let claudeCodeUseOpenRouter = false;
  let codexUseOpenRouter = false;
  // Which Cline provider new chats run on. The model picker needs it to know
  // WHICH catalog to offer: Cline's model list is per-provider, so a user who
  // set the provider to `openrouter` should be offered OpenRouter's ~270
  // models and one on `anthropic` should not. Blank means the adapter's own
  // default (`anthropic`) — see cline/optionsAdapter.
  let clineProviderId = DEFAULT_CLINE_PROVIDER_ID;
  try {
    const s = getAgentSettings();
    clineProviderId = s.clineProviderId?.trim() || DEFAULT_CLINE_PROVIDER_ID;
    claudeCodeUseOpenRouter = isClaudeCodeRoutedThroughOpenRouter(s);
    codexUseOpenRouter = isCodexRoutedThroughOpenRouter(s);
  } catch {
    // Settings unreadable — treat every routing mode as off.
  }

  // Whether the Codex provider has usable credentials (api key set, a
  // parseable $CODEX_HOME/auth.json from `codex login`, or a config.toml
  // declaring a model_provider). Lets the UI enable the Codex toggle without
  // exposing the credentials themselves. `codexAuthSource` surfaces which
  // path matched so the settings page can label it accurately.
  let codexConfigured = false;
  let codexAuthSource: CodexAuthSource = null;
  try {
    codexAuthSource = getCodexAuthSource();
    codexConfigured = codexAuthSource !== null;
  } catch {
    // Treat any failure as unconfigured.
  }
  // OpenRouter routing is its own credential path: the native Codex harness
  // authenticates via the OpenRouter key, so it's usable even without a
  // ChatGPT login / OpenAI key / config.toml provider. `codexConfigured` is what
  // the New Chat provider gate reads, so it says yes.
  //
  // `codexAuthSource` is deliberately NOT forced along with it. It answers a
  // different question — which *native* credential backs Codex — and forcing it
  // to `config.toml` had Settings → API tell a routed user with no auth.json and
  // no config.toml "Configured via config.toml", directly under a picker
  // offering to switch them back to the login they do not have. The note carries
  // the qualification instead, the way `codexCredentials` in engine-status.ts
  // already does for the same forced flag.
  //
  // The note is `OPENROUTER_ROUTED_NOTE` there, verbatim. It names both
  // credentials because routing has two doors:
  // `isCodexRoutedThroughOpenRouter` also returns true on an endpoint override
  // plus a detected env, and in *that* state `getApiEnvOverrides` sets no
  // OPENROUTER_API_KEY at all — the injected provider block's `env_key` reads
  // the ambient one. Naming only the stored key claimed a credential this user
  // does not have, on a tab whose whole job is to stop the page over-claiming.
  let codexAuthNote: string | undefined;
  if (codexUseOpenRouter) {
    codexConfigured = true;
    codexAuthNote = "Routed through OpenRouter — authenticated with the OpenRouter key on this tab, or with the OpenRouter credentials already in your environment when none is stored here.";
  }

  // Detect whether the ambient environment already routes each harness through
  // OpenRouter (ANTHROPIC_BASE_URL / OPENAI base / config.toml pointing at
  // openrouter.ai). Settings → API mentions this next to the OpenRouter key
  // fields; it does not seed the credential control from it, because a detected
  // env with no stored flag is a routing that is not happening.
  let claudeCodeOpenRouterDetected = false;
  let codexOpenRouterDetected = false;
  try {
    claudeCodeOpenRouterDetected = detectClaudeCodeOpenRouterEnv();
    codexOpenRouterDetected = detectCodexOpenRouterEnv();
  } catch {
    // best effort — detection failures just leave the toggles defaulting off
  }

  return {
    version,
    // Additive, and optional in the wire sense: a bundle that does not know
    // these keys ignores them, and one that does can say "new code is on disk,
    // this process has not restarted into it" — which is otherwise invisible,
    // most sharply to a *second* daemon sharing one global install that its
    // sibling upgraded without ever telling it. See `services/self-update.ts`.
    ...(installedVersion ? { installedVersion } : {}),
    ...(restartPending ? { restartPending: true } : {}),
    latestVersion,
    nodeVersion: process.version,
    platform: `${process.platform} (${process.arch})`,
    sdkVersion,
    claudeCliVersion,
    claudeCliBinary,
    proxyMode: process.env.MCP_PROXY_MODE || undefined,
    environment: process.env.NODE_ENV || "development",
    account: sdkInfo.account || undefined,
    models: sdkInfo.models.length > 0 ? sdkInfo.models : undefined,
    claudeCodeUseOpenRouter,
    codexUseOpenRouter,
    claudeCodeOpenRouterDetected,
    codexOpenRouterDetected,
    codexConfigured,
    codexAuthSource,
    codexAuthNote,
    // Which ACP vendors have their CLI installed. One entry per built-in
    // preset, present even when unavailable so the picker can say what to
    // install. Availability here means "the binary resolves", never
    // "authenticated" — see adapters/acp/availability.ts.
    acpProviders,
    // The Cline provider new chats use. There is deliberately no
    // `clineConfigured` flag to match `codexConfigured`: Cline is an embedded
    // SDK that falls back to the backend's own environment credentials, so
    // there is no state in which the picker could honestly be disabled.
    clineProviderId,
  };
}
