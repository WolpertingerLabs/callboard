/**
 * "Does someone need to run `claude auth login` on this machine?"
 *
 * That is the question `/api/auth/claude-status` is asked, and it is **not**
 * "is the CLI logged in" — which is the question it used to answer.
 *
 * The two came apart every time a user followed the README's API-key path.
 * `getApiEnvOverrides` injects `ANTHROPIC_API_KEY` into every chat, chats work,
 * and `claude auth status` — a CLI that knows nothing about Callboard's
 * settings file — kept answering `{"loggedIn": false}`. Measured on an isolated
 * daemon with `apiKey` set and no CLI login: this endpoint said not logged in
 * while `GET /api/engines` said `configured: true, source: "API key
 * (ANTHROPIC_API_KEY)"` — same daemon, same moment, two answers. So
 * `CodeLoginModal` fired on every page load, forever, for a correctly
 * configured install, and the sidebar kept a warning triangle beside it.
 *
 * ## The order, and why it is that way in both directions
 *
 * 1. **Credentials, from {@link claudeCodeCredentials}** — the same function
 *    the engine status card renders, so the two cannot disagree again. This
 *    answers the API-key, auth-token, OpenRouter-routed and third-party-provider
 *    (Bedrock, Vertex, an enterprise gateway) cases, and answers them without
 *    spawning anything at all.
 * 2. **`claude auth status`, when there is a native CLI** — and this half is
 *    what keeps the modal's own "Check Again" button working. Step 1 reads
 *    `sdk-info`'s cache, which is populated at boot and which a fresh
 *    `claude auth login` does not invalidate; the CLI is a live check, so a
 *    login performed thirty seconds ago is seen.
 * 3. **Neither** — and then both halves of *why* are said, because the remedy
 *    differs. On a machine with no native `claude` there is no
 *    `claude auth login` to run, and a modal that says otherwise is the same
 *    defect as the modal appearing for an API-key user: instructions for a
 *    state the user is not in.
 *
 * `loggedIn` keeps its name — an older browser bundle reads it — but now means
 * "no login is needed here".
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "../utils/logger.js";
import { resolveClaudeBinary } from "./claude-binary.js";
import { claudeCodeCredentials } from "./engine-status.js";
import { getSdkInfoAsync } from "./sdk-info.js";

const log = createLogger("claude-auth-status");
const execFileAsync = promisify(execFile);

/** The response body of `GET /api/auth/claude-status`. Fields are added, never removed. */
export interface ClaudeAuthStatusResult {
  /** False ⇒ no credential of any kind was found. The only state that warrants the modal. */
  loggedIn: boolean;
  email?: string;
  /** Where the credential came from — `"API key (ANTHROPIC_API_KEY)"`, `"claude.ai"`, `"openrouter"`, … */
  authMethod?: string;
  subscriptionType?: string;
  /** Extra context on the source, when there is any. */
  note?: string;
  /** The native `claude` the daemon resolved. Absent ⇒ `claude auth login` is not a command this machine has. */
  cliPath?: string;
  error?: string;
  /** Anything else the CLI reported (`apiProvider`, `orgId`, `orgName`, …), passed through unchanged. */
  [key: string]: unknown;
}

/** How long a *positive* answer is reused. Negatives are never cached, so a fresh login is seen at once. */
export const CLAUDE_STATUS_TTL_MS = 60_000;

let cache: { data: ClaudeAuthStatusResult; ts: number } | null = null;

/** Test seam, and what a settings save would call if it ever needed to. */
export function resetClaudeAuthStatusCache(): void {
  cache = null;
}

export async function getClaudeAuthStatus(): Promise<ClaudeAuthStatusResult> {
  if (cache && Date.now() - cache.ts < CLAUDE_STATUS_TTL_MS) return cache.data;

  // The one resolver — the same call a chat spawns through.
  const cliPath = (await resolveClaudeBinary()).path;

  let credentials: Awaited<ReturnType<typeof claudeCodeCredentials>> | undefined;
  try {
    credentials = await claudeCodeCredentials();
  } catch (err) {
    // "Could not tell", which falls through to the CLI rather than being
    // reported as "not logged in".
    log.debug(`credential lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (credentials?.configured === true) {
    const account = (await getSdkInfoAsync().catch(() => null))?.account ?? undefined;
    const data: ClaudeAuthStatusResult = {
      loggedIn: true,
      ...(credentials.source ? { authMethod: credentials.source } : {}),
      ...(account?.email ? { email: account.email } : {}),
      ...(account?.subscriptionType ? { subscriptionType: account.subscriptionType } : {}),
      ...(credentials.note ? { note: credentials.note } : {}),
      ...(cliPath ? { cliPath } : {}),
    };
    cache = { data, ts: Date.now() };
    return data;
  }

  if (cliPath) {
    try {
      // `execFile`, not `execSync`: this runs on the request path of an endpoint
      // the frontend hits on every load, and a synchronous spawn on a
      // single-threaded server stalls every open SSE stream too. `killSignal`
      // makes the timeout a bound — Node's default SIGTERM is sent at the
      // deadline and then waited on indefinitely.
      const { stdout } = await execFileAsync(cliPath, ["auth", "status"], {
        timeout: 5_000,
        killSignal: "SIGKILL",
        encoding: "utf-8",
        maxBuffer: 1024 * 1024,
      });
      const parsed = JSON.parse(stdout.trim());
      const data: ClaudeAuthStatusResult = { ...parsed, cliPath };
      if (parsed.loggedIn) cache = { data, ts: Date.now() };
      return data;
    } catch (err: any) {
      return { loggedIn: false, cliPath, error: err?.code === "ENOENT" ? "Claude CLI not installed" : `CLI error: ${err?.message ?? String(err)}` };
    }
  }

  return {
    loggedIn: false,
    error:
      credentials?.configured === "unknown"
        ? "Callboard could not read account info from the Agent SDK, and there is no native `claude` CLI here to ask instead."
        : "No Claude credentials: no API key or auth token in Settings → API, nothing in the daemon's environment, and no native `claude` CLI to log in with.",
  };
}
