/**
 * Sandbox desktop **profiles**: a pre-built image per purpose (Blender, say),
 * built once from a strictly validated *recipe* and started fresh for every
 * session with exactly the base image's run-time hardening.
 *
 * A recipe is data, never code that Callboard runs as root or text that
 * reaches a Dockerfile:
 *
 * - {@link validateProfileRecipe} accepts only the fields below, each against
 *   a fixed grammar, and reports every problem with its path.
 * - {@link compileProfile} turns a valid recipe into two Docker build
 *   contexts. Their Dockerfiles are **constants**: the same bytes for every
 *   recipe ({@link PROFILE_PACKAGES_DOCKERFILE}, {@link PROFILE_DOCKERFILE}).
 *   The recipe reaches the build only as data files (a package list, a
 *   downloads table, an environment file, the setup script), read by
 *   Callboard's own scripts, so no recipe text can become a Dockerfile
 *   instruction — not through a newline, a heredoc, a `\` continuation or a
 *   parser directive.
 * - The only root step a recipe influences is *which* Debian packages are
 *   installed, from the builder's own Debian sources, in a build of its own.
 *   Downloads are fetched by the host and checked against their required
 *   SHA-256 before the build; they are unpacked, and the setup script runs,
 *   **as the unprivileged desktop user**, in a second build with no network.
 * - Callboard's epilogue runs last, as root: it purges package tooling,
 *   strips setuid/setgid bits and file capabilities, removes root-execution
 *   hooks, gives everything back to root, and restores the trusted files
 *   (entrypoint, driver host, tini, node, users) from the final base image,
 *   then verifies all of it and fails the build otherwise.
 *
 * See the package README, "Sandbox desktop profiles", for the threat model.
 */
import { createHash } from "node:crypto";
import { ComputerUseError } from "../contracts.js";

/** The recipe format's version: `"schema": 1`. */
export const PROFILE_RECIPE_SCHEMA = 1;
/**
 * The compiler's version, part of every recipe digest. The digest also covers
 * the compiler's constant output itself (the Dockerfiles, the scripts, the
 * epilogue), so any change to it shows every built profile as out of date
 * without anyone having to remember to bump this; bump it for a change in
 * meaning that leaves those bytes alone.
 */
export const PROFILE_COMPILER_VERSION = 1;
/**
 * The profile images' own security level (label {@link PROFILE_LABELS}.floor):
 * a host refuses a profile image below it, or without it, as it refuses a base
 * image below `SANDBOX_SECURITY_FLOOR`. Bump it only for a security fix in the
 * compiler or the epilogue that an existing profile image must not keep
 * running without; ordinary changes bump {@link PROFILE_COMPILER_VERSION}.
 */
export const PROFILE_SECURITY_FLOOR = 1;

/** The tag of the base image's builder stage (`docker build --target builder`), which still has apt. */
export const SANDBOX_BUILDER_IMAGE = "callboard/computer-use-desktop-builder:local";
/** Profile images are `<repository>:<name>`. */
export const PROFILE_IMAGE_REPOSITORY = "callboard/computer-use-profile";
/** The tag of a profile's first (package) build, removed once the profile is built. */
export const profilePackagesTag = (name: string) => `${PROFILE_IMAGE_REPOSITORY}:${assertName(name)}-packages`;
export const profileImageTag = (name: string) => `${PROFILE_IMAGE_REPOSITORY}:${assertName(name)}`;

/** Labels on a built profile image, set by the build (`docker build --label`), never by the recipe. */
export const PROFILE_LABELS = Object.freeze({
  name: "dev.callboard.computer-use.profile",
  /** {@link profileRecipeDigest} of the recipe it was built from. */
  recipe: "dev.callboard.computer-use.profile.recipe",
  /** The base's content digest (`sandboxContentDigest`) and image ID it was built against. */
  baseContent: "dev.callboard.computer-use.profile.base-content",
  baseImage: "dev.callboard.computer-use.profile.base-image",
  gl: "dev.callboard.computer-use.profile.gl",
  /** {@link PROFILE_SECURITY_FLOOR} at build time. */
  floor: "dev.callboard.computer-use.profile.security-floor",
});

export type ProfileGl = "none" | "software";
export type ProfileUnpack = "tar.gz" | "tar.xz" | "zip" | "file";

export interface ProfileDownload {
  /** `https://` only, a host name (not an IP literal or `localhost`), no credentials or fragment. */
  url: string;
  /** Required: the file's SHA-256, lowercase hex. A download that does not match fails the build. */
  sha256: string;
  /** Unpacked into `/opt/<dest>`. */
  dest: string;
  unpack: ProfileUnpack;
  /** `tar.*` only: leading path components to drop (0–8). */
  stripComponents?: number;
  /** `file` only: the name it is saved under in `/opt/<dest>`. */
  filename?: string;
  /** `file` only: mode 0755 instead of 0644. */
  executable?: boolean;
}

export interface ProfileLimits {
  /** CPUs, in steps of 0.01. */
  cpus?: number;
  /** Memory, MiB (no swap beyond it). */
  memoryMb?: number;
  /** The desktop user's tmpfs home (the outbox included), MiB. */
  homeMb?: number;
  /** How long a session on this profile lasts. */
  sessionMinutes?: number;
}

export interface ProfileRecipe {
  schema: 1;
  name: string;
  description: string;
  /** Debian package names, installed from the builder's Debian sources. */
  packages: string[];
  downloads: ProfileDownload[];
  /** A bash script run as the desktop user at build time, with no network (`set -euo pipefail`). Empty: none. */
  setup: string;
  /** Prepended to the desktop's PATH. */
  path: string[];
  /** Added to every desktop process's environment. */
  env: Record<string, string>;
  /** `software`: Mesa llvmpipe and a GLX-enabled Xvfb. `none` (the default): no GLX, as the base. */
  gl: ProfileGl;
  /** Requests; a host clamps each to its own caps. Omitted: the host's base-sandbox values. */
  limits: ProfileLimits;
}

