/**
 * "Download the latest Callboard and restart" — the daemon upgrading itself.
 *
 * Settings → About has known about newer releases for a long time and offered a
 * command to paste into a terminal. This runs that command here instead, streams
 * npm's output, and then hands the machine to a detached helper that stops this
 * process and starts the new one. Everything below exists because each of those
 * three steps has a way of being *almost* right.
 *
 * ## Why this is not an engine install with a different id
 *
 * It shares a preflight and a child process with `engine-install.ts` — both live
 * in `npm-global-install.ts` — and nothing else. Routing Callboard through
 * `POST /api/engines/:id/install` would have meant adding it to
 * `INSTALLABLE_PACKAGES`, and then two things would be wrong rather than one:
 * `oneClickRecipeFor` selects from a registry of *engines*, and `finishSucceeded`
 * verifies an install by re-probing an **engine binary** and reporting whether a
 * chat could now run on it. Callboard is not an engine, and that verdict is not
 * merely unhelpful for it — it is a claim about the wrong thing.
 *
 * ## The gate that matters: is this daemon the copy npm would replace?
 *
 * `npm install -g @wolpertingerlabs/callboard` upgrades whatever is under
 * `npm root -g`. That is only *this* Callboard when this Callboard was installed
 * globally. Run from a git checkout — `npm run dev`, or `node
 * backend/dist/index.js` in a clone, which is how every contributor runs it —
 * the install would succeed, upgrade a different copy somewhere else, restart
 * this one from the same unchanged source, and present as "the update did
 * nothing". So {@link getSelfUpdateCapability} resolves `npm root -g`, joins the
 * package name onto it, and requires that directory to be the one this module
 * was loaded from, symlinks resolved. Failing that there is no button, and the
 * copy-and-paste command carries a sentence saying which directory Callboard is
 * actually running from.
 *
 * Resolving symlinks is what makes that comparison work on the prefixes people
 * actually have — nvm's `versions/node`, Homebrew, a moved `~/.npm-global` —
 * and it is also the one way the comparison can say yes to a checkout. `npm
 * link` makes `<npm root -g>/<package>` a symlink *into* the working tree, so
 * both sides resolve to the same directory and the gate passes; pressing the
 * button would then have npm delete the link, install a real package over it,
 * and restart from a directory that is not the one `runningFrom` named. So the
 * global entry is `lstat`ed too, and a symlink is refused on its own terms.
 *
 * The second half of the same question is whether there is anything to restart.
 * `callboard start` writes `<DATA_DIR>/callboard.pid`; `callboard start
 * --foreground` and a bare `node backend/dist/index.js` write nothing, and the
 * CLI's `restart` would find no process to stop. The check is stricter than "a
 * pid file exists": it must name **this** process. A stale or foreign pid file
 * would otherwise aim a SIGTERM at something else entirely.
 *
 * That one is a *restart* gate, not a capability gate, and it did not used to
 * be. It refused the button outright with a sentence that said, in as many
 * words, "it can install the new version, but" — and then offered no way to do
 * that, to a population (systemd, pm2, Docker, `--foreground`) which is not
 * small. The feature already has a first-class "installed, did not restart"
 * outcome, and a missing PID file is that situation known in advance, so it is
 * now a **pre-declared restart disposition**: the button appears, carries a note
 * saying the restart will be the user's to run, installs, and lands on
 * `restart: "refused"`. Strictly more useful than a refusal, and one fewer
 * refusal code.
 *
 * ## The value that had to exist first: {@link BOOT_VERSION}
 *
 * `npm install -g` replaces the package tree **in place**, so from the moment
 * npm exits every read of `<pkgRoot>/package.json` describes the code on disk
 * rather than the code executing. Nothing in this system used to mean "the
 * version this process is running", and this module's two central comparisons
 * both needed it:
 *
 * - `changed` — "did the version move?" is a question about *this process*
 *   against disk. Read fresh on both sides it compares the new file with
 *   itself, so a second press of the button (the retry this feature explicitly
 *   tells people to make when the first restart was deferred) concluded there
 *   was "nothing to restart into" while the daemon carried on running the old
 *   code. The only escape was `callboard restart` in a terminal — the thing this
 *   feature exists to remove.
 * - `restartPending` — the same comparison, asked of a daemon that has not
 *   pressed anything. See {@link describeRestartPending}.
 *
 * So both sides now read from `utils/package-manifest.ts`: the running side from
 * the boot snapshot, the disk side from a fresh read of the *global* package
 * root. Different questions, different readers.
 *
 * ## Why the restart is a detached grandchild
 *
 * A process cannot restart itself, and a child of a dying parent is not
 * reliable: the helper's whole job runs *after* this process is gone.
 * `detached: true` puts it in its own process group so the daemon's death does
 * not reach it, `stdio: "ignore"` means it holds no descriptor of ours, and
 * `unref()` lets this event loop exit without waiting. It runs the CLI's
 * `restart`, which is `cmdStop` (SIGTERM the pid file, wait, SIGKILL if it must)
 * followed by `cmdStart` (spawn, then health-check) — exactly the sequence we
 * want, already written and already used by `POST /api/restart`.
 *
 * The helper is resolved from the **newly installed** global path, not from this
 * process's own package root, and that distinction is the point: npm replaces
 * that directory in place during the upgrade. Reading `bin/callboard.js` out of
 * the new package.json is reading the new CLI; reading it out of `__pkgRoot`
 * would be reading a path that may have been unlinked mid-upgrade.
 *
 * ## Why the restart can be refused after a successful install
 *
 * `gracefulShutdown` in `index.ts` kills in-flight agent turns. A restart during
 * a streaming chat or a mid-step job run destroys work the user is watching, so
 * {@link describeWorkInFlight} is consulted immediately before the helper is
 * spawned and the restart is declined — by name — when anything is busy. The
 * install itself is *not* gated on that: npm writing files harms nothing, and
 * refusing before it would mean an update button that does nothing while a chat
 * is open. The new version simply takes effect on the next restart, which the
 * banner says, and pressing the button again once idle is a cheap no-op install
 * followed by the restart that was deferred.
 *
 * "Immediately before" is meant literally, and it did not used to be. The check
 * ran before the {@link RESTART_DELAY_MS} beat that lets the last frames flush,
 * and the helper then pays its own Node boot before `cmdStop` signals — call it
 * a second, during which a job run or a chat can start and be killed mid-turn.
 * It now runs *inside* that timer, with the pending verdict already sent, so a
 * window that opened after the install is still caught and answered with a
 * second `update_verified` carrying `restart: "refused"`.
 *
 * ## No rollback, but a loud way back
 *
 * Callboard does not keep the old tarball and does not attempt to reinstate it:
 * a rollback path that has never been exercised is a second way to break a
 * machine that is already unhappy. What it does instead is record the version it
 * is replacing — in the event stream, in `<DATA_DIR>/self-update.json`, and in
 * the log at `warn` — so that a daemon which never comes back can be repaired
 * with one command the user already has in front of them.
 *
 * @see plans/self-update.md
 * @see plans/engine-availability-and-install.md — the sibling feature and its Decision 8
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SelfUpdateCapability, SelfUpdateEvent, SelfUpdateRefusalCode } from "shared/types/index.js";
import { createLogger } from "../utils/logger.js";
import {
  BOOT_MANIFEST,
  BOOT_PACKAGE_ROOT,
  BOOT_VERSION,
  PACKAGE_NAME_PATTERN,
  readPackageManifest,
  type PackageManifest,
} from "../utils/package-manifest.js";
import { DATA_DIR } from "../utils/paths.js";
import { chatFileService } from "./chat-file-service.js";
import { isInstallRunning } from "./engine-install.js";
import { listRuns } from "./job-store.js";
import { isNewerVersion } from "./npm-registry.js";
import {
  clearNpmInstallInFlight,
  getInstallCapability,
  npmInstallInFlight,
  npmSpawnRefusal,
  resetNpmRootCache,
  resolveNpmGlobalRoot,
  RunLog,
  RUN_RETENTION_MS,
  spawnNpmInstall,
} from "./npm-global-install.js";
import { sessionRegistry } from "./session-registry.js";

const log = createLogger("self-update");

/**
 * This daemon's package root, and the manifest it had at boot.
 *
 * Both come from `utils/package-manifest.ts` rather than being derived here, so
 * that "the directory npm would overwrite" and "the version this process is
 * running" are one fact read in one place. The root is still derived from a
 * module's own location rather than passed in — it is *the* fact the
 * install-source gate turns on, so a caller-supplied value would be checking
 * something other than where this code came from.
 */
