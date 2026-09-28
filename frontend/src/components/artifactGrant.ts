/**
 * The grant of one `render_artifact` mount, decided from the artifact as it is
 * now: {@link judgeRender} before mounting, {@link recheckGrant} while it runs.
 */
import { getArtifact, minArtifactStorageAccess } from "../api";
import type { Artifact, ArtifactStorageAccess, RenderArtifactToolResult } from "../api";

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
 * - otherwise grants the lesser of the result's access and the artifact's
 *   current declared access (unbound ⇒ none), pinned to the sha256 it checked:
 *   the frame's src carries it and the server refuses to serve other bytes,
 *   and the live bridge re-runs this same judgement before writes (see
 *   {@link recheckGrant}).
 *
 * Fail closed: an error fetching the artifact is a refusal too.
 */
export function judgeRender(data: RenderArtifactToolResult, artifact: Artifact): Verdict {
  const v = artifact.versions.find((x) => x.version === data.version);
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
  return { status: "ok", access: data.storage_key ? minArtifactStorageAccess(data.storage_access, artifact.storageAccess) : "none", sha256: v.sha256 };
}

/**
 * The live bridge's re-check: {@link judgeRender} against the artifact as it
 * is now, for the bytes this mount is running (`servedSha256`). Anything but
 * the same code still granted is "none" — deleted, replaced, pruned, lowered.
 * Throws only when the artifact could not be looked at (the bridge then
 * refuses that one request but keeps the grant).
 */
export async function recheckGrant(data: RenderArtifactToolResult, servedSha256: string): Promise<ArtifactStorageAccess> {
  let artifact: Artifact;
  try {
    artifact = await getArtifact(data.artifact_id);
  } catch (err) {
    if (err instanceof Error && /not found/i.test(err.message)) return "none";
    throw err;
  }
  const verdict = judgeRender(data, artifact);
  return verdict.status === "ok" && verdict.sha256 === servedSha256 ? verdict.access : "none";
}
