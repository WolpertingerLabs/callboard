/**
 * Sandbox desktop profiles: the registry of recipes, their images' state, and
 * the explicit build. Like sandbox-image.ts this imports only node builtins,
 * the computer-use package and sandbox-image.ts, because `bin/callboard.js`
 * imports it for `callboard sandbox build --profile`, `profiles` and `rm`.
 *
 * **Recipes** are data (`packages/computer-use/src/remote/profile.ts`): the
 * package validates and compiles them; this file finds them, fetches and
 * verifies their downloads, runs the two builds and reads the images back.
 *
 * **Scope and identity.** Every profile lives in a scope: `global` (the
 * built-ins, shipped in the package's `docker/profiles/*.json`, and later any
 * profile every chat may use) or one workspace's (`w<12 hex>`, a hash of the
 * chat's `workspaceId` when it has one and of its folder otherwise — never
 * parsed back; see CLAUDE.md, "Workspace keying"). Its **entry id** is
 * `<scope>/<name>` (`global/blender`); the id drives its image tag
 * (`callboard/computer-use-profile:blender`, or `…:<scope>-<name>` for a
 * workspace's) and the variant a session is opened with. The seam for
 * agent-proposed profiles (a later change) is {@link ProfileSource}: a source
 * per scope, stored under `<data dir>/sandbox-desktop/profiles/<scope>/`. A
 * chat sees the global scope and its own workspace's; a global name is never
 * shadowed.
 *
 * **Builds are explicit** — `callboard sandbox build --profile <name>` or
 * Settings → Sandbox desktop — never implicit, and only a signed-in human may
 * start one.
 */