const __pkgRoot = BOOT_PACKAGE_ROOT;

/** How long a finished update stays fetchable, so a stream that reconnects still gets the transcript. */
const RETENTION_MS = RUN_RETENTION_MS;

/** The record left behind for a daemon that does not come back. */
const STATE_FILE = path.join(DATA_DIR, "self-update.json");

/** How long the pending verdict gets to reach the browser before the restart is committed to. */
const RESTART_DELAY_MS = 500;

/** How many chats or job runs the "still busy" sentence names before it gives up and says "…". */
const NAMED_IN_SUMMARY = 3;

/**
 * How long after one update finishes before another may start.
 *
 * The one-at-a-time lock says nothing about *rate*, and the global rate limiter
 * is 300/minute — so an authenticated LAN client could sit in a loop driving
 * back-to-back `npm install -g` runs against this machine's global tree, each
 * one a real network fetch and a real rewrite of the package directory this
 * daemon is running out of. The engine installer refuses the same shape with
 * `cooling-down`; this is that refusal, sized for a different reason.
 *
 * Ten seconds, measured from the previous run's completion. It has to be short
 * enough not to be felt by the retry this feature actually expects — "the
 * restart was deferred because a chat was streaming, press it again now that
 * things are idle" — and long enough that a loop is not a loop. A user who does
 * hit it is told how many seconds are left.
 */
const COOLDOWN_MS = 10_000;

/**
 * The sentence every "installed, but not restarted" verdict ends with.
 *
 * `index.ts` serves the frontend with `express.static(<pkgRoot>/frontend/dist)`,
 * which resolves the file per request — and npm replaced that directory in
 * place. So from the moment npm exits 0 this daemon is serving the **new**
 * bundle out of the **old** backend, and it will keep doing so for as long as
 * the deferred restart is deferred. A user who takes the "carry on working"
 * advice literally and reloads a tab gets a new client talking to an old
 * server: the reverse of the direction `shared/types/stream.ts`'s compatibility
 * rules are written for, and not a case they cover.
 *
 * Snapshotting `frontend/dist` into memory at boot would fix it properly and is
 * out of scope for this change; the honest interim is to say so, and to say
 * which action makes the pair consistent again. Recorded as a known limitation
 * in `plans/self-update.md`, along with the two other things this daemon reads
 * from its own package root at runtime.
 *
 * The second sentence is about a case this daemon cannot see and must therefore
 * name rather than check. Two Callboards can run from one global install with
 * different `CALLBOARD_DATA_DIR`s and different ports; each passes every gate
 * here independently, because every gate is about *this* process. When one of
 * them updates, npm rewrites the tree under both — and the other is neither
 * restarted nor told. It goes on serving the new `frontend/dist` from its old
 * backend for as long as it lives. It does now *notice*
 * ({@link describeRestartPending} compares its boot version against disk, and
 * its own banner says "restart pending"), which is the most a process with no
 * knowledge of its siblings can honestly do.
 */
const NEW_BUNDLE_IS_LIVE =
  "One thing to know while you wait: the new version's web interface is already being served from this daemon, because npm replaced those files in place. Nothing breaks if you keep the page you have open, but avoid reloading until after `callboard restart` — a reloaded tab would be the new interface talking to the old server. If you run a second Callboard from this same global install (a different data directory and port), npm replaced its files too — it is still running the old code and nothing has restarted it, so restart that one as well.";

// ── What Callboard is, according to Callboard ───────────────────────

/**
 * This daemon's own identity — the boot snapshot, never a fresh read.
 *
 * It used to be read per call, with a comment saying that was fine because "it
 * is cheap, and it changes under us during an upgrade". The second clause was
 * the bug: a value that changes under us during an upgrade is precisely the one
 * thing this feature must not use to describe itself. `version` here is the
 * version this process is *executing*; what npm wrote is a different question
 * with a different reader ({@link readPackageManifest} against the global root).
 */
export function selfPackage(): Readonly<PackageManifest> | null {
  return BOOT_MANIFEST;
}

/** The command a user would type. The button runs this same argv; the copy block never disappears. */
export function selfUpdateCommand(packageName: string): string {
  return `npm install -g ${packageName}`;
}