/** What a recipe may ask for, before any host cap. */
export const PROFILE_LIMIT_BOUNDS = Object.freeze({
  cpus: { min: 0.5, max: 32 },
  memoryMb: { min: 512, max: 65536 },
  homeMb: { min: 256, max: 65536 },
  sessionMinutes: { min: 5, max: 480 },
});

/** Sizes the validator enforces. */
export const PROFILE_RECIPE_LIMITS = Object.freeze({
  /** The recipe as JSON text. */
  bytes: 64 * 1024,
  packages: 300,
  downloads: 8,
  setupBytes: 32 * 1024,
  path: 16,
  env: 32,
  envValue: 1024,
  description: 300,
});

/** A recipe that failed validation, with one line per problem: `path: what is wrong`. */
export class ProfileRecipeError extends ComputerUseError {
  constructor(readonly issues: readonly string[]) {
    super("invalid_request", `Invalid profile recipe: ${issues.join("; ")}`);
    this.name = "ProfileRecipeError";
  }
}

const NAME = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/;
/** Names that mean something else: "base" is the base image itself. */
const RESERVED_NAMES = new Set(["base", "default", "builder", "none", "local"]);
/** Debian policy §5.6.1, minus a trailing `+`/`-`/`.` (apt reads `pkg-` as "remove" and `pkg+` as "install"). */
const PACKAGE = /^[a-z0-9][a-z0-9+.-]{0,98}[a-z0-9]$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DEST = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** `/opt/computer-use` is the driver host; `/opt/profile` is where the setup script may write. */
const RESERVED_DESTS = new Set(["computer-use", "profile"]);
const FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PATH_ENTRY = /^\/(opt|usr)(\/[A-Za-z0-9._+-]+)+$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
/** Set by the entrypoint or the GL switch, or able to change how a shell or the loader behaves. */
const RESERVED_ENV = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "DISPLAY",
  "XAUTHORITY",
  "TMPDIR",
  "PWD",
  "OLDPWD",
  "IFS",
  "ENV",
  "BASH_ENV",
  "SHELLOPTS",
  "BASHOPTS",
  "PS4",
  "PROMPT_COMMAND",
  "GCONV_PATH",
  "NODE_OPTIONS",
  "GALLIUM_DRIVER",
]);
const RESERVED_ENV_PREFIXES = ["LD_", "COMPUTER_USE_", "CALLBOARD_", "LIBGL_", "MESA_", "LP_", "BASH_FUNC_"];
const RECIPE_KEYS = ["schema", "name", "description", "packages", "downloads", "setup", "path", "env", "gl", "limits"] as const;
const DOWNLOAD_KEYS = ["url", "sha256", "dest", "unpack", "stripComponents", "filename", "executable"] as const;
const LIMIT_KEYS = ["cpus", "memoryMb", "homeMb", "sessionMinutes"] as const;
const UNPACKS: readonly ProfileUnpack[] = ["tar.gz", "tar.xz", "zip", "file"];
/** C0 and C1 controls, DEL, and the Unicode line/paragraph separators and bidi overrides that make text read differently from what it is. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
/** The same, but a script may contain newlines and tabs. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const UNSAFE_SCRIPT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;

const quote = (value: unknown) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return JSON.stringify(text === undefined ? String(value) : text.length > 80 ? `${text.slice(0, 80)}…` : text);
};
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const utf8Bytes = (text: string) => Buffer.byteLength(text, "utf8");

function assertName(name: string): string {
  if (typeof name !== "string" || !NAME.test(name)) throw new ComputerUseError("invalid_request", `Invalid profile name ${quote(name)}`);
  return name;
}
/** Whether `name` could name a profile (the grammar, not whether one exists). */
export function isProfileName(name: unknown): name is string {
  return typeof name === "string" && NAME.test(name) && !RESERVED_NAMES.has(name);
}

/** Why a download URL is refused, or undefined. */
function urlProblem(value: string): string | undefined {
  if (value.length > 2048) return "is longer than 2048 characters";
  if (UNSAFE_TEXT.test(value) || /\s/.test(value)) return "contains whitespace or control characters";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "is not a URL";
  }
  if (url.protocol !== "https:") return "must be https://";
  if (url.username || url.password) return "must not carry credentials";
  if (url.hash || value.includes("#")) return "must not have a fragment";
  const host = url.hostname.toLowerCase();
  if (!host || /^[0-9.]+$/.test(host) || host.startsWith("[") || host.includes(":")) return "must name a host, not an IP address";
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || !host.includes("."))
    return "must name a public host (not localhost, .local, .internal or a bare name)";
  return undefined;
}

/**
 * Check a recipe and return it in canonical form: every field present, the
 * defaults filled in, `setup` as one string. Throws {@link ProfileRecipeError}
 * listing every problem (`packages[3]: …`). Nothing unknown is ignored: an
 * unexpected key is an error, so a typo never silently drops a hardening
 * the author thought they had.
 */
