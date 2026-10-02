/**
 * The grant of one `render_artifact` mount, decided from the artifact as it is
 * now: {@link judgeRender} before mounting, {@link recheckGrant} while it runs.
 */
import { getArtifact, getArtifactBinding, minArtifactStorageAccess, storageKeyBindingRefusal, storageKeyBindsArtifact } from "../api";
import type { Artifact, ArtifactBinding, ArtifactStorageAccess, RenderArtifactToolResult } from "../api";
import { createSharedLookup, type RequestBudget, type SharedLookup } from "./artifactBudget";

/**
 * What mounting this render is allowed to do, decided from the artifact as it
 * is NOW — not as it was when the tool result was written.
 */
export type Verdict = { status: "checking" } | { status: "ok"; access: ArtifactStorageAccess; sha256: string } | { status: "refused"; reason: string };

/**
 * A render_artifact result is frozen in the chat transcript, but the artifact
 * it names is not: it can lose access, be deleted, have the version pruned, or
 * be deleted and recreated (versions restart at 1, so "v1" is now different
 * code). So before anything is mounted the host re-reads the artifact and:
 *
 * - refuses (nothing mounted, a clear message) if the artifact or the version
 *   is gone, or the version's sha256 no longer matches the one the result
 *   pinned — that is not the code the grant was made for;
 * - refuses a storage-bound result with no sha256 (written before pinning
 *   existed): its grant cannot be tied to any particular code;
 * - refuses a storage-bound result whose key does not list the artifact
 *   (`keyArtifacts`, the key's `artifacts` as it is now — absent or empty
 *   binds nothing): an artifact not on a key's list does not bind to it at
 *   all, whatever the result says, and the refusal names the fix;
 * - otherwise grants the lesser of the result's access and the artifact's
 *   current declared access (unbound ⇒ none), pinned to the sha256 it checked:
 *   the frame's src carries it and the server refuses to serve other bytes,
 *   and the live bridge re-runs this same judgement before writes (see
 *   {@link recheckGrant}).
 *
 * Fail closed: an error fetching the artifact is a refusal too.
 */
export function judgeRender(data: RenderArtifactToolResult, artifact: Artifact, keyArtifacts?: readonly string[] | null): Verdict {
  const v = artifact.versions.find((x) => x.version === data.version);
  if (!v && data.version > artifact.currentVersion) {
    return { status: "refused", reason: `version ${data.version} of "${artifact.name}" does not exist — the latest is v${artifact.currentVersion}.` };
  }
  if (!v) {
    return { status: "refused", reason: `version ${data.version} of "${artifact.name}" is no longer kept — render the artifact again.` };
  }
  if (data.sha256 !== undefined && v.sha256 !== data.sha256) {
    return {
      status: "refused",
      reason: `version ${data.version} of "${artifact.id}" has been replaced since this was rendered (the artifact was deleted and recreated), so it is not run here — render the artifact again.`,
    };
  }
  if (data.storage_key && data.sha256 === undefined) {
    return {
      status: "refused",
      reason: "this render predates version pinning, so its storage grant cannot be verified — render the artifact again.",
    };
  }
  if (artifact.contentType !== data.content_type) {
    return { status: "refused", reason: `"${artifact.id}" is no longer a ${data.content_type} artifact — render it again.` };
  }
  if (data.storage_key && !storageKeyBindsArtifact(keyArtifacts, data.artifact_id)) {
    return { status: "refused", reason: `${storageKeyBindingRefusal(data.storage_key, data.artifact_id)}.` };
  }
  return { status: "ok", access: data.storage_key ? minArtifactStorageAccess(data.storage_access, artifact.storageAccess) : "none", sha256: v.sha256 };
}

/**
 * Every re-check in the tab goes through this one lookup of `GET
 * /api/artifacts/:id`, shared per artifact: all mounts of an artifact reuse a
 * fetch fresh enough for the caller (see createSharedLookup), and the
 * renderer's judgement before mounting seeds it.
 */
export const artifactLookup: SharedLookup<Artifact> = createSharedLookup((id) => getArtifact(id));

/** The shared-lookup id of one (artifact, key) pair. Neither an artifact id nor a key can contain "/". */
export function bindingRef(artifactId: string, storageKey: string): string {
  return `${artifactId}/${storageKey}`;
}

/**
 * The same, for a render bound to a key: `GET /api/artifacts/:id/binding/:key`
 * reads the artifact AND the key's artifact list in one request, so a bound
 * mount's re-check still costs one token — and removing the artifact from the
 * key's list revokes on exactly the timing that lowering its access does.
 * Shared per (artifact, key): every mount of that pair reuses one fetch.
 */
export const bindingLookup: SharedLookup<ArtifactBinding> = createSharedLookup((ref) => {
  const cut = ref.indexOf("/");
  return getArtifactBinding(ref.slice(0, cut), ref.slice(cut + 1));
});

export interface GrantLookups {
  artifact: SharedLookup<Artifact>;
  binding: SharedLookup<ArtifactBinding>;
}
const DEFAULT_LOOKUPS: GrantLookups = { artifact: artifactLookup, binding: bindingLookup };

/**
 * The live bridge's re-check: {@link judgeRender} against the artifact as
 * seen by a check that started at most `maxAgeMs` ago (shared; a new fetch
 * spends one token of `budget`), for the bytes this mount is running
 * (`servedSha256`). A bound render is checked through {@link bindingLookup},
 * so the key's artifact list is re-read with the artifact. Anything but the
 * same code still granted is "none" — deleted (a 404 the server itself
 * reported: the artifact or the key), replaced, pruned, lowered, or taken off
 * the key's list.
 * Throws only when the artifact could not be looked at — over budget
 * (RateLimitedError), aborted, a 5xx, a 404 that is not the API's own answer
 * (a proxy's HTML page) — and the bridge then refuses that one request but
 * keeps the grant.
 */
export async function recheckGrant(
  data: RenderArtifactToolResult,
  servedSha256: string,
  maxAgeMs: number,
  budget: RequestBudget | null,
  lookups: GrantLookups = DEFAULT_LOOKUPS,
): Promise<ArtifactStorageAccess> {
  let artifact: Artifact;
  let keyArtifacts: readonly string[] | undefined;
  try {
    if (data.storage_key) {
      const binding = await lookups.binding.get(bindingRef(data.artifact_id, data.storage_key), maxAgeMs, budget);
      artifact = binding.artifact;
      keyArtifacts = binding.storageKey?.artifacts;
    } else {
      artifact = await lookups.artifact.get(data.artifact_id, maxAgeMs, budget);
    }
  } catch (err) {
    if (err instanceof Error && /not found/i.test(err.message)) return "none";
    throw err;
  }
  const verdict = judgeRender(data, artifact, keyArtifacts);
  return verdict.status === "ok" && verdict.sha256 === servedSha256 ? verdict.access : "none";
}
