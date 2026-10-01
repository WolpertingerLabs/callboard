/**
 * Artifact service — named, versioned, reusable HTML apps / SVGs / markdown
 * documents, catalogued by a stable slug id.
 *
 *   DATA_DIR/artifacts/<id>/meta.json          ArtifactMetaFile
 *   DATA_DIR/artifacts/<id>/versions/<n>.<ext> immutable source of version n
 *
 * Every save appends a new immutable version; the last
 * {@link ARTIFACT_MAX_VERSIONS} are kept and older ones pruned. The id is
 * validated here (the chokepoint), version numbers are integers the service
 * mints, so no caller-controlled string ever reaches a path unvalidated.
 * Writes are atomic and each artifact's mutations run on its own chain — the
 * same machinery as the storage service.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from "fs";
import path from "path";
import { ARTIFACT_CONTENT_TYPES, ARTIFACT_ID_PATTERN, ARTIFACT_MAX_SOURCE_BYTES, ARTIFACT_MAX_VERSIONS, ARTIFACT_STORAGE_ACCESS } from "shared/types/index.js";
import type {
  Artifact,
  ArtifactContentType,
  ArtifactMetaFile,
  ArtifactStorageAccess,
  ArtifactSummary,
  ArtifactVersion,
  UpdateArtifactInput,
} from "shared/types/index.js";
import { DATA_DIR } from "../utils/paths.js";
import { StorageError, atomicWriteFileSync, resolveSourcePath, serialize } from "./storage-service.js";

export { ARTIFACT_MAX_SOURCE_BYTES, ARTIFACT_MAX_VERSIONS };

export const ARTIFACTS_ROOT = path.join(DATA_DIR, "artifacts");

const ARTIFACT_MAX_NAME = 200;
const ARTIFACT_MAX_DESCRIPTION = 4000;
const ARTIFACT_MAX_NOTE = 1000;

const EXT: Record<ArtifactContentType, string> = { html: ".html", svg: ".svg", markdown: ".md" };

// ── Validation ───────────────────────────────────────────────────────

export function assertArtifactId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !ARTIFACT_ID_PATTERN.test(id)) {
    throw new StorageError(
      "invalid",
      `Invalid artifact id ${typeof id === "string" ? JSON.stringify(id.slice(0, 80)) : typeof id}: must match ${ARTIFACT_ID_PATTERN.source}`,
    );
  }
}

function assertContentType(value: unknown): asserts value is ArtifactContentType {
  if (!(ARTIFACT_CONTENT_TYPES as readonly unknown[]).includes(value)) {
    throw new StorageError("invalid", `content_type must be one of ${ARTIFACT_CONTENT_TYPES.join(", ")}`);
  }
}

function assertStorageAccess(value: unknown): asserts value is ArtifactStorageAccess {
  if (!(ARTIFACT_STORAGE_ACCESS as readonly unknown[]).includes(value)) {
    throw new StorageError("invalid", `storage_access must be one of ${ARTIFACT_STORAGE_ACCESS.join(", ")}`);
  }
}

function text(field: string, value: unknown, max: number, required = false): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new StorageError("invalid", `${field} is required`);
    return undefined;
  }
  if (typeof value !== "string") throw new StorageError("invalid", `${field} must be a string`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new StorageError("invalid", `${field} must not be empty`);
  if (trimmed.length > max) throw new StorageError("invalid", `${field} too long (max ${max} characters)`);
  return trimmed || undefined;
}

function assertSource(content: unknown): asserts content is string {
  if (typeof content !== "string") throw new StorageError("invalid", "content must be a string");
  const bytes = Buffer.byteLength(content, "utf-8");
  if (bytes > ARTIFACT_MAX_SOURCE_BYTES) {
    throw new StorageError(
      "limit",
      `Artifact source too large (${(bytes / 1024 / 1024).toFixed(1)}MB); the limit is ${ARTIFACT_MAX_SOURCE_BYTES / 1024 / 1024}MB`,
    );
  }
}

// ── Paths & meta ─────────────────────────────────────────────────────

const artifactDir = (id: string) => path.join(ARTIFACTS_ROOT, id);
const metaPath = (id: string) => path.join(artifactDir(id), "meta.json");
const versionsDir = (id: string) => path.join(artifactDir(id), "versions");

/** The artifact dir and its versions dir must be real directories where the id says. */
function assertContained(id: string): void {
  mkdirSync(ARTIFACTS_ROOT, { recursive: true });
  const root = realpathSync(ARTIFACTS_ROOT);
  for (const [dir, expected] of [
    [artifactDir(id), path.join(root, id)],
    [versionsDir(id), path.join(root, id, "versions")],
  ] as const) {
    if (existsSync(dir) && (lstatSync(dir).isSymbolicLink() || realpathSync(dir) !== expected)) {
      throw new StorageError("invalid", `Artifact path for "${id}" escapes the store`);
    }
  }
}