import { createHash, randomBytes } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { createReadStream, createWriteStream, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { chmod, copyFile, link, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage } from "node:http";
import { BlockList, isIP } from "node:net";
import { dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  PROFILE_IMAGE_REPOSITORY,
  PROFILE_LABELS,
  PROFILE_SECURITY_FLOOR,
  PROTOCOL,
  SANDBOX_IMAGE_LABELS,
  SANDBOX_SECURITY_FLOOR,
  compileProfile,
  isProfileName,
  isProfileScopeKey,
  parseProfileRecipe,
  profileCompilerDigest,
  profileDownloadUrlProblem,
  profileEntryId,
  profileImageBuildArgs,
  profileImageTag,
  profilePackagesBuildArgs,
  profilePackagesTag,
  profileRecipeDigest,
  profileSupportsArchitecture,
  type ProfileRecipe,
  type ProfileScopeKey,
} from "@wolpertingerlabs/computer-use";
import {
  DockerError,
  SANDBOX_IMAGE,
  buildSandboxImage,
  imageId,
  inspectSandboxImage,
  runDockerBuild,
  sandboxBuildContext,
  sandboxBuilderImage,
  sandboxContentDigest,
  type DockerRunner,
} from "./sandbox-image.js";

export type { ProfileScopeKey };

/** Where a profile's recipe comes from. `builtin`: shipped with Callboard. */
export type ProfileSourceKind = "builtin";

/** A recipe the registry knows, validated, with its identity and the image it builds. */
export interface ProfileEntry {
  /** `<scope>/<name>`. */
  id: string;
  scope: ProfileScopeKey;
  recipe: ProfileRecipe;
  /** {@link profileRecipeDigest}: what a consent is bound to. */
  digest: string;
  source: ProfileSourceKind;
  /** `<repository>:<name>` (global) or `<repository>:<scope>-<name>`. */
  image: string;
}

/** Which chat is asking: where its work lives. */
export interface ProfileChatScope {
  workspaceId?: string;
  folder?: string;
}
/** @deprecated The old name of {@link ProfileChatScope}. */
export type ProfileScope = ProfileChatScope;

/** A set of recipes in one scope. A later change adds one per workspace, from the data directory. */
export interface ProfileSource {
  kind: ProfileSourceKind;
  scope: ProfileScopeKey;
  list(): ProfileEntry[];
}

/**
 * A chat's workspace scope key: a hash of its `workspaceId` when it has one,
 * else of its folder; undefined with neither. One-way: never parsed back.
 */
export function workspaceScopeKey(chat: ProfileChatScope): ProfileScopeKey | undefined {
  const basis = chat.workspaceId ? `workspace\0${chat.workspaceId}` : chat.folder ? `folder\0${chat.folder}` : undefined;
  return basis ? `w${createHash("sha256").update(`callboard-profile-scope\0${basis}`).digest("hex").slice(0, 12)}` : undefined;
}
/** The scopes a chat may use profiles from, in precedence order: global first, then its workspace's. */
export function scopesFor(chat: ProfileChatScope): ProfileScopeKey[] {
  const own = workspaceScopeKey(chat);
  return own ? ["global", own] : ["global"];
}

/** The repository profile images are tagged in (`CALLBOARD_SANDBOX_PROFILE_REPOSITORY` overrides it, for tests). */
export function profileRepository(): string {
  return process.env.CALLBOARD_SANDBOX_PROFILE_REPOSITORY?.trim() || PROFILE_IMAGE_REPOSITORY;
}

/** The built-in recipes' directory: `docker/profiles` in the shipped package. */
export function builtinProfilesDir(context = sandboxBuildContext()): string {
  return join(context, "docker", "profiles");
}

const builtinMemo = new Map<string, { stamp: string; entries: ProfileEntry[]; errors: string[] }>();
/**
 * The built-in recipes (global scope), validated. A file that does not
 * validate is left out and reported in `errors` (a test keeps every shipped
 * recipe valid).
 */
export function loadBuiltinProfiles(dir = builtinProfilesDir(), repository = profileRepository()): { entries: ProfileEntry[]; errors: string[] } {
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .sort();
  } catch {
    return { entries: [], errors: [] };
  }
  const stamp = `${repository}|${files.map((file) => `${file}:${statSync(join(dir, file)).mtimeMs}`).join("|")}`;
  const memo = builtinMemo.get(dir);
  if (memo?.stamp === stamp) return memo;
  const entries: ProfileEntry[] = [];
  const errors: string[] = [];
  for (const file of files) {
    try {
      const recipe = parseProfileRecipe(readFileSync(join(dir, file), "utf8"));
      if (`${recipe.name}.json` !== file) throw new Error(`the file must be named ${recipe.name}.json`);
      entries.push(makeEntry(recipe, "global", "builtin", repository));
    } catch (error) {
      errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const result = { stamp, entries, errors };
  builtinMemo.set(dir, result);
  return result;
}

export function makeEntry(recipe: ProfileRecipe, scope: ProfileScopeKey, source: ProfileSourceKind, repository = profileRepository()): ProfileEntry {
  return {
    id: profileEntryId(scope, recipe.name),
    scope,
    recipe,
    digest: profileRecipeDigest(recipe),
    source,
    image: profileImageTag(recipe.name, scope, repository),
  };
}

export const builtinSource = (dir?: string): ProfileSource => ({ kind: "builtin", scope: "global", list: () => loadBuiltinProfiles(dir).entries });
/** Every source this Callboard has. Today: the built-ins. */
export const defaultSources = (): ProfileSource[] => [builtinSource()];

/**
 * Every profile a chat may use: the global scope's, then its own workspace's,
 * a name taken by an earlier scope never shadowed by a later one.
 */
export function listProfiles(chat: ProfileChatScope = {}, sources: readonly ProfileSource[] = defaultSources()): ProfileEntry[] {
  const visible = new Set<string>(scopesFor(chat));
  const order = scopesFor(chat);
  const seen = new Set<string>();
  const out: ProfileEntry[] = [];
  for (const scope of order)
    for (const source of sources) {
      if (source.scope !== scope || !visible.has(scope)) continue;
      for (const entry of source.list()) {
        if (seen.has(entry.recipe.name)) continue;
        seen.add(entry.recipe.name);
        out.push(entry);
      }
    }
  return out;
}
/** Every profile in every scope this Callboard knows: for the operator (Settings, the CLI). */
export function listAllProfiles(sources: readonly ProfileSource[] = defaultSources()): ProfileEntry[] {
  return sources.flatMap((source) => source.list());
}

/** A profile by name, as a chat sees it. */
export function resolveProfile(name: string, chat: ProfileChatScope = {}, sources?: readonly ProfileSource[]): ProfileEntry | undefined {
  if (!isProfileName(name)) return undefined;
  return listProfiles(chat, sources).find((entry) => entry.recipe.name === name);
}
/** A profile by entry id (`global/blender`), whatever the chat: for the operator. */
export function resolveProfileId(id: string, sources: readonly ProfileSource[] = defaultSources()): ProfileEntry | undefined {
  return listAllProfiles(sources).find((entry) => entry.id === id);
}
/** An entry id from a request's `profile` and optional `scope` (default global). Undefined if either is malformed. */
export function entryIdOf(profile: unknown, scope: unknown = "global"): string | undefined {
  if (!isProfileName(profile) || !isProfileScopeKey(scope)) return undefined;
  return profileEntryId(scope, profile);
}

/**
 * What `docker image inspect` says about a profile image, judged against the
 * recipe, the compiler and the current base:
 * - `missing`: not built.
 * - `current`: built from this recipe, by this compiler, on the current base content.
 * - `outdated`: the base's content or the compiler changed since (`outdatedBy`).
 *   It still starts, but it runs the driver host and epilogue of the build it
 *   came from: rebuild it to pick up their fixes. Building the base (`callboard
 *   sandbox build`) from new files makes every profile out of date.
 * - `rebuild-required`: built from another recipe. Refused: a human consents
 *   to a recipe, and this image is not it.
 * - `unlabelled`: not labelled as this profile's image (not built by Callboard,
 *   or for another scope). Refused.
 * - `insecure`: below the base's or the profile compiler's security floor. Refused.
 * - `incompatible`: another protocol major. Refused.
 */
export type ProfileImageState = "missing" | "current" | "outdated" | "rebuild-required" | "unlabelled" | "insecure" | "incompatible";
export interface ProfileImageInfo {
  state: ProfileImageState;
  outdatedBy?: ("base" | "compiler")[];
  detail?: string;
  id?: string;
  builtAt?: string;
  sizeBytes?: number;
  /** The recipe digest it was built from (its label). */
  recipe?: string;
}
/** States a session may start from. */
export const STARTABLE_PROFILE_STATES: readonly ProfileImageState[] = ["current", "outdated"];

/** The current base, to judge profile images by: the content digest a current base carries (and, for information, its image ID). */
export interface BaseIdentity {
  imageId?: string;
  content?: string;
}
export async function currentBase(docker: DockerRunner, image = SANDBOX_IMAGE, signal?: AbortSignal): Promise<BaseIdentity> {
  let content: string | undefined;
  try {
    content = sandboxContentDigest();
  } catch {
    content = undefined;
  }
  return { imageId: await imageId(docker, image, signal).catch(() => undefined), ...(content ? { content } : {}) };
}

/**
 * Read a profile image's labels and judge it ({@link ProfileImageState}).
 * Staleness compares the base's *content* digest and the security floors,
 * not the base's image ID: a base rebuilt from identical files (a new ID)
 * changes nothing a profile depends on, and must not flag every profile.
 */
export async function inspectProfileImage(docker: DockerRunner, entry: ProfileEntry, base: BaseIdentity, signal?: AbortSignal): Promise<ProfileImageInfo> {
  let raw: string;
  try {
    raw = await docker(["image", "inspect", "--format", "{{json .Config.Labels}}\t{{.Id}}\t{{.Created}}\t{{.Size}}", entry.image], {
      signal,
      timeoutMs: 15_000,
    });
  } catch (error) {
    if (error instanceof DockerError && error.reason === "failed" && /no such image|not found/i.test(error.stderr)) return { state: "missing" };
    throw error;
  }
  const [labelsJson = "null", id, created, size] = raw.trim().split("\t");
  let labels: Record<string, string> = {};
  try {
    labels = (JSON.parse(labelsJson) as Record<string, string> | null) ?? {};
  } catch {
    labels = {};
  }
  const recipe = labels[PROFILE_LABELS.recipe];
  const meta = {
    ...(id && /^sha256:[0-9a-f]{64}$/.test(id) ? { id } : {}),
    ...(created ? { builtAt: created } : {}),
    ...(size && /^\d+$/.test(size) ? { sizeBytes: Number(size) } : {}),
    ...(recipe ? { recipe } : {}),
  };
  const protocol = labels[SANDBOX_IMAGE_LABELS.protocol];
  if (typeof protocol !== "string" || !/^\d+\.\d+$/.test(protocol) || Number(protocol.split(".")[0]) !== PROTOCOL.major)
    return { state: "incompatible", detail: `It speaks protocol ${protocol ?? "(unlabelled)"}; rebuild it.`, ...meta };
  // Images from before scope labels exist only in the global scope.
  const scope = labels[PROFILE_LABELS.scope] ?? "global";
  if (labels[PROFILE_LABELS.name] !== entry.recipe.name || scope !== entry.scope)
    return { state: "unlabelled", detail: "It is not labelled as this profile's image (not built by Callboard for this profile); rebuild it.", ...meta };
  const floor = (key: string) => (/^\d{1,6}$/.test(labels[key] ?? "") ? Number(labels[key]) : undefined);
  const baseFloor = floor(SANDBOX_IMAGE_LABELS.securityFloor);
  const profileFloor = floor(PROFILE_LABELS.floor);
  if (baseFloor === undefined || baseFloor < SANDBOX_SECURITY_FLOOR || profileFloor === undefined || profileFloor < PROFILE_SECURITY_FLOOR)
    return {
      state: "insecure",
      detail: `It has a known security issue (security level ${baseFloor ?? "unlabelled"}/${profileFloor ?? "unlabelled"}, at least ${SANDBOX_SECURITY_FLOOR}/${PROFILE_SECURITY_FLOOR} required); rebuild it.`,
      ...meta,
    };
  if (recipe !== entry.digest)
    return {
      state: "rebuild-required",
      detail: "It was built from another version of this recipe, so it cannot start for a consent to the current one; rebuild it.",
      ...meta,
    };
  const outdatedBy: ("base" | "compiler")[] = [];
  if (!base.content || labels[PROFILE_LABELS.baseContent] !== base.content) outdatedBy.push("base");
  if (labels[PROFILE_LABELS.compiler] !== profileCompilerDigest()) outdatedBy.push("compiler");
  if (outdatedBy.length)
    return {
      state: "outdated",
      outdatedBy,
      detail: `Built on ${outdatedBy.includes("base") ? "an older base image" : ""}${outdatedBy.length === 2 ? " and " : ""}${outdatedBy.includes("compiler") ? "an older profile compiler" : ""}: it still starts, but it runs the driver host and hardening of the build it came from. Rebuild it to pick up their fixes.`,
      ...meta,
    };
  return { state: "current", ...meta };
}

/** The Docker daemon's architecture (`amd64`, `arm64`, …), what a profile builds for. */
export async function hostArchitecture(docker: DockerRunner, signal?: AbortSignal): Promise<string> {
  return (await docker(["version", "--format", "{{.Server.Arch}}"], { signal, timeoutMs: 10_000 })).trim();
}
export function architectureProblem(entry: ProfileEntry, arch: string | undefined): string | undefined {
  if (!arch || profileSupportsArchitecture(entry.recipe, arch)) return undefined;
  return `Profile ${entry.recipe.name} builds only on ${entry.recipe.architectures.join(", ")}, and this Docker host is ${arch}.`;
}

// ── Downloads ───────────────────────────────────────────────────────────

/** Per file. A profile's downloads together get {@link DOWNLOAD_TOTAL_LIMIT}. */
export const DOWNLOAD_FILE_LIMIT = 4 * 1024 ** 3;
export const DOWNLOAD_TOTAL_LIMIT = 8 * 1024 ** 3;
/** Redirects followed per download, each one checked as a fresh URL. */
export const DOWNLOAD_MAX_REDIRECTS = 5;

/**
 * Addresses a download may never connect to, whatever name resolved to them:
 * this machine, private and link-local networks, carrier-grade NAT, the
 * documentation, benchmarking and multicast ranges, and the IPv6 forms that
 * embed or tunnel an IPv4 address.
 */
const BLOCKED = (() => {
  const list = new BlockList();
  for (const [net, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const)
    list.addSubnet(net, prefix, "ipv4");
  for (const [net, prefix] of [
    ["::", 128],
    ["::1", 128],
    // (No ::ffff:0:0/96 rule: BlockList matches every IPv4 address against it. A mapped address is judged as its IPv4 below.)
    ["64:ff9b::", 96],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001::", 23],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["fc00::", 7],
    ["fe80::", 10],
    ["fec0::", 10],
    ["ff00::", 8],
  ] as const)
    list.addSubnet(net, prefix, "ipv6");
  return list;
})();
/** Why a download may not connect to `address`, or undefined. */
export function addressProblem(address: string): string | undefined {
  const family = isIP(address);
  if (family === 0) return "is not an IP address";
  // An IPv4-mapped IPv6 address is judged as the IPv4 address it is.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return addressProblem(mapped);
  return BLOCKED.check(address, family === 4 ? "ipv4" : "ipv6") ? "is a loopback, private, link-local or reserved address" : undefined;
}

export interface FetchOptions {
  dataDir: string;
  signal?: AbortSignal;
  log?: (line: string) => void;
  /** Resolve a host name to all its addresses (default: the system resolver). */
  lookup?: (hostname: string) => Promise<{ address: string; family: number }[]>;
  /** Extra CA certificates to trust (tests). */
  ca?: string | Buffer;
  /** Whether a download may connect to `address` for `url` (default: {@link addressProblem} finds nothing). Tests only. */
  addressAllowed?: (address: string, url: URL) => boolean;
}

const sha256File = (file: string) =>
  new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });

/**
 * One https GET to an address checked beforehand: the request connects to
 * exactly that address (its `lookup` answers with it), so a name cannot
 * resolve to something else between the check and the connection. TLS still
 * verifies the certificate for the URL's host name.
 */
function getPinned(url: URL, address: string, family: number, options: FetchOptions): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        protocol: "https:",
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        servername: url.hostname,
        headers: { "user-agent": "callboard-sandbox-profile-build", accept: "*/*" },
        ...(options.ca ? { ca: options.ca } : {}),
        signal: options.signal,
        timeout: 60_000,
        lookup: ((_hostname: string, opts: { all?: boolean }, callback: (...args: unknown[]) => void) =>
          opts?.all ? callback(null, [{ address, family }]) : callback(null, address, family)) as never,
      },
      resolve,
    );
    request.on("timeout", () => request.destroy(new Error("the server stopped answering")));
    request.on("error", reject);
    request.end();
  });
}