export function validateProfileRecipe(input: unknown): ProfileRecipe {
  const issues: string[] = [];
  const issue = (path: string, message: string) => {
    if (issues.length < 50) issues.push(`${path}: ${message}`);
  };
  if (!isObject(input)) throw new ProfileRecipeError(["recipe: must be a JSON object"]);
  for (const key of Object.keys(input))
    if (!(RECIPE_KEYS as readonly string[]).includes(key)) issue(key, `is not a recipe field (allowed: ${RECIPE_KEYS.join(", ")})`);

  if (input.schema !== PROFILE_RECIPE_SCHEMA) issue("schema", `must be ${PROFILE_RECIPE_SCHEMA}`);

  const name = input.name;
  if (typeof name !== "string" || !NAME.test(name))
    issue("name", `${quote(name)} must be 2–32 characters: lowercase letters, digits and "-", starting with a letter and not ending with "-"`);
  else if (RESERVED_NAMES.has(name)) issue("name", `${quote(name)} is reserved`);

  const description = input.description;
  if (typeof description !== "string" || !description.trim()) issue("description", "must be a non-empty string");
  else if (description.length > PROFILE_RECIPE_LIMITS.description) issue("description", `must be at most ${PROFILE_RECIPE_LIMITS.description} characters`);
  else if (UNSAFE_TEXT.test(description)) issue("description", "must be one line of plain text (no control, line-separator or bidi characters)");

  const packages: string[] = [];
  if (input.packages !== undefined) {
    if (!Array.isArray(input.packages)) issue("packages", "must be an array of Debian package names");
    else {
      if (input.packages.length > PROFILE_RECIPE_LIMITS.packages) issue("packages", `must list at most ${PROFILE_RECIPE_LIMITS.packages} packages`);
      input.packages.slice(0, PROFILE_RECIPE_LIMITS.packages).forEach((pkg, i) => {
        if (typeof pkg !== "string" || !PACKAGE.test(pkg))
          issue(
            `packages[${i}]`,
            `${quote(pkg)} is not a Debian package name (2–100 characters: lowercase letters, digits, "+", "-" and ".", starting and ending with a letter or digit; no versions, architectures, releases or paths)`,
          );
        else if (packages.includes(pkg)) issue(`packages[${i}]`, `${quote(pkg)} is listed twice`);
        else packages.push(pkg);
      });
    }
  }

  const downloads: ProfileDownload[] = [];
  if (input.downloads !== undefined) {
    if (!Array.isArray(input.downloads)) issue("downloads", "must be an array");
    else {
      if (input.downloads.length > PROFILE_RECIPE_LIMITS.downloads) issue("downloads", `must have at most ${PROFILE_RECIPE_LIMITS.downloads} entries`);
      input.downloads.slice(0, PROFILE_RECIPE_LIMITS.downloads).forEach((entry, i) => {
        const at = `downloads[${i}]`;
        if (!isObject(entry)) return issue(at, "must be an object with url, sha256, dest and unpack");
        for (const key of Object.keys(entry))
          if (!(DOWNLOAD_KEYS as readonly string[]).includes(key)) issue(`${at}.${key}`, `is not a download field (allowed: ${DOWNLOAD_KEYS.join(", ")})`);
        const out: Partial<ProfileDownload> = {};
        if (typeof entry.url !== "string") issue(`${at}.url`, "is required");
        else {
          const problem = urlProblem(entry.url);
          if (problem) issue(`${at}.url`, `${quote(entry.url)} ${problem}`);
          else out.url = entry.url;
        }
        if (typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256)) issue(`${at}.sha256`, "is required: the file's SHA-256 as 64 lowercase hex digits");
        else out.sha256 = entry.sha256;
        if (typeof entry.dest !== "string" || !DEST.test(entry.dest))
          issue(
            `${at}.dest`,
            `${quote(entry.dest)} must be a directory name under /opt (1–64 characters: lowercase letters, digits, ".", "_" and "-", not starting with "." "_" or "-")`,
          );
        else if (RESERVED_DESTS.has(entry.dest)) issue(`${at}.dest`, `/opt/${entry.dest} is reserved`);
        else if (downloads.some((d) => d.dest === entry.dest)) issue(`${at}.dest`, `/opt/${entry.dest} is used by an earlier download`);
        else out.dest = entry.dest;
        if (!UNPACKS.includes(entry.unpack as ProfileUnpack)) issue(`${at}.unpack`, `must be one of ${UNPACKS.join(", ")}`);
        else out.unpack = entry.unpack as ProfileUnpack;
        const tar = out.unpack === "tar.gz" || out.unpack === "tar.xz";
        if (entry.stripComponents !== undefined) {
          if (!tar) issue(`${at}.stripComponents`, "applies only to tar.gz and tar.xz");
          else if (!Number.isInteger(entry.stripComponents) || (entry.stripComponents as number) < 0 || (entry.stripComponents as number) > 8)
            issue(`${at}.stripComponents`, "must be a whole number from 0 to 8");
          else out.stripComponents = entry.stripComponents as number;
        }
        if (out.unpack === "file") {
          if (typeof entry.filename !== "string" || !FILENAME.test(entry.filename))
            issue(
              `${at}.filename`,
              `${entry.filename === undefined ? 'is required for unpack "file"' : `${quote(entry.filename)} must be`}: a plain file name (letters, digits, ".", "_" and "-")`,
            );
          else out.filename = entry.filename;
          if (entry.executable !== undefined && typeof entry.executable !== "boolean") issue(`${at}.executable`, "must be true or false");
          else if (entry.executable === true) out.executable = true;
        } else {
          if (entry.filename !== undefined) issue(`${at}.filename`, 'applies only to unpack "file"');
          if (entry.executable !== undefined) issue(`${at}.executable`, 'applies only to unpack "file"');
        }
        if (out.url && out.sha256 && out.dest && out.unpack) downloads.push(out as ProfileDownload);
      });
    }
  }

  let setup = "";
  if (input.setup !== undefined) {
    const lines = Array.isArray(input.setup) ? input.setup : undefined;
    if (lines && lines.some((line) => typeof line !== "string" || line.includes("\n")))
      issue("setup", "as an array, must hold one string per line, none containing a newline");
    else if (!lines && typeof input.setup !== "string") issue("setup", "must be a string, or an array of lines");
    else {
      const text = lines ? (lines as string[]).join("\n") : (input.setup as string);
      if (utf8Bytes(text) > PROFILE_RECIPE_LIMITS.setupBytes) issue("setup", `must be at most ${PROFILE_RECIPE_LIMITS.setupBytes} bytes`);
      else if (UNSAFE_SCRIPT.test(text))
        issue("setup", "must not contain control characters other than newline and tab (no carriage returns, NULs, line separators or bidi overrides)");
      else setup = text.trim() ? `${text.replace(/\s+$/, "")}\n` : "";
    }
  }

  const path: string[] = [];
  if (input.path !== undefined) {
    if (!Array.isArray(input.path)) issue("path", "must be an array of directories");
    else {
      if (input.path.length > PROFILE_RECIPE_LIMITS.path) issue("path", `must list at most ${PROFILE_RECIPE_LIMITS.path} directories`);
      input.path.slice(0, PROFILE_RECIPE_LIMITS.path).forEach((entry, i) => {
        if (typeof entry !== "string" || !PATH_ENTRY.test(entry) || entry.split("/").some((part) => part === "." || part === ".."))
          issue(
            `path[${i}]`,
            `${quote(entry)} must be an absolute directory under /opt or /usr (letters, digits, ".", "_", "+" and "-"; no "." or ".." segments)`,
          );
        else if (path.includes(entry)) issue(`path[${i}]`, `${quote(entry)} is listed twice`);
        else path.push(entry);
      });
    }
  }

  const env: Record<string, string> = {};
  if (input.env !== undefined) {
    if (!isObject(input.env)) issue("env", "must be an object of NAME: value");
    else {
      const entries = Object.entries(input.env);
      if (entries.length > PROFILE_RECIPE_LIMITS.env) issue("env", `must have at most ${PROFILE_RECIPE_LIMITS.env} variables`);
      for (const [key, value] of entries.slice(0, PROFILE_RECIPE_LIMITS.env)) {
        if (!ENV_NAME.test(key)) issue(`env.${key}`, "is not a variable name (uppercase letters, digits and _, not starting with a digit)");
        else if (RESERVED_ENV.has(key) || RESERVED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)))
          issue(`env.${key}`, `is reserved (set by Callboard; use "path" for PATH)`);
        else if (typeof value !== "string") issue(`env.${key}`, "must be a string");
        else if (value.length > PROFILE_RECIPE_LIMITS.envValue) issue(`env.${key}`, `must be at most ${PROFILE_RECIPE_LIMITS.envValue} characters`);
        else if (UNSAFE_TEXT.test(value)) issue(`env.${key}`, "must be one line without control characters");
        else env[key] = value;
      }
    }
  }

  let gl: ProfileGl = "none";
  if (input.gl !== undefined) {
    if (input.gl !== "none" && input.gl !== "software") issue("gl", 'must be "none" or "software"');
    else gl = input.gl;
  }

  const limits: ProfileLimits = {};
  if (input.limits !== undefined) {
    if (!isObject(input.limits)) issue("limits", "must be an object");
    else {
      for (const key of Object.keys(input.limits))
        if (!(LIMIT_KEYS as readonly string[]).includes(key)) issue(`limits.${key}`, `is not a limit (allowed: ${LIMIT_KEYS.join(", ")})`);
      for (const key of LIMIT_KEYS) {
        const value = input.limits[key];
        if (value === undefined) continue;
        const { min, max } = PROFILE_LIMIT_BOUNDS[key];
        const integer = key !== "cpus";
        const ok =
          typeof value === "number" &&
          Number.isFinite(value) &&
          value >= min &&
          value <= max &&
          (integer ? Number.isInteger(value) : Math.round(value * 100) === value * 100);
        if (!ok) issue(`limits.${key}`, `must be ${integer ? "a whole number" : "a number in steps of 0.01"} from ${min} to ${max}`);
        else limits[key] = value as number;
      }
    }
  }

  if (issues.length) throw new ProfileRecipeError(issues);
  return {
    schema: 1,
    name: name as string,
    description: (description as string).trim(),
    packages,
    downloads,
    setup,
    path,
    env: Object.fromEntries(Object.entries(env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    gl,
    limits,
  };
}

/** Parse recipe JSON text (at most {@link PROFILE_RECIPE_LIMITS}.bytes) and validate it. */
export function parseProfileRecipe(text: string): ProfileRecipe {
  if (typeof text !== "string") throw new ProfileRecipeError(["recipe: must be JSON text"]);
  if (utf8Bytes(text) > PROFILE_RECIPE_LIMITS.bytes) throw new ProfileRecipeError([`recipe: must be at most ${PROFILE_RECIPE_LIMITS.bytes} bytes`]);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ProfileRecipeError([`recipe: is not valid JSON (${error instanceof Error ? error.message : "parse error"})`]);
  }
  return validateProfileRecipe(value);
}