/**
 * `realpath`, or the path as given.
 *
 * Both sides of the install-source comparison are resolved this way because a
 * global prefix is very often reached through a symlink — nvm's `versions/node`
 * tree, Homebrew's `/usr/local`, a `~/.npm-global` someone moved — and comparing
 * the unresolved strings would refuse a daemon that genuinely *is* the global
 * copy. A path that cannot be resolved (it does not exist) falls back to itself,
 * which then simply fails the comparison.
 */
function resolved(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Where npm would install this package, and whether that is where this daemon is running from. */
export interface InstallSource {
  /** `<npm root -g>/<package>`, when the root resolved. */
  globalPackageRoot?: string;
  /** The directory this daemon is actually running from. */
  runningFrom: string;
  /** True when the two are the same directory, symlinks resolved. */
  isGlobalInstall: boolean;
  /**
   * True when the global entry is itself a symlink — an `npm link`ed checkout.
   *
   * Reported separately from {@link isGlobalInstall} rather than folded into
   * it, because both facts are true at once and only saying the second one
   * produces the misleading half of the sentence: the directories *do* match,
   * and the reason that is not good enough is the link.
   */
  isLinked: boolean;
  /** Why the global root could not be resolved, when it could not. */
  error?: string;
}

/** Is `p` a symlink, as opposed to whatever it points at? `lstat`, so it does not follow. */
function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    // It does not exist, or cannot be stat'ed. Either way it is not a link this
    // function has seen, and `isGlobalInstall` is the check that then refuses.
    return false;
  }
}

export async function resolveInstallSource(packageName: string): Promise<InstallSource> {
  const runningFrom = resolved(__pkgRoot);
  const { root, error } = await resolveNpmGlobalRoot();
  if (!root) return { runningFrom, isGlobalInstall: false, isLinked: false, ...(error ? { error } : {}) };
  // A scoped name joins as two segments, which is exactly how npm lays it out.
  const globalPackageRoot = path.join(root, ...packageName.split("/"));
  return {
    globalPackageRoot,
    runningFrom,
    isGlobalInstall: resolved(globalPackageRoot) === runningFrom,
    isLinked: isSymlink(globalPackageRoot),
  };
}

// ── Is there anything to restart? ───────────────────────────────────

/** The PID file `callboard start` writes, and `callboard stop` reads. */
export const PID_FILE = path.join(DATA_DIR, "callboard.pid");

/**
 * Does the PID file name **this** process?
 *
 * Not merely "does it exist". `cmdStop` SIGTERMs whatever pid it reads, so a
 * file left behind by an earlier daemon — or written by a *different* Callboard
 * sharing this data directory — would aim the restart at the wrong process, and
 * this one would carry on running the old code while something else died. The
 * daemon `callboard start` spawns is the process whose pid it records, so the
 * equality holds for every install this feature is willing to act on.
 */
export function pidFileNamesThisProcess(): boolean {
  try {
    return parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10) === process.pid;
  } catch {
    return false;
  }
}

// ── Has this daemon's own code been replaced underneath it? ─────────

/**
 * Compare the version this process is running against the one in its own
 * package directory, right now.
 *
 * Cheap — one `readFileSync` of a small JSON file, on an endpoint the banner
 * asks once per mount — and it answers a question no other check here can, which
 * is why it reads `__pkgRoot` rather than `<npm root -g>/<package>`: those are
 * the same directory for the daemon that pressed the button, and the interesting
 * case is the daemon that did *not*.
 *
 * Two Callboards can share one global install with different
 * `CALLBOARD_DATA_DIR`s and ports. Every other gate in this module is about
 * *this* process, so both pass independently; when one updates, npm rewrites the
 * tree under both, and the other is neither restarted nor notified. It carries
 * on executing old backend code while serving the new `frontend/dist`, and
 * before this it had no way to say so — its About page read the same rewritten
 * manifest and reported the new version, which made the state invisible in the
 * one place a user would look.
 *
 * There is no way for this process to restart its sibling, and it does not try:
 * the PID file it would need names the other daemon and lives in the other data
 * directory. What it can do is notice and say so, which is what this is for.
 *
 * Also true, benignly, on the update path itself — between npm exiting and the
 * restart landing — which is the same fact and the same sentence.
 */
export function describeRestartPending(): { pending: boolean; runningVersion?: string; installedVersion?: string } {
  const runningVersion = BOOT_VERSION ?? undefined;
  const installedVersion = readPackageManifest(__pkgRoot)?.version;
  if (!runningVersion || !installedVersion) return { pending: false, ...(runningVersion ? { runningVersion } : {}), ...(installedVersion ? { installedVersion } : {}) };
  return { pending: installedVersion !== runningVersion, runningVersion, installedVersion };
}

// ── Is anything in flight? ──────────────────────────────────────────

/**
 * Work a restart would destroy, named.
 *
 * Two sources, and both are needed. The session registry holds streaming chats —
 * `gracefulShutdown` aborts those turns outright — and a job run can be mid-step
 * with no *web* session attached to it (a parallel branch, a poll step). Only
 * `running` job runs count: `waiting_approval`, `sleeping` and the other
 * non-terminal statuses are resumed by `initJobRunner` on the next boot, so a
 * restart costs them nothing.
 *
 * CLI sessions are deliberately excluded. Those are `claude` processes this
 * daemon watches rather than owns; stopping the daemon does not stop them, and
 * counting them would make the button permanently unavailable to anyone who
 * leaves a terminal open.
 */
/**
 * Make a user-authored string safe to drop into a refusal sentence.
 *
 * The sentences this builds are rendered by `UpdateBanner.tsx`, which splits on
 * backticks to turn `` `like this` `` into a `<code>` span — so an *odd* number
 * of backticks anywhere in an interpolated title flips the parity of everything
 * after it, and the rest of the refusal renders as one long code span. A chat
 * titled ``fix the useEffect deps`` is not exotic in a coding tool, and the
 * fallback source for a title is `preview`, which is a whole first user message
 * and may contain a fenced block. So backticks are removed rather than escaped:
 * there is no escape the splitter understands, and the title is being quoted for
 * recognition, not for reproduction.
 *
 * Whitespace is collapsed for the same reason `card-rollup.ts` collapses it —
 * a multi-line preview inlined into a sentence is a paragraph break in the
 * middle of a clause. This code took that file's *reading* of the metadata blob
 * and not its normalisation; this is the missing half.
 *
 * Clipped after normalising, so the 60-character budget is spent on characters
 * that will actually be shown.
 */