/**
 * A recipe download, verified: from the cache (`<dataDir>/sandbox-desktop/profile-downloads/<sha256>`,
 * re-hashed before every use), else fetched and kept only if its SHA-256
 * matches. Never unpacked here: that happens inside the build, as the desktop user.
 *
 * The host does the fetch, so it is guarded against being pointed at this
 * machine or its network (SSRF): redirects are followed by hand, at most
 * {@link DOWNLOAD_MAX_REDIRECTS}, and every hop must pass the recipe's own URL
 * rules (https, a public host name); every hop's name is resolved here, every
 * address it resolves to must be public ({@link addressProblem}), and the
 * connection is pinned to the checked address.
 */
export async function fetchVerified(download: { url: string; sha256: string }, options: FetchOptions): Promise<string> {
  const dir = join(options.dataDir, "sandbox-desktop", "profile-downloads");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, download.sha256);
  if (existsSync(file)) {
    if ((await sha256File(file)) === download.sha256) {
      options.log?.(`Using the cached ${download.url} (sha256 ${download.sha256.slice(0, 12)}…)\n`);
      return file;
    }
    await rm(file, { force: true });
  }
  options.log?.(`Downloading ${download.url} …\n`);
  const lookup = options.lookup ?? ((hostname: string) => dnsLookup(hostname, { all: true, verbatim: true }));
  const allowed = options.addressAllowed ?? ((address: string) => !addressProblem(address));
  let url = new URL(download.url);
  let response: IncomingMessage | undefined;
  for (let hop = 0; ; hop++) {
    const problem = profileDownloadUrlProblem(url.href);
    if (problem) throw new Error(`Download refused: ${hop ? "it redirected to a URL that" : "the URL"} ${problem}. Nothing was built.`);
    let addresses: { address: string; family: number }[];
    try {
      addresses = await lookup(url.hostname);
    } catch {
      throw new Error(`Download failed: ${url.hostname} does not resolve`);
    }
    if (!addresses.length) throw new Error(`Download failed: ${url.hostname} does not resolve`);
    // Every address, not just the one used: a name that also points inward is refused outright.
    if (addresses.some((a) => !allowed(a.address, url)))
      throw new Error(`Download refused: ${url.hostname} resolves to a loopback, private, link-local or reserved address. Nothing was built.`);
    const [{ address, family }] = addresses as [{ address: string; family: number }];
    const res = await getPinned(url, address, family, options);
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      if (hop >= DOWNLOAD_MAX_REDIRECTS) throw new Error(`Download refused: more than ${DOWNLOAD_MAX_REDIRECTS} redirects`);
      try {
        url = new URL(res.headers.location, url);
      } catch {
        throw new Error("Download refused: it redirected to an unparseable URL");
      }
      continue;
    }
    if (status !== 200) {
      res.resume();
      throw new Error(`Download failed: ${url.hostname} answered ${status}`);
    }
    response = res;
    break;
  }
  const declared = Number(response.headers["content-length"] ?? "0");
  if (declared > DOWNLOAD_FILE_LIMIT) {
    response.destroy();
    throw new Error(`Download refused: ${download.url} is larger than ${DOWNLOAD_FILE_LIMIT / 1024 ** 3} GiB`);
  }
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.part`;
  const hash = createHash("sha256");
  let bytes = 0;
  let reported = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > DOWNLOAD_FILE_LIMIT) return callback(new Error(`Download refused: ${download.url} is larger than ${DOWNLOAD_FILE_LIMIT / 1024 ** 3} GiB`));
      if (bytes - reported >= 50 * 1024 * 1024) {
        reported = bytes;
        options.log?.(`  ${Math.round(bytes / 1024 / 1024)} MiB\n`);
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(response, meter, createWriteStream(temp, { mode: 0o600 }), { signal: options.signal });
    // Never the digest that arrived: a build log must not become an oracle for what a URL serves.
    if (hash.digest("hex") !== download.sha256) throw new Error(`Download refused: ${download.url} failed its checksum (sha256 mismatch). Nothing was built.`);
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
  options.log?.(`  verified, ${Math.round(bytes / 1024 / 1024)} MiB\n`);
  return file;
}

// ── Building ────────────────────────────────────────────────────────────

async function writeContext(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, content, { mode: 0o644 });
  }
}

export interface ProfileBuildOptions {
  entry: ProfileEntry;
  docker: DockerRunner;
  dataDir: string;
  binary?: string;
  baseImage?: string;
  builderImage?: string;
  onOutput?: (chunk: string) => void;
  signal?: AbortSignal;
  stdio?: "inherit";
  /** For the downloads (tests: a resolver, a CA, an address policy). */
  fetch?: Pick<FetchOptions, "lookup" | "ca" | "addressAllowed">;
}

/**
 * Build one profile image, explicitly. In order:
 *
 * 0. The Docker host's architecture must be one the recipe lists (before
 *    anything is built or downloaded).
 * 1. The base and its builder stage must both be current (built from what
 *    this Callboard ships, and from the same files); otherwise they are
 *    built first, as `callboard sandbox build` would.
 * 2. Every download is fetched (or taken from the cache) and checked against
 *    its SHA-256 before anything is built.
 * 3. The package build (the recipe's Debian packages, root, with the network)
 *    and the profile build (`--network=none`: downloads unpacked and setup
 *    run as the desktop user, then Callboard's epilogue), both from image
 *    IDs, so a base rebuilt meanwhile cannot slip in.
 * 4. The intermediate package image's tag is removed; the build directory always is.
 */
export async function buildProfileImage(options: ProfileBuildOptions): Promise<{ image: string; id?: string }> {
  const { entry, docker } = options;
  const say = (line: string) => (options.stdio === "inherit" ? process.stdout.write(line) : options.onOutput?.(line));
  const arch = architectureProblem(entry, await hostArchitecture(docker, options.signal));
  if (arch) throw new Error(`${arch} Nothing was downloaded or built.`);
  const baseImage = options.baseImage ?? SANDBOX_IMAGE;
  const builderImage = options.builderImage ?? sandboxBuilderImage(baseImage);
  const [base, builder] = await Promise.all([
    inspectSandboxImage(docker, baseImage, options.signal),
    inspectSandboxImage(docker, builderImage, options.signal),
  ]);
  const ready = (info: typeof base) => info.present && info.compatible && info.secure && info.current;
  if (!ready(base) || !ready(builder) || base.content !== builder.content) {
    say(
      `The base image ${baseImage} and its builder ${builderImage} are not both current; building them first. (That makes every other profile out of date until it is rebuilt.)\n`,
    );
    await buildSandboxImage({
      binary: options.binary,
      image: baseImage,
      builderImage,
      onOutput: options.onOutput,
      signal: options.signal,
      stdio: options.stdio,
    });
  }
  const [baseId, builderId] = await Promise.all([imageId(docker, baseImage, options.signal), imageId(docker, builderImage, options.signal)]);
  if (!baseId || !builderId) throw new Error(`The base image ${baseImage} or its builder ${builderImage} is missing after building it.`);
  const baseContent = sandboxContentDigest();
  const compiled = compileProfile(entry.recipe);
  const root = join(options.dataDir, "sandbox-desktop", "profile-builds", `${entry.scope}-${entry.recipe.name}-${randomBytes(6).toString("hex")}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const repository = entry.image.slice(0, entry.image.lastIndexOf(":"));
  const intermediate = profilePackagesTag(entry.recipe.name, entry.scope, repository);
  try {
    await writeContext(join(root, "packages"), compiled.packagesContext);
    await writeContext(join(root, "profile"), compiled.profileContext);
    let total = 0;
    for (const download of compiled.downloads) {
      const cached = await fetchVerified(download, { dataDir: options.dataDir, signal: options.signal, log: say, ...options.fetch });
      total += statSync(cached).size;
      if (total > DOWNLOAD_TOTAL_LIMIT) throw new Error(`The profile's downloads together exceed ${DOWNLOAD_TOTAL_LIMIT / 1024 ** 3} GiB`);
      const target = join(root, "profile", "downloads", String(download.index));
      await link(cached, target).catch(() => copyFile(cached, target));
    }
    say(`Building the packages of profile ${entry.id} (${compiled.packagesContext["packages.txt"]!.split("\n").filter(Boolean).length} Debian packages) …\n`);
    await runDockerBuild(profilePackagesBuildArgs({ context: join(root, "packages"), builderImage: builderId, tag: intermediate }), {
      binary: options.binary,
      onOutput: options.onOutput,
      signal: options.signal,
      stdio: options.stdio,
    });
    const packagesId = await imageId(docker, intermediate, options.signal);
    if (!packagesId) throw new Error("The package build produced no image");
    say(`Building profile ${entry.id} (no network) …\n`);
    await runDockerBuild(
      profileImageBuildArgs({
        context: join(root, "profile"),
        builderImage: builderId,
        packagesImage: packagesId,
        baseImage: baseId,
        baseContent,
        name: entry.recipe.name,
        scope: entry.scope,
        digest: compiled.digest,
        gl: compiled.gl,
        tag: entry.image,
      }),
      { binary: options.binary, onOutput: options.onOutput, signal: options.signal, stdio: options.stdio },
    );
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    // Untags only: its layers stay as the profile image's parents (and the build cache).
    await docker(["rmi", intermediate], { timeoutMs: 60_000 }).catch(() => {});
  }
  return { image: entry.image, id: await imageId(docker, entry.image).catch(() => undefined) };
}