/**
 * The canonical JSON of a validated recipe: fixed key order, defaults filled
 * in. What is hashed, what is built, and what a human reviewing a recipe
 * should be shown (a raw JSON text may repeat a key; this cannot).
 */
export function canonicalProfileRecipe(recipe: ProfileRecipe): string {
  const r = validateProfileRecipe(recipe);
  return JSON.stringify(
    {
      schema: r.schema,
      name: r.name,
      description: r.description,
      packages: r.packages,
      downloads: r.downloads.map((d) => ({
        url: d.url,
        sha256: d.sha256,
        dest: d.dest,
        unpack: d.unpack,
        ...(d.stripComponents !== undefined ? { stripComponents: d.stripComponents } : {}),
        ...(d.filename !== undefined ? { filename: d.filename } : {}),
        ...(d.executable ? { executable: true } : {}),
      })),
      setup: r.setup,
      path: r.path,
      env: r.env,
      gl: r.gl,
      limits: Object.fromEntries(LIMIT_KEYS.filter((key) => r.limits[key] !== undefined).map((key) => [key, r.limits[key]])),
    },
    null,
    2,
  );
}

/**
 * A SHA-256 over the compiler (its version and every constant it emits:
 * Dockerfiles, scripts, the GL package list) and the canonical recipe: it
 * changes when the recipe changes or when what Callboard compiles it to does.
 */