function forSentence(raw: string): string {
  const flat = raw.replace(/`/g, "").replace(/\s+/g, " ").trim();
  // Titles run to 240 characters and previews are a whole first message.
  // Three of either, inline in a refusal sentence, is a wall.
  return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
}

/**
 * What a user would call this chat, or its id.
 *
 * The title lives in the record's `metadata` blob rather than on the record, so
 * this is the same `(title || preview || null)` reading `chat-lineage.ts` and
 * `card-rollup.ts` make. Every failure — no record, unparseable metadata, an
 * unreadable directory — falls back to the id, because a summary naming a raw
 * UUID is worse than one naming a title and still far better than none.
 */
function chatTitle(chatId: string): string {
  try {
    const chat = chatFileService.getChat(chatId);
    if (!chat) return chatId;
    const meta = JSON.parse(chat.metadata || "{}");
    const title: string = (typeof meta.title === "string" && meta.title) || (typeof meta.preview === "string" && meta.preview) || "";
    if (!title) return chatId;
    // A title that normalises away to nothing (all whitespace, or nothing but
    // backticks) is no better than no title at all.
    return forSentence(title) || chatId;
  } catch (err) {
    log.warn(`could not name chat ${chatId} for the restart summary: ${err instanceof Error ? err.message : String(err)}`);
    return chatId;
  }
}

export function describeWorkInFlight(): { busy: boolean; summary: string } {
  const chatIds: string[] = [];
  try {
    for (const [chatId, info] of Object.entries(sessionRegistry.getAll())) {
      if (info.type === "web") chatIds.push(chatId);
    }
  } catch (err) {
    log.warn(`could not read the session registry: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Named the way job runs are, rather than by raw UUID: "1 chat is still
  // streaming (a2f7719c-…)" tells a user nothing they can act on, and it is the
  // sentence that has to persuade them the refusal was right.
  //
  // Only the ids the summary will actually print are looked up, and a lookup
  // that fails falls back to the id rather than to nothing: `getChat`'s miss
  // path is a readdir and a parse of every chat record, and paying that per
  // streaming session for a phrase that names three of them is not a trade
  // worth making.
  const chats = chatIds.map((chatId, i) => (i < NAMED_IN_SUMMARY ? chatTitle(chatId) : chatId));

  let runs: string[] = [];
  try {
    // Job titles are as user-authored as chat titles, and land in the same
    // backtick-split sentence.
    runs = listRuns({ status: "running" }).map((r) => forSentence(r.title || r.jobName || "") || r.runId);
  } catch (err) {
    // A job store that cannot be listed is not permission to restart into it.
    log.warn(`could not list job runs: ${err instanceof Error ? err.message : String(err)}`);
    return { busy: true, summary: "Callboard could not check whether any job runs are active, and it will not restart without knowing" };
  }

  if (chats.length === 0 && runs.length === 0) return { busy: false, summary: "" };

  const parts: string[] = [];
  if (chats.length > 0)
    parts.push(
      `${chats.length} chat${chats.length === 1 ? " is" : "s are"} still streaming (${chats.slice(0, NAMED_IN_SUMMARY).join(", ")}${chats.length > NAMED_IN_SUMMARY ? ", …" : ""})`,
    );
  if (runs.length > 0)
    parts.push(
      `${runs.length} job run${runs.length === 1 ? " is" : "s are"} mid-step (${runs.slice(0, NAMED_IN_SUMMARY).join(", ")}${runs.length > NAMED_IN_SUMMARY ? ", …" : ""})`,
    );
  return { busy: true, summary: parts.join(" and ") };
}

// ── Capability ──────────────────────────────────────────────────────

/**
 * May this client press "Download latest & restart", and if not, why not?
 *
 * The shared install preflight first — LAN-only, `allowEngineInstalls`, the
 * platform, a resolvable and writable global prefix — then this feature's own
 * two gates. The order is deliberate: the shared refusals are about the machine
 * and are the ones an operator can act on, while "you are running from a
 * checkout" is only interesting once everything else would have allowed it.
 *
 * Never throws. A preflight that cannot answer is a refusal, and a refusal still
 * renders the copy-and-paste command.
 */
export async function getSelfUpdateCapability(opts: { local: boolean }): Promise<SelfUpdateCapability> {
  const base = await getInstallCapability(opts);
  if (!base.oneClick) {
    return {
      oneClick: false,
      // Every code the shared preflight can produce is in this feature's union
      // too; `disabled` is the conservative default for one that is not.
      code: (base.code as SelfUpdateRefusalCode) ?? "disabled",
      refusal: base.refusal ?? "Callboard will not run installs on this machine.",
    };
  }

  const pkg = selfPackage();
  if (!pkg) {
    return {
      oneClick: false,
      code: "package-unreadable",
      refusal: `Callboard could not read its own \`package.json\` (looked in \`${__pkgRoot}\`), so it cannot tell which package to install or which version it is replacing. Run the command in a terminal instead.`,
    };
  }

  const source = await resolveInstallSource(pkg.name);
  if (!source.isGlobalInstall) {
    return {
      oneClick: false,
      code: "not-global-install",
      refusal: source.globalPackageRoot
        ? `This Callboard is running from \`${source.runningFrom}\`, which is not npm's global copy (\`${source.globalPackageRoot}\`). \`npm install -g ${pkg.name}\` would upgrade that other copy and restart this one from the same unchanged files, so Callboard will not offer it as a button. Update this checkout the way you installed it.`
        : `Callboard could not work out where npm keeps its global packages (${source.error ?? "no output"}), so it cannot confirm that it is the copy an install would replace. Run the command in a terminal instead.`,
    };
  }

  if (source.isLinked) {
    // The paths matched, and they matched *through the link* — this is a
    // development checkout wired up with `npm link`. Running the install would
    // unlink it: npm replaces `<npm root -g>/<package>` with a real package,
    // the checkout stops being the thing that is running, and the restart comes
    // up somewhere other than the directory this daemon just reported.
    return {
      oneClick: false,
      code: "not-global-install",
      refusal: `npm's copy of ${pkg.name} (\`${source.globalPackageRoot}\`) is a symlink to \`${source.runningFrom}\` — this is an \`npm link\`ed checkout, not a global install. \`npm install -g ${pkg.name}\` would delete that link and install a published package over it, so Callboard would restart from somewhere else and your checkout would no longer be linked. Update the checkout the way you built it, or run the command in a terminal if unlinking is what you want.`,
    };
  }

  // Not a refusal. See the module header: this is the one "installed, did not
  // restart" outcome that is knowable *before* the install, so it is declared up
  // front instead of withholding a capability the very next sentence claims to
  // have. `restart: "unavailable"` on the capability is what the banner renders
  // beside the button, and {@link finishInstalled} lands the run on
  // `restart: "refused"` with the same reason.
  const noRestart = restartUnavailableReason();
  const notes = [base.note, noRestart].filter((n): n is string => Boolean(n));
  return {
    oneClick: true,
    ...(noRestart ? { restart: "unavailable" as const } : {}),
    ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
  };
}

/**
 * Why a restart could not be run from here, or nothing.
 *
 * One sentence, used twice and deliberately identical in both: once as a note
 * beside the button (before the install, so nobody presses it expecting a
 * restart) and once as the `restartRefusal` on the verdict (after it, because a
 * promise made up front still has to be kept up front *and* at the end).
 */
function restartUnavailableReason(): string | null {
  if (pidFileNamesThisProcess()) return null;
  return `Callboard has no PID file naming this process (\`${PID_FILE}\`), so it was not started by \`callboard start\` — a foreground run, or systemd, pm2, Docker or a process manager of your own. It can install the new version here, but \`callboard restart\` would find nothing to stop, so the restart itself is yours to do however you started it.`;
}

// ── The run ─────────────────────────────────────────────────────────

export interface SelfUpdateRun {
  updateId: string;
  package: string;
  command: string;
  argv: readonly string[];
  fromVersion: string;
  /** `<npm root -g>/<package>` — where the new files land, and where the restart helper is read from. */
  globalPackageRoot: string;
  startedAt: number;
  finishedAt: number | null;
  log: RunLog<SelfUpdateEvent>;
  child: ChildProcess | null;
  done: boolean;
  /** The pending hand-over to the restart helper, so an abandoned run does not restart the daemon behind its back. */
  restartTimer: NodeJS.Timeout | null;
}

/**
 * One self-update at a time, process-wide — the same singleton shape
 * `engine-install.ts` uses, and for the same reason: npm's global tree has no
 * cross-process lock.
 *
 * The finished run is retained rather than cleared so a stream that connects
 * late still replays the transcript. In the ordinary case nothing ever reads it,
 * because the daemon it belongs to is gone by then; it matters for the runs that
 * *failed*, which are the ones a user needs the transcript of.
 */
let current: SelfUpdateRun | null = null;

/**
 * Is an update still holding this daemon?
 *
 * Deliberately wider than "is npm running". `run.done` is set the moment npm
 * exits, and the *hand-over* — the {@link RESTART_DELAY_MS} beat and the helper
 * spawn it schedules — happens after that. For those 500ms nothing else was
 * true either: `isInstallRunning()` and `npmInstallInFlight()` are both clear,
 * so a second POST landing in the window was accepted, spawned its own npm, and
 * replaced `current` — while the first run's orphaned timer fired anyway and
 * SIGTERMed the daemon in the middle of the new install's writes.
 *
 * So a pending restart counts as running, and {@link startSelfUpdate} clears
 * any timer it displaces.
 */
export function isSelfUpdateRunning(): boolean {
  return current !== null && (!current.done || current.restartTimer !== null);
}

/** The id of an update currently in flight, so a second tab attaches instead of starting another. */
export function activeSelfUpdateId(): string | undefined {
  return isSelfUpdateRunning() ? current!.updateId : undefined;
}

export function getSelfUpdateRun(updateId: string): SelfUpdateRun | null {
  if (!current || current.updateId !== updateId) return null;
  if (current.done && current.finishedAt !== null && Date.now() - current.finishedAt > RETENTION_MS) return null;
  return current;
}

export function selfUpdateRunEvents(run: SelfUpdateRun): SelfUpdateEvent[] {
  return run.log.snapshot();
}

export function isSelfUpdateRunDone(run: SelfUpdateRun): boolean {
  return run.done;
}

export function subscribeToSelfUpdateRun(run: SelfUpdateRun, listener: (event: SelfUpdateEvent) => void): () => void {
  return run.log.subscribe(listener);
}

/** Test seam: forget the retained run, and kill anything still attached to it. */
export function resetSelfUpdateState(): void {
  // The restart is scheduled rather than immediate, so abandoning a run has to
  // cancel it — otherwise a run nobody is watching any more still stops the
  // daemon half a second later.
  if (current?.restartTimer) clearTimeout(current.restartTimer);
  if (current?.child && !current.done) {
    try {
      current.child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  current = null;
  clearNpmInstallInFlight();
  resetNpmRootCache();
}

// ── Starting one ────────────────────────────────────────────────────

export type StartSelfUpdateResult =
  | { ok: true; updateId: string; package: string; command: string; fromVersion: string }
  | { ok: false; code: SelfUpdateRefusalCode; refusal: string; status: number };

/**
 * The last gate before `spawn`, and the one that does not trust its caller.
 *
 * Everything here is true by construction — the argv is assembled two lines
 * above from a name this daemon read out of its own manifest — which is exactly
 * why it is asserted rather than assumed. Exported so the suite can drive it
 * with argv shapes the assembler will not produce.
 */
export function assertSelfUpdateArgv(argv: readonly string[], packageName: string): boolean {
  if (!Array.isArray(argv) || argv.length !== 4) return false;
  if (argv[0] !== "npm" || argv[1] !== "install" || argv[2] !== "-g") return false;
  if (argv[3] !== packageName) return false;
  // The pattern excludes a leading `-` as well as the obvious shapes, so a
  // manifest naming itself `--force` cannot slip a flag past a check whose
  // comment claims the name is verified rather than trusted.
  if (!PACKAGE_NAME_PATTERN.test(packageName)) return false;
  return argv.every((part) => typeof part === "string" && part.length > 0);
}

/**
 * Start an update, or say why not.
 *
 * `capability` is passed in rather than recomputed, so the button the user
 * pressed and the check this makes are provably the same decision — the route
 * builds it once per request from the same {@link getSelfUpdateCapability} the
 * banner was rendered from.
 */
export function startSelfUpdate(opts: {
  capability: SelfUpdateCapability;
  /**
   * The package and paths the capability check already resolved. Re-resolving
   * here would be a second, possibly different, answer.
   *
   * There is deliberately **no `fromVersion`** here. It used to be one, supplied
   * by the route from a fresh `package.json` read, and that was the shape of the
   * bug: after one install that read returns the *new* version, so a retry
   * compared the new file against itself and concluded nothing had changed. The
   * version being replaced is not a caller's to state — it is {@link
   * BOOT_VERSION}, and a parameter no caller can pass is a parameter no test can
   * decouple from production either.
   */
  source: { packageName: string; globalPackageRoot: string };
  /** For the log line. Never reaches argv, a path, or a command. */
  clientKey?: string;
}): StartSelfUpdateResult {
  const { capability, source } = opts;

  if (!capability.oneClick) {
    log.warn(`refused self-update for ${opts.clientKey ?? "unknown client"}: ${capability.refusal ?? "no capability"}`);
    return {
      ok: false,
      code: capability.code ?? "disabled",
      refusal: capability.refusal ?? "Callboard will not update itself on this machine.",
      // A permission answer is 403; a machine-state answer is 422. The client
      // renders the same sentence either way — the distinction is for logs and
      // for anything that ever automates against this.
      status: capability.code === "not-local" || capability.code === "disabled" ? 403 : 422,
    };
  }

  const argv = Object.freeze(["npm", "install", "-g", source.packageName]);
  if (!assertSelfUpdateArgv(argv, source.packageName)) {
    log.error(`self-update argv failed its own assertions for package "${source.packageName}"; refusing`);
    return { ok: false, code: "package-unreadable", refusal: "Callboard will not run an install it cannot verify the shape of. Run the command in a terminal instead.", status: 500 };
  }

  if (isSelfUpdateRunning()) {
    return { ok: false, code: "busy", refusal: "Callboard is already updating itself and runs one update at a time. Watch that one, or copy the command into a terminal.", status: 409 };
  }
  if (isInstallRunning() || npmInstallInFlight()) {
    // Whichever feature got there first. `npmInstallInFlight` is the general
    // answer and `isInstallRunning` the specific one; both are asked because the
    // first is cleared the moment npm exits, while an engine install is still
    // re-probing for a few seconds after that.
    return {
      ok: false,
      code: "busy",
      refusal: `Callboard is already running ${npmInstallInFlight() ?? "an engine install"} and runs one global install at a time. Wait for it to finish, or copy the command into a terminal.`,
      status: 409,
    };
  }

  // See {@link COOLDOWN_MS}. Measured from the previous run's completion, so
  // the deferred-restart retry this feature tells users to make is not the
  // thing it catches.
  const sinceLast = current?.finishedAt ? Date.now() - current.finishedAt : Infinity;
  if (sinceLast < COOLDOWN_MS) {
    const waitSeconds = Math.max(1, Math.ceil((COOLDOWN_MS - sinceLast) / 1000));
    return {
      ok: false,
      code: "cooling-down",
      refusal: `Callboard just finished an update and will not run \`npm install -g\` on itself again straight away. Try again in ${waitSeconds} second${waitSeconds === 1 ? "" : "s"}, or copy the command into a terminal.`,
      status: 429,
    };
  }

  const command = selfUpdateCommand(source.packageName);
  const run: SelfUpdateRun = {
    updateId: randomUUID(),
    package: source.packageName,
    command,
    argv,
    // The version this process is *executing*, not whatever is in the package
    // directory at this instant — which after one install is already the new
    // one. `"unknown"` only when the manifest was unreadable at boot, in which
    // case the capability refused with `package-unreadable` long before here.
    fromVersion: BOOT_VERSION ?? "unknown",
    globalPackageRoot: source.globalPackageRoot,
    startedAt: Date.now(),
    finishedAt: null,
    log: new RunLog<SelfUpdateEvent>("update_output"),
    child: null,
    done: false,
    restartTimer: null,
  };
  // Belt and braces against the window {@link isSelfUpdateRunning} now closes:
  // a run that is being replaced must not still be holding a timer that will
  // stop this daemon on the *previous* update's behalf. The gate above should
  // make this unreachable; a stray SIGTERM is not a failure mode to leave
  // depending on one check being right.
  if (current?.restartTimer) {
    clearTimeout(current.restartTimer);
    current.restartTimer = null;
    log.warn(`self-update ${current.updateId}: cancelled its pending restart — update ${run.updateId} replaced it`);
  }
  current = run;

  run.log.emit({
    type: "update_started",
    updateId: run.updateId,
    package: run.package,
    command: run.command,
    fromVersion: run.fromVersion,
    startedAt: new Date(run.startedAt).toISOString(),
  });

  log.info(`self-update ${run.updateId} from v${run.fromVersion} (requested by ${opts.clientKey ?? "unknown client"}): ${run.argv.join(" ")}`);
  spawnUpdate(run);

  return { ok: true, updateId: run.updateId, package: run.package, command: run.command, fromVersion: run.fromVersion };
}

// ── Running one ─────────────────────────────────────────────────────

function rollbackCommandFor(run: SelfUpdateRun): string {
  return `npm install -g ${run.package}@${run.fromVersion}`;
}

function spawnUpdate(run: SelfUpdateRun): void {
  run.child = spawnNpmInstall({
    argv: run.argv,
    label: `self-update ${run.updateId}`,
    what: "a Callboard self-update",
    isDone: () => run.done,
    onLine: (stream, line) => run.log.emit({ type: "update_output", stream, line }),
    onDone: (outcome) => {
      if (outcome.kind === "spawn-error") {
        finishFailed(run, null, null, npmSpawnRefusal(run.command, outcome.error));
        return;
      }
      const { code, signal } = outcome;
      if (code === 0) {
        finishInstalled(run);
        return;
      }
      const refusal =
        signal !== null
          ? `\`${run.command}\` was killed (${signal})${signal === "SIGKILL" ? " — it ran past Callboard's ten-minute limit" : ""}. Callboard is still running v${run.fromVersion} and has not restarted. Run the command in a terminal, where you can watch it without a timeout.`
          : `\`${run.command}\` exited with code ${code}. The output above is npm's; Callboard is still running v${run.fromVersion} and has not restarted. Run the same command in a terminal to retry it interactively.`;
      finishFailed(run, code, signal, refusal);
    },
  });
}

function finishFailed(run: SelfUpdateRun, code: number | null, signal: NodeJS.Signals | null, refusal: string): void {
  run.done = true;
  run.finishedAt = Date.now();
  run.child = null;
  resetNpmRootCache();
  log.warn(`self-update ${run.updateId} failed (code=${code}, signal=${signal}): ${refusal}`);
  run.log.emit({
    type: "update_exit",
    updateId: run.updateId,
    ok: false,
    code,
    signal,
    durationMs: run.finishedAt - run.startedAt,
    refusal,
  });
}

/**
 * npm exited 0. Now find out what is actually on disk, and whether to restart.
 *
 * The exit event goes out first and claims nothing, because "npm exited 0" and
 * "a newer Callboard is installed" are different statements — the same split
 * engine installs make. Then the version is *read from the package.json npm has
 * just rewritten*, and only that reading is allowed to name a version.
 *
 * `changed` compares that reading against `run.fromVersion`, which is {@link
 * BOOT_VERSION} — the code this process is executing — and the whole of one bug
 * lived in that being a fresh read instead. On a *second* press both sides read
 * the same already-overwritten file, `changed` came out false, and the run
 * reported `restart: "skipped"` with the words "there is nothing to restart
 * into" while the daemon went on running the old code. That second press is
 * exactly the retry the deferred-restart branch below tells the user to make, so
 * the documented way out of "a chat was streaming, try again when idle" could
 * never restart anything.
 */
function finishInstalled(run: SelfUpdateRun): void {
  run.done = true;
  run.finishedAt = Date.now();
  run.child = null;
  resetNpmRootCache();

  run.log.emit({
    type: "update_exit",
    updateId: run.updateId,
    ok: true,
    code: 0,
    signal: null,
    durationMs: run.finishedAt - run.startedAt,
  });

  const rollbackCommand = rollbackCommandFor(run);
  const installed = readPackageManifest(run.globalPackageRoot);
  const installedVersion = installed?.version;
  const changed = installedVersion !== undefined && installedVersion !== run.fromVersion;

  if (!installedVersion) {
    const refusal = `\`${run.command}\` exited 0, but Callboard could not read \`${path.join(run.globalPackageRoot, "package.json")}\` afterwards, so it cannot tell what is installed — and it will not restart into a version it has not seen. Check the output above, then restart Callboard yourself with \`callboard restart\`. ${NEW_BUNDLE_IS_LIVE}`;
    log.warn(`self-update ${run.updateId}: ${refusal}`);
    run.log.emit({
      type: "update_verified",
      updateId: run.updateId,
      fromVersion: run.fromVersion,
      changed: false,
      summary: refusal,
      restart: "refused",
      restartRefusal: refusal,
      rollbackCommand,
    });
    return;
  }

  if (!changed) {
    // npm found nothing newer *and* it is the same version this process is
    // running — so restarting would kill every in-flight turn to load exactly
    // the same code, a cost with no benefit. The honest reading is that the
    // "update available" the banner showed came from a version check that has
    // since been overtaken.
    //
    // Both halves matter. Against a fresh read of the manifest this branch also
    // swallowed the case where the version had moved and this process had simply
    // not restarted into it yet, and told the user there was nothing to restart
    // into while there very much was.
    const summary = `\`${run.command}\` finished and the installed version is still v${installedVersion} — npm had nothing newer to fetch, and it is the version Callboard is already running. Callboard has not restarted, because there is nothing to restart into.`;
    log.info(`self-update ${run.updateId}: already on v${installedVersion}; no restart`);
    run.log.emit({
      type: "update_verified",
      updateId: run.updateId,
      fromVersion: run.fromVersion,
      installedVersion,
      changed: false,
      summary,
      restart: "skipped",
      rollbackCommand,
    });
    return;
  }

  // A version that moved *backwards* is not an error — `npm install -g` installs
  // whatever the registry calls latest, and a release can be unpublished or
  // deprecated out from under a cached "update available". It is worth saying,
  // because the banner promised an upgrade.
  const direction = isNewerVersion(run.fromVersion, installedVersion) ? "" : " (which is not newer than what was running — npm's `latest` has moved)";

  // The disposition the capability already declared. Checked again here rather
  // than trusted from the capability object, because a pid file can appear or
  // vanish between the button rendering and npm finishing — and because a
  // promise made before the install is worth nothing if the code after it
  // reaches `spawnRestartHelper` regardless. The sentence is the same one the
  // note carried, so a user who read it before pressing sees it confirmed rather
  // than contradicted.
  const noRestart = restartUnavailableReason();
  if (noRestart) {
    const refusal = `v${installedVersion} is installed${direction}. ${noRestart} The new version takes effect the moment you do. ${NEW_BUNDLE_IS_LIVE}`;
    log.warn(`self-update ${run.updateId}: installed v${installedVersion} but cannot restart — no pid file naming this process`);
    run.log.emit({
      type: "update_verified",
      updateId: run.updateId,
      fromVersion: run.fromVersion,
      installedVersion,
      changed: true,
      summary: refusal,
      restart: "refused",
      restartRefusal: refusal,
      rollbackCommand,
    });
    return;
  }

  // Resolved before the beat below, unlike the work-in-flight check, because it
  // is a question about disk rather than about timing: the helper either exists
  // in the package npm just wrote or it does not, and nothing that happens in
  // the next 500ms changes the answer.
  const helper = resolveRestartHelper(run.globalPackageRoot);
  if (!helper) {
    const refusal = `v${installedVersion} is installed, but Callboard could not find the \`callboard\` CLI inside \`${run.globalPackageRoot}\` to restart itself with. The new version takes effect on the next restart — run \`callboard restart\` in a terminal. ${NEW_BUNDLE_IS_LIVE}`;
    log.warn(`self-update ${run.updateId}: ${refusal}`);
    run.log.emit({
      type: "update_verified",
      updateId: run.updateId,
      fromVersion: run.fromVersion,
      installedVersion,
      changed: true,
      summary: refusal,
      restart: "refused",
      restartRefusal: refusal,
      rollbackCommand,
    });
    return;
  }

  run.log.emit({
    type: "update_verified",
    updateId: run.updateId,
    fromVersion: run.fromVersion,
    installedVersion,
    changed: true,
    summary: `v${installedVersion} is installed${direction}. Restarting Callboard now — this connection will drop, and the page will reconnect on its own.`,
    restart: "pending",
    rollbackCommand,
  });

  recordUpdate(run, installedVersion);

  // A beat, so the frame above reaches the browser before this daemon commits
  // to dying. Everything that decides *whether* to restart happens on the far
  // side of it — see the module header: the check has to be the last thing
  // before the spawn, not the last thing before a timer that leads to one.
  run.restartTimer = setTimeout(() => {
    run.restartTimer = null;

    const work = describeWorkInFlight();
    if (work.busy) {
      const refusal = `v${installedVersion} is installed, but Callboard did not restart: ${work.summary}, and a restart stops those mid-turn. The new version takes effect the next time Callboard restarts — press this again when things are idle, or run \`callboard restart\` yourself. ${NEW_BUNDLE_IS_LIVE}`;
      log.warn(`self-update ${run.updateId}: installed v${installedVersion} but did not restart — ${work.summary}`);
      run.log.emit({
        type: "update_verified",
        updateId: run.updateId,
        fromVersion: run.fromVersion,
        installedVersion,
        changed: true,
        summary: refusal,
        restart: "refused",
        restartRefusal: refusal,
        rollbackCommand,
      });
      return;
    }

    // Loud, in the place a user looks when the daemon does not come back: this
    // is the last line the old process writes, and `callboard logs` still shows
    // it afterwards because the new process appends to the same file.
    log.warn(`self-update ${run.updateId}: restarting into v${installedVersion} from v${run.fromVersion}. If Callboard does not come back, run: ${rollbackCommand}`);

    // Emitted immediately before the spawn rather than 500ms ahead of it, and
    // it still reaches the browser: the helper has its own Node boot to pay
    // before `cmdStop` signals this pid. Saying it any earlier would be
    // announcing a restart the check above is still entitled to refuse.
    run.log.emit({
      type: "update_restarting",
      updateId: run.updateId,
      fromVersion: run.fromVersion,
      installedVersion,
      helper,
      rollbackCommand,
    });

    const failed = (detail: string) => {
      const refusal = `v${installedVersion} is installed, but Callboard could not start the helper that restarts it (${detail}). Callboard is still running v${run.fromVersion}; run \`callboard restart\` in a terminal to pick up the new version. ${NEW_BUNDLE_IS_LIVE}`;
      log.error(`self-update ${run.updateId}: ${refusal}`);
      run.log.emit({ type: "update_restart_failed", updateId: run.updateId, refusal, rollbackCommand });
    };

    spawnRestartHelper(helper, run.globalPackageRoot, failed);
  }, RESTART_DELAY_MS);
}

// ── Restarting ──────────────────────────────────────────────────────

/**
 * The `callboard` CLI inside the freshly-installed package, or nothing.
 *
 * Read from the *new* package's own `bin` field, which is both more honest than
 * hardcoding `bin/callboard.js` and the only way to notice that the thing npm
 * installed is not shaped like Callboard at all. The result must live **inside**
 * the package root — strictly inside, so a `bin` of `"."` or `"./"` resolving
 * back to the root itself is refused rather than admitted. That path exists, so
 * the `existsSync` below would pass it, and `node <packageRoot>` runs the
 * package's own main entry: a second Callboard server in the foreground of the
 * helper's process, holding the port the restart was meant to free.
 */
export function resolveRestartHelper(globalPackageRoot: string): string | null {
  // A fresh read, deliberately, and one of the two places in this module where
  // that is the right question: this is the package npm has *just written*, not
  // the one this process is running.
  const pkg = readPackageManifest(globalPackageRoot);
  if (!pkg?.bin) return null;
  const helper = path.resolve(globalPackageRoot, pkg.bin);
  if (!helper.startsWith(globalPackageRoot + path.sep)) return null;
  return existsSync(helper) ? helper : null;
}

/**
 * Hand the machine over.
 *
 * `detached` is the load-bearing option: it gives the helper its own process
 * group, so the SIGTERM that this process is about to receive — and the death
 * that follows it — does not reach the thing doing the restarting. `stdio:
 * "ignore"` because there is no one left to read it (the CLI's own `cmdStart`
 * reopens the log file for the new daemon), and `unref()` so this event loop is
 * not held open by a child that will outlive it.
 *
 * `--port` is forwarded when this process has one in its environment, which is
 * how `callboard start` launches it. Without that the CLI would fall back to
 * whatever `.env` says, and a daemon started on a port that lives only in an
 * environment variable would come back on a different one — the browser would
 * poll for a server that is running perfectly well somewhere else.
 *
 * ## Why there is an `error` listener as well as a `try`
 *
 * The `try` catches almost nothing. `spawn` throws synchronously only for a bad
 * *argument*; every way the operating system can refuse this — `EACCES` or
 * `ENOENT` on the cwd, `EAGAIN` or `EMFILE` under fork pressure, and the fork
 * itself failing — arrives later as an `error` event on the returned child.
 * With no listener that event is what Node calls an unhandled `'error'`: it is
 * rethrown, `installProcessGuards` logs it and calls `process.exit(1)`, and the
 * result is the worst outcome this feature has — the daemon gone, no helper
 * running to bring it back, and the client told nothing because the old code
 * had already reported the spawn as a success. `spawnNpmInstall` gets this
 * right for npm; this is the same listener for the same reason.
 *
 * @param onFailure called once, from either path, with a short description.
 */
function spawnRestartHelper(helper: string, cwd: string, onFailure: (detail: string) => void): void {
  let child;
  try {
    const port = process.env.PORT?.trim();
    const argv = port ? [helper, "restart", "--port", port] : [helper, "restart"];
    child = spawn(process.execPath, argv, { detached: true, stdio: "ignore", env: process.env, cwd });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.error(`failed to spawn restart helper: ${detail}`);
    onFailure(detail);
    return;
  }

  // Attached *before* `unref()`: unreferencing does not detach the listener,
  // but it does let this event loop drain, and there is no version of this
  // where the window between the two is worth leaving open.
  child.on("error", (err) => {
    const detail = err instanceof Error ? err.message : String(err);
    log.error(`restart helper failed after spawn: ${detail}`);
    onFailure(detail);
  });
  child.unref();
  log.info(`spawned restart helper ${helper} (PID ${child.pid})`);
}

/**
 * Leave a note for the version that may not come back.
 *
 * Best-effort and deliberately tiny. The browser is told the same thing in
 * {@link SelfUpdateRestartingEvent}, but a browser can be closed, and the daemon
 * that could answer questions about this is the one being replaced. Overwritten
 * by the next update; nothing reads it automatically, which is the point — it is
 * evidence, not state.
 */
function recordUpdate(run: SelfUpdateRun, installedVersion: string): void {
  try {
    writeFileSync(
      STATE_FILE,
      JSON.stringify(
        {
          updateId: run.updateId,
          package: run.package,
          previousVersion: run.fromVersion,
          installedVersion,
          rollbackCommand: rollbackCommandFor(run),
          at: new Date().toISOString(),
        },
        null,
        2,
      ) + "\n",
    );
  } catch (err) {
    // Not a reason to abandon the restart: the same facts are in the log line
    // immediately below the call site and in the event stream above it.
    log.warn(`could not write ${STATE_FILE}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