function versionFilePath(id: string, contentType: ArtifactContentType, version: number): string {
  assertArtifactId(id);
  if (!Number.isSafeInteger(version) || version < 1) throw new StorageError("invalid", `Invalid version ${version}`);
  assertContained(id);
  return path.join(versionsDir(id), `${version}${EXT[contentType]}`);
}

function readMeta(id: string): ArtifactMetaFile {
  assertContained(id);
  if (!existsSync(metaPath(id))) throw new StorageError("not_found", `Artifact not found: ${id}`);
  return JSON.parse(readFileSync(metaPath(id), "utf-8")) as ArtifactMetaFile;
}

function writeMeta(meta: ArtifactMetaFile): void {
  atomicWriteFileSync(metaPath(meta.id), JSON.stringify(meta, null, 2));
}

function toArtifact(meta: ArtifactMetaFile): Artifact {
  const { schemaVersion: _schemaVersion, ...artifact } = meta;
  return artifact;
}

function toSummary(meta: ArtifactMetaFile): ArtifactSummary {
  const { schemaVersion: _schemaVersion, versions: _versions, ...summary } = meta;
  return summary;
}

/** Write one version file and append its entry; prune past the cap. Caller holds the chain. */
function appendVersion(meta: ArtifactMetaFile, content: string, note: string | undefined): ArtifactVersion {
  const version = meta.currentVersion + 1;
  const data = Buffer.from(content, "utf-8");
  mkdirSync(versionsDir(meta.id), { recursive: true });
  assertContained(meta.id);
  atomicWriteFileSync(versionFilePath(meta.id, meta.contentType, version), data);
  const now = new Date().toISOString();
  const entry: ArtifactVersion = {
    version,
    created: now,
    ...(note ? { note } : {}),
    size: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
  meta.versions.push(entry);
  meta.currentVersion = version;
  meta.updated = now;
  const pruned = meta.versions.length > ARTIFACT_MAX_VERSIONS ? meta.versions.splice(0, meta.versions.length - ARTIFACT_MAX_VERSIONS) : [];
  writeMeta(meta);
  // Meta first, files second: a crash in between leaves orphan files, never a
  // meta entry pointing at a missing one.
  for (const old of pruned) rmSync(versionFilePath(meta.id, meta.contentType, old.version), { force: true });
  return entry;
}

// ── Public API ───────────────────────────────────────────────────────

export function listArtifacts(): ArtifactSummary[] {
  if (!existsSync(ARTIFACTS_ROOT)) return [];
  const out: ArtifactSummary[] = [];
  for (const entry of readdirSync(ARTIFACTS_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || !ARTIFACT_ID_PATTERN.test(entry.name)) continue;
    try {
      out.push(toSummary(readMeta(entry.name)));
    } catch {
      /* unreadable — not listed */
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function getArtifact(id: string): Artifact {
  assertArtifactId(id);
  return toArtifact(readMeta(id));
}

export function artifactExists(id: string): boolean {
  assertArtifactId(id);
  assertContained(id);
  return existsSync(metaPath(id));
}

/** One version's source text plus the artifact it belongs to. `version` defaults to the current one. */
export function readArtifactVersion(id: string, version?: number): { artifact: Artifact; version: ArtifactVersion; content: string; filePath: string } {
  assertArtifactId(id);
  const meta = readMeta(id);
  const target = version ?? meta.currentVersion;
  const entry = meta.versions.find((v) => v.version === target);
  if (!entry)
    throw new StorageError("not_found", `Version ${target} of artifact "${id}" not found (kept versions: ${meta.versions.map((v) => v.version).join(", ")})`);
  const filePath = versionFilePath(id, meta.contentType, target);
  if (!existsSync(filePath)) throw new StorageError("not_found", `Source file for version ${target} of artifact "${id}" is missing`);
  return { artifact: toArtifact(meta), version: entry, content: readFileSync(filePath, "utf-8"), filePath };
}

export interface SaveArtifactInput {
  id: string;
  content: string;
  /** Required when creating. */
  name?: string;
  description?: string;
  /** Create only — an existing artifact's type cannot change. */
  contentType?: ArtifactContentType;
  storageAccess?: ArtifactStorageAccess;
  note?: string;
}

export interface SaveArtifactResult {
  artifact: Artifact;
  version: ArtifactVersion;
  created: boolean;
}

/**
 * Create the artifact, or append a version to it. `mode` narrows that to one
 * or the other (the REST routes are split; the tool is an upsert).
 */
export async function saveArtifact(input: SaveArtifactInput, mode: "upsert" | "create" | "append" = "upsert"): Promise<SaveArtifactResult> {
  assertArtifactId(input.id);
  assertSource(input.content);
  const note = text("note", input.note, ARTIFACT_MAX_NOTE);
  const name = text("name", input.name, ARTIFACT_MAX_NAME);
  const description = text("description", input.description, ARTIFACT_MAX_DESCRIPTION);
  if (input.contentType !== undefined) assertContentType(input.contentType);
  if (input.storageAccess !== undefined) assertStorageAccess(input.storageAccess);

  return serialize(`artifact:${input.id}`, () => {
    assertContained(input.id);
    const exists = existsSync(metaPath(input.id));
    if (exists && mode === "create") throw new StorageError("conflict", `Artifact already exists: ${input.id}`);
    if (!exists && mode === "append") throw new StorageError("not_found", `Artifact not found: ${input.id}`);

    if (exists) {
      const meta = readMeta(input.id);
      if (input.contentType !== undefined && input.contentType !== meta.contentType) {
        throw new StorageError("invalid", `Artifact "${input.id}" is ${meta.contentType}; content_type cannot change after creation`);
      }
      if (name) meta.name = name;
      if (input.description !== undefined) {
        if (description) meta.description = description;
        else delete meta.description;
      }
      if (input.storageAccess !== undefined) meta.storageAccess = input.storageAccess;
      const version = appendVersion(meta, input.content, note);
      return { artifact: toArtifact(meta), version, created: false };
    }

    if (!name) throw new StorageError("invalid", "name is required when creating an artifact");
    if (input.contentType === undefined) throw new StorageError("invalid", "content_type is required when creating an artifact");
    const now = new Date().toISOString();
    const meta: ArtifactMetaFile = {
      schemaVersion: 1,
      id: input.id,
      name,
      ...(description ? { description } : {}),
      contentType: input.contentType,
      storageAccess: input.storageAccess ?? "none",
      currentVersion: 0,
      created: now,
      updated: now,
      versions: [],
    };
    mkdirSync(versionsDir(input.id), { recursive: true });
    const version = appendVersion(meta, input.content, note);
    return { artifact: toArtifact(meta), version, created: true };
  });
}

/** Save a new version (or create) from a local file, with `render_file`'s checks. */
export async function saveArtifactFromFile(
  input: Omit<SaveArtifactInput, "content"> & { sourcePath: string },
  mode: "upsert" | "create" | "append" = "upsert",
) {
  const resolved = resolveSourcePath(input.sourcePath, ARTIFACT_MAX_SOURCE_BYTES);
  const { sourcePath: _sourcePath, ...rest } = input;
  return saveArtifact({ ...rest, content: readFileSync(resolved, "utf-8") }, mode);
}

export async function updateArtifact(id: string, patch: UpdateArtifactInput): Promise<Artifact> {
  assertArtifactId(id);
  const name = text("name", patch.name, ARTIFACT_MAX_NAME);
  if (patch.name !== undefined && !name) throw new StorageError("invalid", "name must not be empty");
  const description = text("description", patch.description, ARTIFACT_MAX_DESCRIPTION);
  if (patch.storageAccess !== undefined) assertStorageAccess(patch.storageAccess);
  return serialize(`artifact:${id}`, () => {
    const meta = readMeta(id);
    if (name) meta.name = name;
    if (patch.description !== undefined) {
      if (description) meta.description = description;
      else delete meta.description;
    }
    if (patch.storageAccess !== undefined) meta.storageAccess = patch.storageAccess;
    meta.updated = new Date().toISOString();
    writeMeta(meta);
    return toArtifact(meta);
  });
}

export async function deleteArtifact(id: string): Promise<void> {
  assertArtifactId(id);
  return serialize(`artifact:${id}`, () => {
    readMeta(id);
    rmSync(artifactDir(id), { recursive: true, force: true });
  });
}