/**
 * Remove a profile's image. Docker refuses while a container (a running or a
 * kept sandbox) uses it, and that refusal is passed on. False if there was none.
 */
export async function removeProfileImage(docker: DockerRunner, entry: ProfileEntry): Promise<boolean> {
  try {
    await docker(["rmi", entry.image], { timeoutMs: 60_000 });
    return true;
  } catch (error) {
    if (error instanceof DockerError && /no such image|not found/i.test(error.stderr)) return false;
    if (error instanceof DockerError && /being used|conflict/i.test(error.stderr))
      throw new Error(`Profile ${entry.id}'s image is in use by a sandbox container (running or kept for recovery); stop or discard it first.`);
    throw error;
  }
}

/**
 * The service variant a profile session is opened with:
 * `<scope>:<name>@<first 16 hex of the recipe digest>`. The manager resolves
 * the entry again at start, refuses a recipe whose digest no longer matches
 * what was consented to, and an image not built from exactly that recipe.
 */
export function profileVariant(entry: ProfileEntry): string {
  return `${entry.scope}:${entry.recipe.name}@${entry.digest.slice(0, 16)}`;
}
export function parseProfileVariant(variant: string): { scope: ProfileScopeKey; name: string; id: string; digest: string } | undefined {
  const match = /^(global|w[0-9a-f]{12}):([a-z][a-z0-9-]{0,30}[a-z0-9])@([0-9a-f]{16})$/.exec(variant);
  if (!match || !isProfileName(match[2])) return undefined;
  const scope = match[1] as ProfileScopeKey;
  return { scope, name: match[2]!, id: profileEntryId(scope, match[2]!), digest: match[3]! };
}
