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
 * **Where recipes come from.** Today, only the built-ins shipped in the
 * package (`docker/profiles/*.json`): `blender` and `test`. The seam for
 * agent-proposed profiles (a later change) is {@link ProfileSource}: a
 * source per workspace, stored under the data directory
 * (`sandbox-desktop/profiles/<scope>/<name>.json`), where `<scope>` keys on the
 * chat's `workspaceId` when it has one and on its folder otherwise — never one
 * parsed into the other (see CLAUDE.md, "Workspace keying"). Such a source
 * must not shadow a built-in name, and its images need a scope in their tag.
 * {@link listProfiles} and {@link resolveProfile} already take the scope.
 *
 * **Builds are explicit** — `callboard sandbox build --profile <name>` or
 * Settings → Sandbox desktop — never implicit, and only a signed-in human may
 * start one.
 */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { chmod, link, copyFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
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
  parseProfileRecipe,
  profileImageBuildArgs,
  profilePackagesBuildArgs,
  profileRecipeDigest,
  type ProfileRecipe,
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

/** Where a profile's recipe comes from. `builtin`: shipped with Callboard. */
export type ProfileSourceKind = "builtin";

/** A recipe the registry knows, validated, with the image it builds. */
export interface ProfileEntry {
  recipe: ProfileRecipe;
  digest: string;
  source: ProfileSourceKind;
  /** `<repository>:<name>`. */
  image: string;
}

/**
 * Which chat is asking. Unused while only built-ins exist; a workspace's own
 * profiles key on `workspaceId` when present, else on `folder`.
 */
export interface ProfileScope {
  workspaceId?: string;
  folder?: string;
}

/** A set of recipes. A later change adds one per workspace, from the data directory. */
export interface ProfileSource {
  kind: ProfileSourceKind;
  list(): ProfileEntry[];
}

/** The repository profile images are tagged in (`CALLBOARD_SANDBOX_PROFILE_REPOSITORY` overrides it, for tests). */
export function profileRepository(): string {
  return process.env.CALLBOARD_SANDBOX_PROFILE_REPOSITORY?.trim() || PROFILE_IMAGE_REPOSITORY;
}
export const profileImage = (name: string, repository = profileRepository()) => `${repository}:${name}`;
const packagesImage = (name: string, repository = profileRepository()) => `${repository}:${name}-packages`;

/** The built-in recipes' directory: `docker/profiles` in the shipped package. */
export function builtinProfilesDir(context = sandboxBuildContext()): string {
  return join(context, "docker", "profiles");
}

const builtinMemo = new Map<string, { stamp: string; entries: ProfileEntry[]; errors: string[] }>();
/**
 * The built-in recipes, validated. A file that does not validate is left out
 * and reported in `errors` (a test keeps every shipped recipe valid).
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
      entries.push({ recipe, digest: profileRecipeDigest(recipe), source: "builtin", image: profileImage(recipe.name, repository) });
    } catch (error) {
      errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const result = { stamp, entries, errors };
  builtinMemo.set(dir, result);
  return result;
}

export const builtinSource = (dir?: string): ProfileSource => ({ kind: "builtin", list: () => loadBuiltinProfiles(dir).entries });

/** Every profile visible to a chat in `scope` (today: the built-ins). */
export function listProfiles(_scope: ProfileScope = {}, sources: readonly ProfileSource[] = [builtinSource()]): ProfileEntry[] {
  const seen = new Set<string>();
  const out: ProfileEntry[] = [];
  for (const source of sources)
    for (const entry of source.list()) {
      // The first source wins a name: a later (scoped) source never shadows a built-in.
      if (seen.has(entry.recipe.name)) continue;
      seen.add(entry.recipe.name);
      out.push(entry);
    }
  return out;
}

export function resolveProfile(name: string, scope: ProfileScope = {}, sources?: readonly ProfileSource[]): ProfileEntry | undefined {
  if (!isProfileName(name)) return undefined;
  return listProfiles(scope, sources).find((entry) => entry.recipe.name === name);
}

/** What `docker image inspect` says about a profile image, judged against the recipe and the current base. */
export interface ProfileImageInfo {
  state: "missing" | "current" | "outdated" | "insecure" | "incompatible";
  outdatedBy?: ("recipe" | "base")[];
  detail?: string;
  id?: string;
  builtAt?: string;
  sizeBytes?: number;
}

/** The current base, to judge profile images by: its image ID and the content digest a current base carries. */
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
 * Read a profile image's labels and judge it. Refused (`insecure`,
 * `incompatible`) exactly as a base image would be, plus the profile
 * compiler's own floor and the name label; `outdated` when the recipe digest
 * or the base it was built on differs from now (it still starts).
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
  const meta = {
    ...(id && /^sha256:[0-9a-f]{64}$/.test(id) ? { id } : {}),
    ...(created ? { builtAt: created } : {}),
    ...(size && /^\d+$/.test(size) ? { sizeBytes: Number(size) } : {}),
  };
  const protocol = labels[SANDBOX_IMAGE_LABELS.protocol];
  if (typeof protocol !== "string" || !/^\d+\.\d+$/.test(protocol) || Number(protocol.split(".")[0]) !== PROTOCOL.major)
    return { state: "incompatible", detail: `It speaks protocol ${protocol ?? "(unlabelled)"}; rebuild it.`, ...meta };
  const floor = (key: string) => (/^\d{1,6}$/.test(labels[key] ?? "") ? Number(labels[key]) : undefined);
  const baseFloor = floor(SANDBOX_IMAGE_LABELS.securityFloor);
  const profileFloor = floor(PROFILE_LABELS.floor);
  if (labels[PROFILE_LABELS.name] !== entry.recipe.name)
    return { state: "insecure", detail: "It is not labelled as this profile's image (not built by Callboard); rebuild it.", ...meta };
  if (baseFloor === undefined || baseFloor < SANDBOX_SECURITY_FLOOR || profileFloor === undefined || profileFloor < PROFILE_SECURITY_FLOOR)
    return {
      state: "insecure",
      detail: `It has a known security issue (security level ${baseFloor ?? "unlabelled"}/${profileFloor ?? "unlabelled"}, at least ${SANDBOX_SECURITY_FLOOR}/${PROFILE_SECURITY_FLOOR} required); rebuild it.`,
      ...meta,
    };
  const outdatedBy: ("recipe" | "base")[] = [];
  if (labels[PROFILE_LABELS.recipe] !== entry.digest) outdatedBy.push("recipe");
  if (!base.imageId || labels[PROFILE_LABELS.baseImage] !== base.imageId || !base.content || labels[PROFILE_LABELS.baseContent] !== base.content)
    outdatedBy.push("base");
  if (outdatedBy.length)
    return {
      state: "outdated",
      outdatedBy,
      detail: `Built from ${outdatedBy.includes("recipe") ? "an older recipe" : ""}${outdatedBy.length === 2 ? " and " : ""}${outdatedBy.includes("base") ? "another base image" : ""}; it still starts, but rebuild it.`,
      ...meta,
    };
  return { state: "current", ...meta };
}