export function profileRecipeDigest(recipe: ProfileRecipe): string {
  const hash = createHash("sha256").update(`callboard-sandbox-profile\0compiler=${PROFILE_COMPILER_VERSION}\0`);
  for (const part of compilerSources()) hash.update(part).update("\0");
  return hash.update(canonicalProfileRecipe(recipe)).digest("hex");
}

// ── The build ───────────────────────────────────────────────────────────

/**
 * The first build: the recipe's Debian packages, as root, with the network,
 * from the builder's own sources. Its context holds this file, the package
 * list and the install script, nothing else.
 */
export const PROFILE_PACKAGES_DOCKERFILE = `# Generated by Callboard's sandbox profile compiler (v${PROFILE_COMPILER_VERSION}).
# The same bytes for every recipe: the recipe reaches this build only as
# packages.txt, read by install-packages.sh.
ARG CALLBOARD_BUILDER
FROM \${CALLBOARD_BUILDER}
USER root
COPY packages.txt /callboard-recipe/packages.txt
COPY install-packages.sh /callboard-build/install-packages.sh
RUN ["/bin/sh", "-eu", "/callboard-build/install-packages.sh"]
`;

/** The marker before which every recipe-influenced step ends; everything after it is Callboard's. */
export const PROFILE_EPILOGUE_MARKER = "# ---- Callboard epilogue: Callboard's own steps, always last. ----";

/**
 * The second build, with `--network=none`: unpack the verified downloads and
 * run the setup script as the desktop user, then the epilogue as root.
 */
export const PROFILE_DOCKERFILE = `# Generated by Callboard's sandbox profile compiler (v${PROFILE_COMPILER_VERSION}).
# The same bytes for every recipe: the recipe reaches this build only as the
# data files under recipe/ and the verified files under downloads/. Built with
# --network=none.
ARG CALLBOARD_BUILDER
ARG CALLBOARD_PACKAGES
ARG CALLBOARD_BASE
FROM \${CALLBOARD_BASE} AS trusted

# Downloads, unpacked as the desktop user in a stage of their own, so the
# archives never reach the profile image.
FROM \${CALLBOARD_BUILDER} AS fetch
USER root
COPY recipe/downloads.tsv /callboard-recipe/downloads.tsv
COPY downloads/ /callboard-downloads/
COPY callboard/unpack.sh /callboard-build/unpack.sh
RUN ["/bin/sh", "-eu", "/callboard-build/unpack.sh", "prepare"]
USER desktop
RUN ["/bin/sh", "-eu", "/callboard-build/unpack.sh", "unpack"]

FROM \${CALLBOARD_PACKAGES}
ARG CALLBOARD_GL
USER root
COPY --from=fetch --chown=10001:10001 /callboard-opt/ /opt/
COPY recipe/ /callboard-recipe/
COPY callboard/run-setup.sh /callboard-build/run-setup.sh
RUN ["/bin/sh", "-eu", "/callboard-build/run-setup.sh", "prepare"]
USER desktop
RUN ["/bin/sh", "-eu", "/callboard-build/run-setup.sh", "run"]
${PROFILE_EPILOGUE_MARKER}
USER root
COPY callboard/harden.sh /callboard-epilogue/harden.sh
RUN ["/bin/sh", "-eu", "/callboard-epilogue/harden.sh"]
COPY --from=trusted /etc/passwd /etc/group /etc/shadow /etc/gshadow /etc/nsswitch.conf /etc/
COPY --from=trusted /usr/local/bin/start-desktop.sh /usr/local/bin/start-desktop.sh
COPY --from=trusted /usr/local/lib/computer-use/ /usr/local/lib/computer-use/
COPY --from=trusted /opt/computer-use/ /opt/computer-use/
COPY --from=trusted /usr/bin/tini /usr/bin/tini
COPY --from=trusted /usr/local/bin/node /usr/local/bin/node
COPY recipe/profile.env /etc/computer-use/profile.env
COPY callboard/verify.sh /callboard-epilogue/verify.sh
RUN ["/bin/sh", "-eu", "/callboard-epilogue/verify.sh"]
ENV COMPUTER_USE_GL=\${CALLBOARD_GL}
WORKDIR /
USER root
ENTRYPOINT ["/usr/local/bin/start-desktop.sh"]
CMD []
`;

/** The one root step a recipe influences: which Debian packages. */
const INSTALL_PACKAGES_SH = `#!/bin/sh
# Callboard: install a profile's Debian packages. Root, with the network, in
# the builder, from its own Debian sources (the recipe cannot add any). Every
# line was validated by the compiler and is checked again here.
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
list=/callboard-recipe/packages.txt
if grep -nvxE '[a-z0-9][a-z0-9+.-]*[a-z0-9]' "$list" >&2; then
  echo "install-packages: the lines above are not package names" >&2
  exit 1
fi
if [ -s "$list" ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  # --no-remove: a package that would take another away (xvfb, tini, ...) fails the build.
  xargs apt-get install -y --no-install-recommends --no-remove < "$list"
fi
rm -rf /var/lib/apt/lists/* /callboard-recipe /callboard-build
`;