// ── Downloads ───────────────────────────────────────────────────────────

/** Per file. A profile's downloads together get {@link DOWNLOAD_TOTAL_LIMIT}. */
export const DOWNLOAD_FILE_LIMIT = 4 * 1024 ** 3;
export const DOWNLOAD_TOTAL_LIMIT = 8 * 1024 ** 3;

const sha256File = (file: string) =>
  new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });

/**
 * A recipe download, verified: from the cache (`<dataDir>/sandbox-desktop/profile-downloads/<sha256>`,
 * re-hashed before every use), else fetched over https, hashed as it streams,
 * and kept only if it matches. A redirect must stay on https. Never unpacked
 * here: that happens inside the build, as the desktop user.
 */
export async function fetchVerified(
  download: { url: string; sha256: string },
  options: { dataDir: string; signal?: AbortSignal; log?: (line: string) => void; fetchImpl?: typeof fetch },
): Promise<string> {
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
  const response = await (options.fetchImpl ?? fetch)(download.url, { redirect: "follow", signal: options.signal });
  if (!response.ok || !response.body) throw new Error(`Download failed: ${download.url} answered ${response.status}`);
  if (response.url && !response.url.startsWith("https://")) throw new Error(`Download refused: ${download.url} redirected away from https`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > DOWNLOAD_FILE_LIMIT) throw new Error(`Download refused: ${download.url} is larger than ${DOWNLOAD_FILE_LIMIT / 1024 ** 3} GiB`);
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
    await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>), meter, createWriteStream(temp, { mode: 0o600 }), {
      signal: options.signal,
    });
    const actual = hash.digest("hex");
    if (actual !== download.sha256)
      throw new Error(`Download refused: ${download.url} has sha256 ${actual}, but the recipe requires ${download.sha256}. Nothing was built.`);
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
  fetchImpl?: typeof fetch;
}