const UNPACK_SH = `#!/bin/sh
# Callboard: unpack a profile's downloads, already checked against their
# SHA-256 by the host. \`prepare\` runs as root and only creates the
# desktop-owned destinations; \`unpack\` runs as the desktop user, so an archive
# can write nowhere but those. Every row was validated by the compiler and is
# checked again here.
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
tsv=/callboard-recipe/downloads.tsv
row_ok() {
  case "$1" in '' | *[!0-9]*) return 1 ;; esac
  case "$2" in '' | [._-]* | *[!a-z0-9._-]* | computer-use | profile) return 1 ;; esac
  case "$3" in tar.gz | tar.xz | zip | file) ;; *) return 1 ;; esac
  case "$4" in [0-8]) ;; *) return 1 ;; esac
  case "$5" in - | [A-Za-z0-9]*) ;; *) return 1 ;; esac
  case "$5" in *[!A-Za-z0-9._-]*) return 1 ;; esac
  case "$6" in 0 | 1) ;; *) return 1 ;; esac
}
tab="$(printf '\\t')"
if [ "$1" = prepare ]; then
  install -d -m 0755 -o 10001 -g 10001 /callboard-opt
  # The host's copies may be private (0600); the desktop user only needs to read them.
  chown -R 0:0 /callboard-downloads
  chmod -R a+rX,go-w /callboard-downloads
  while IFS="$tab" read -r index dest unpack strip filename executable; do
    row_ok "$index" "$dest" "$unpack" "$strip" "$filename" "$executable" || { echo "unpack: invalid row" >&2; exit 1; }
    install -d -m 0755 -o 10001 -g 10001 "/callboard-opt/$dest"
  done < "$tsv"
  exit 0
fi
[ "$(id -u)" = 10001 ] || { echo "unpack: must run as the desktop user" >&2; exit 1; }
umask 022
while IFS="$tab" read -r index dest unpack strip filename executable; do
  row_ok "$index" "$dest" "$unpack" "$strip" "$filename" "$executable" || { echo "unpack: invalid row" >&2; exit 1; }
  src="/callboard-downloads/$index"
  out="/callboard-opt/$dest"
  case "$unpack" in
    tar.gz) tar -xzf "$src" -C "$out" --no-same-owner --no-same-permissions --strip-components="$strip" ;;
    tar.xz) tar -xJf "$src" -C "$out" --no-same-owner --no-same-permissions --strip-components="$strip" ;;
    zip) unzip -q "$src" -d "$out" ;;
    file)
      cp "$src" "$out/$filename"
      if [ "$executable" = 1 ]; then chmod 0755 "$out/$filename"; else chmod 0644 "$out/$filename"; fi
      ;;
  esac
  echo "unpack: /opt/$dest ($unpack)"
done < "$tsv"
`;

const RUN_SETUP_SH = `#!/bin/sh
# Callboard: run a profile's setup script. \`prepare\` (root) creates
# /opt/profile for it; \`run\` runs it as the desktop user in a clean
# environment, with the profile's PATH and variables. This build has no
# network: whatever setup needs comes from the packages and the verified
# downloads.
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
if [ "$1" = prepare ]; then
  install -d -m 0755 -o 10001 -g 10001 /opt/profile
  exit 0
fi
[ "$(id -u)" = 10001 ] || { echo "run-setup: must run as the desktop user" >&2; exit 1; }
[ -s /callboard-recipe/setup.sh ] || { echo "run-setup: no setup script"; exit 0; }
cd /home/desktop
exec /usr/bin/env -i HOME=/home/desktop USER=desktop LOGNAME=desktop SHELL=/bin/bash LANG=C.UTF-8 PATH=/usr/local/bin:/usr/bin:/bin \\
  /bin/sh /usr/local/lib/computer-use/profile-env /callboard-recipe/profile.env \\
  /bin/bash -euo pipefail /callboard-recipe/setup.sh
`;

/** The base image's purge list (docker/Dockerfile); the GL part is kept for \`gl: "software"\`. */
const BASE_PURGE_GL = "libgl1-mesa-dri libllvm15 libz3-4";
const BASE_PURGE_OTHER = "cpp cpp-12 libspectre1 libgs10 libgs10-common fonts-urw-base35 poppler-data";

const HARDEN_SH = `#!/bin/sh
# Callboard's hardening epilogue, part 1: root, no network, after every
# recipe step. Nothing the recipe wrote is trusted from here on: package
# tooling goes, setuid/setgid bits and file capabilities go, root-execution
# hooks go, everything a user owned goes back to root, and the files
# restored from the base image next are removed first, so the restore
# replaces them rather than merging into them.
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
gl="\${CALLBOARD_GL:-}"
case "$gl" in none | software) ;; *) echo "harden: CALLBOARD_GL must be none or software" >&2; exit 1 ;; esac

# 1. What the base image purges, unless an installed package still needs it.
purge="${BASE_PURGE_GL} ${BASE_PURGE_OTHER}"
[ "$gl" = software ] && purge="${BASE_PURGE_OTHER}"
needed_by() {
  dpkg-query -W -f='\${db:Status-Abbrev}|\${Package}|\${Pre-Depends}, \${Depends}\\n' | awk -F'|' -v p="$1" -v skip=" $purge " '
    $1 ~ /^ii/ && index(skip, " " $2 " ") == 0 {
      n = split($3, deps, /[,|]/)
      for (i = 1; i <= n; i++) { d = deps[i]; sub(/\\(.*/, "", d); gsub(/[ \\t]/, "", d); sub(/:.*/, "", d); if (d == p) { print $2; exit } }
    }'
}
for p in $purge; do
  dpkg-query -W -f='\${db:Status-Abbrev}' "$p" 2>/dev/null | grep -q '^ii' || continue
  users="$(needed_by "$p")"
  if [ -n "$users" ]; then echo "harden: keeping $p (needed by $users)"; continue; fi
  dpkg --purge --force-depends "$p" >/dev/null
done

# 2. Package tooling: nothing is installed after this, at build time or run time.
rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
rm -rf /var/lib/apt /var/cache/apt /etc/apt /usr/lib/apt /usr/lib/dpkg /etc/dpkg
rm -f /usr/bin/apt /usr/bin/apt-* /usr/bin/dpkg /usr/bin/dpkg-* /usr/sbin/dpkg-* /usr/bin/debconf-apt-progress

# 3. Root-execution hooks a package could have left.
rm -f /etc/ld.so.preload

# 4. Build leftovers, the desktop user's build-time home (a tmpfs at run
#    time) and the trusted files the next steps restore.
rm -rf /callboard-recipe /callboard-build /home/desktop /var/tmp/* /etc/computer-use
find /tmp -mindepth 1 -maxdepth 1 -exec rm -rf {} +
install -d -m 0755 -o 10001 -g 10001 /home/desktop
install -d -m 1777 /tmp/.X11-unix
rm -rf /usr/local/bin/start-desktop.sh /usr/local/lib/computer-use /opt/computer-use /usr/bin/tini /usr/local/bin/node

# 5. Ownership: everything not root's goes to root, except the two places the
#    image gives users on purpose (the desktop's home, the token's directory).
find / -xdev \\( -path /home/desktop -o -path /run/computer-use -o -path /proc -o -path /sys \\) -prune \\
  -o \\( ! -user 0 -o -group 10001 -o -group 10002 \\) -print0 | xargs -0r chown -h 0:0
find / -xdev \\( -path /tmp -o -path /var/tmp -o -path /run/lock -o -path /dev -o -path /proc -o -path /sys \\) -prune \\
  -o ! -type l -perm -0002 -print0 | xargs -0r chmod o-w

# 6. No setuid/setgid program and no file capability. no-new-privileges and
#    --cap-drop=ALL already make them inert; without them there is nothing to make inert.
find / -xdev -type f -perm /6000 -exec chmod ug-s {} +
find / -xdev -type f -print0 | xargs -0r getcap 2>/dev/null | while read -r file caps; do setcap -r "$file"; done

ldconfig
echo "harden: done (gl=$gl)"
`;