/**
 * Build one profile image, explicitly. In order:
 *
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
  const baseImage = options.baseImage ?? SANDBOX_IMAGE;
  const builderImage = options.builderImage ?? sandboxBuilderImage(baseImage);
  const [base, builder] = await Promise.all([
    inspectSandboxImage(docker, baseImage, options.signal),
    inspectSandboxImage(docker, builderImage, options.signal),
  ]);
  const ready = (info: typeof base) => info.present && info.compatible && info.secure && info.current;
  if (!ready(base) || !ready(builder) || base.content !== builder.content) {
    say(`The base image ${baseImage} and its builder ${builderImage} are not both current; building them first.\n`);
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
  const root = join(options.dataDir, "sandbox-desktop", "profile-builds", `${entry.recipe.name}-${randomBytes(6).toString("hex")}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const repository = entry.image.slice(0, entry.image.lastIndexOf(":"));
  const intermediate = packagesImage(entry.recipe.name, repository);
  try {
    await writeContext(join(root, "packages"), compiled.packagesContext);
    await writeContext(join(root, "profile"), compiled.profileContext);
    let total = 0;
    for (const download of compiled.downloads) {
      const cached = await fetchVerified(download, { dataDir: options.dataDir, signal: options.signal, log: say, fetchImpl: options.fetchImpl });
      total += statSync(cached).size;
      if (total > DOWNLOAD_TOTAL_LIMIT) throw new Error(`The profile's downloads together exceed ${DOWNLOAD_TOTAL_LIMIT / 1024 ** 3} GiB`);
      const target = join(root, "profile", "downloads", String(download.index));
      await link(cached, target).catch(() => copyFile(cached, target));
    }
    say(
      `Building the packages of profile ${entry.recipe.name} (${compiled.packagesContext["packages.txt"]!.split("\n").filter(Boolean).length} Debian packages) …\n`,
    );
    await runDockerBuild(profilePackagesBuildArgs({ context: join(root, "packages"), builderImage: builderId, tag: intermediate }), {
      binary: options.binary,
      onOutput: options.onOutput,
      signal: options.signal,
      stdio: options.stdio,
    });
    const packagesId = await imageId(docker, intermediate, options.signal);
    if (!packagesId) throw new Error("The package build produced no image");
    say(`Building profile ${entry.recipe.name} (no network) …\n`);
    await runDockerBuild(
      profileImageBuildArgs({
        context: join(root, "profile"),
        builderImage: builderId,
        packagesImage: packagesId,
        baseImage: baseId,
        baseContent,
        name: entry.recipe.name,
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
      throw new Error(`Profile ${entry.recipe.name}'s image is in use by a sandbox container (running or kept for recovery); stop or discard it first.`);
    throw error;
  }
}

/**
 * The service variant a profile session is opened with: `<name>@<first 16 hex
 * of the recipe digest>`. The manager resolves the name again at start and
 * refuses a recipe whose digest no longer matches what was consented to.
 */
export function profileVariant(entry: ProfileEntry): string {
  return `${entry.recipe.name}@${entry.digest.slice(0, 16)}`;
}
export function parseProfileVariant(variant: string): { name: string; digest: string } | undefined {
  const match = /^([a-z][a-z0-9-]{0,30}[a-z0-9])@([0-9a-f]{16})$/.exec(variant);
  return match && isProfileName(match[1]) ? { name: match[1]!, digest: match[2]! } : undefined;
}