const VERIFY_SH = `#!/bin/sh
# Callboard's hardening epilogue, part 2: root, after the trusted files and
# users were restored from the base image. Checks the invariants the run-time
# hardening relies on, and fails the build if any does not hold.
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
fail() { echo "verify: $*" >&2; exit 1; }
gl="\${CALLBOARD_GL:-}"
case "$gl" in none | software) ;; *) fail "CALLBOARD_GL must be none or software" ;; esac
[ "$(id -u desktop)" = 10001 ] && [ "$(id -g desktop)" = 10001 ] || fail "the desktop user is not 10001:10001"
[ "$(id -u driver)" = 10002 ] && [ "$(id -g driver)" = 10002 ] || fail "the driver user is not 10002:10002"
[ "$(awk -F: '$3 == 0 { print $1 }' /etc/passwd)" = root ] || fail "an account other than root has uid 0"
[ ! -e /etc/ld.so.preload ] || fail "/etc/ld.so.preload exists"
for tool in apt apt-get apt-cache dpkg dpkg-deb npm npx corepack; do
  if command -v "$tool" >/dev/null 2>&1; then fail "$tool is still installed"; fi
done
[ -z "$(find / -xdev -type f -perm /6000 -print -quit)" ] || fail "a setuid or setgid file remains"
[ -z "$(find / -xdev -type f -print0 | xargs -0r getcap 2>/dev/null)" ] || fail "a file capability remains"
[ -z "$(find / -xdev \\( -path /home/desktop -o -path /run/computer-use -o -path /proc -o -path /sys \\) -prune -o \\( ! -user 0 -o -group 10001 -o -group 10002 \\) -print -quit)" ] ||
  fail "a file outside /home/desktop is not owned by root"
[ "$(stat -c '%u:%g %a' /run/computer-use)" = "0:10002 750" ] || fail "/run/computer-use is not root:driver 0750"
[ "$(stat -c '%u:%g %a' /home/desktop)" = "10001:10001 755" ] || fail "/home/desktop is not desktop's, 0755"
for file in /usr/local/bin/start-desktop.sh /usr/bin/tini /usr/local/bin/node /usr/local/lib/computer-use/profile-env /usr/bin/xdotool /usr/bin/import /usr/bin/setpriv; do
  [ -x "$file" ] || fail "$file is missing"
  [ "$(stat -c '%u' "$file")" = 0 ] || fail "$file is not root's"
done
[ -f /opt/computer-use/dist/driver-host-cli.js ] || fail "the driver host is missing"
if [ "$gl" = software ]; then
  [ -n "$(find /usr/lib -name swrast_dri.so -print -quit)" ] || fail "gl software needs Mesa's swrast driver (libgl1-mesa-dri)"
fi
rm -rf /callboard-epilogue
echo "verify: ok (gl=$gl)"
`;

/** The packages \`gl: "software"\` adds: Mesa's llvmpipe (swrast) and its GLX/EGL front ends. */
export const PROFILE_SOFTWARE_GL_PACKAGES: readonly string[] = Object.freeze(["libgl1", "libgl1-mesa-dri", "libglx-mesa0", "libegl1", "libegl-mesa0"]);

/** Everything the compiler emits that is the same for every recipe: part of the recipe digest. */
function compilerSources(): string[] {
  return [
    PROFILE_PACKAGES_DOCKERFILE,
    PROFILE_DOCKERFILE,
    INSTALL_PACKAGES_SH,
    UNPACK_SH,
    RUN_SETUP_SH,
    HARDEN_SH,
    VERIFY_SH,
    PROFILE_SOFTWARE_GL_PACKAGES.join(" "),
  ];
}

export interface CompiledProfile {
  name: string;
  digest: string;
  gl: ProfileGl;
  /** The first build's context: file path → content. */
  packagesContext: Readonly<Record<string, string>>;
  /**
   * The second build's context, without `downloads/`: the host puts each
   * verified download at `downloads/<index>` (see {@link downloads}).
   */
  profileContext: Readonly<Record<string, string>>;
  downloads: readonly { index: number; url: string; sha256: string }[];
}

/** One line per variable: `NAME=value`, read by the desktop user's profile-env (never sourced by a shell). */
function profileEnvFile(recipe: ProfileRecipe): string {
  const lines = ["# Generated by Callboard from the profile recipe. Read line by line by profile-env, as the desktop user."];
  if (recipe.path.length) lines.push(`PATH=${[...recipe.path, "/usr/local/bin", "/usr/bin", "/bin"].join(":")}`);
  for (const [key, value] of Object.entries(recipe.env)) lines.push(`${key}=${value}`);
  return `${lines.join("\n")}\n`;
}

/**
 * Compile a recipe into its two build contexts. Validates first (a recipe
 * object is never trusted to be canonical). The Dockerfiles are constants;
 * every recipe-derived byte is in a data file.
 */
export function compileProfile(input: ProfileRecipe): CompiledProfile {
  const recipe = validateProfileRecipe(input);
  const packages = [...recipe.packages, ...(recipe.gl === "software" ? PROFILE_SOFTWARE_GL_PACKAGES.filter((p) => !recipe.packages.includes(p)) : [])];
  const downloads = recipe.downloads.map((d, index) => ({ index, url: d.url, sha256: d.sha256 }));
  const tsv = recipe.downloads
    .map((d, index) => [index, d.dest, d.unpack, d.stripComponents ?? 0, d.filename ?? "-", d.executable ? 1 : 0].join("\t"))
    .join("\n");
  return {
    name: recipe.name,
    digest: profileRecipeDigest(recipe),
    gl: recipe.gl,
    packagesContext: {
      Dockerfile: PROFILE_PACKAGES_DOCKERFILE,
      "packages.txt": packages.length ? `${packages.join("\n")}\n` : "",
      "install-packages.sh": INSTALL_PACKAGES_SH,
    },
    profileContext: {
      Dockerfile: PROFILE_DOCKERFILE,
      "recipe/recipe.json": `${canonicalProfileRecipe(recipe)}\n`,
      "recipe/downloads.tsv": tsv ? `${tsv}\n` : "",
      "recipe/setup.sh": recipe.setup,
      "recipe/profile.env": profileEnvFile(recipe),
      "callboard/unpack.sh": UNPACK_SH,
      "callboard/run-setup.sh": RUN_SETUP_SH,
      "callboard/harden.sh": HARDEN_SH,
      "callboard/verify.sh": VERIFY_SH,
      "downloads/.keep": "",
    },
    downloads,
  };
}

const IMAGE_REF = /^(sha256:[0-9a-f]{64}|[a-z0-9][a-z0-9._/-]{0,127}(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?)$/;
const LABEL_VALUE = /^[A-Za-z0-9_.:@/-]{1,128}$/;
const checkRef = (what: string, ref: string) => {
  if (typeof ref !== "string" || !IMAGE_REF.test(ref)) throw new ComputerUseError("invalid_request", `Invalid ${what} image reference`);
  return ref;
};

/** `docker build` arguments (after `docker`) for a profile's first build: its packages, with the network. */
export function profilePackagesBuildArgs(options: { context: string; builderImage: string; tag: string }): string[] {
  return [
    "build",
    "--force-rm",
    "--build-arg",
    `CALLBOARD_BUILDER=${checkRef("builder", options.builderImage)}`,
    "-t",
    checkRef("tag", options.tag),
    options.context,
  ];
}

/**
 * `docker build` arguments for a profile's second build: no network, the
 * Callboard-controlled GL switch as a build argument, and the labels a host
 * checks (name, recipe digest, base content and image, GL, security floor).
 */
export function profileImageBuildArgs(options: {
  context: string;
  builderImage: string;
  packagesImage: string;
  baseImage: string;
  baseContent: string;
  name: string;
  digest: string;
  gl: ProfileGl;
  tag: string;
}): string[] {
  if (options.gl !== "none" && options.gl !== "software") throw new ComputerUseError("invalid_request", "Invalid GL mode");
  for (const value of [options.baseContent, options.digest, options.baseImage])
    if (!LABEL_VALUE.test(value)) throw new ComputerUseError("invalid_request", "Invalid profile label value");
  return [
    "build",
    "--force-rm",
    "--network=none",
    "--build-arg",
    `CALLBOARD_BUILDER=${checkRef("builder", options.builderImage)}`,
    "--build-arg",
    `CALLBOARD_PACKAGES=${checkRef("packages", options.packagesImage)}`,
    "--build-arg",
    `CALLBOARD_BASE=${checkRef("base", options.baseImage)}`,
    "--build-arg",
    `CALLBOARD_GL=${options.gl}`,
    "--label",
    `${PROFILE_LABELS.name}=${assertName(options.name)}`,
    "--label",
    `${PROFILE_LABELS.recipe}=${options.digest}`,
    "--label",
    `${PROFILE_LABELS.baseContent}=${options.baseContent}`,
    "--label",
    `${PROFILE_LABELS.baseImage}=${options.baseImage}`,
    "--label",
    `${PROFILE_LABELS.gl}=${options.gl}`,
    "--label",
    `${PROFILE_LABELS.floor}=${PROFILE_SECURITY_FLOOR}`,
    "-t",
    checkRef("tag", options.tag),
    options.context,
  ];
}

/** Effective limits: the recipe's request, else the host's default, each clamped to the host's cap. */
export interface ClampedProfileLimits {
  cpus: number;
  memoryMb: number;
  homeMb: number;
  sessionMinutes: number;
}
export function clampProfileLimits(
  requested: ProfileLimits,
  defaults: ClampedProfileLimits,
  caps: ClampedProfileLimits,
): ClampedProfileLimits & { clamped: (keyof ClampedProfileLimits)[] } {
  const clamped: (keyof ClampedProfileLimits)[] = [];
  const pick = (key: keyof ClampedProfileLimits) => {
    const want = requested[key] ?? defaults[key];
    if (want > caps[key]) {
      clamped.push(key);
      return caps[key];
    }
    return want;
  };
  return { cpus: pick("cpus"), memoryMb: pick("memoryMb"), homeMb: pick("homeMb"), sessionMinutes: pick("sessionMinutes"), clamped };
}
