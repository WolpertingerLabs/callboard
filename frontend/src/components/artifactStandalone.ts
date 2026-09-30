/**
 * The standalone artifact page (`/a/<artifactId>?key=<storageKey>&v=<version>`):
 * its URL, and the per-browser "allow saving" choice it shares with the
 * Settings → Artifacts preview.
 *
 * The URL names WHAT to show — artifact, key, version — and nothing about what
 * it may do. Access comes only from the remembered choice below, lowered to the
 * artifact's current declared access (and re-checked live by the bridge), so a
 * link someone else built can never hand an artifact write access.
 */
import { useCallback, useSyncExternalStore } from "react";
import { ARTIFACT_ID_PATTERN, isValidStorageKey, minArtifactStorageAccess } from "../api";
import type { ArtifactStorageAccess } from "../api";
import { ARTIFACT_WRITE_GRANT_CHANGE_EVENT, getArtifactWriteGrant, saveArtifactWriteGrant, SETTINGS_STORAGE_KEY } from "../utils/localStorage";

/** Route pattern, as registered in App.tsx. */
export const ARTIFACT_STANDALONE_ROUTE = "/a/:artifactId";

/** A version number the page will ask for: a positive integer of at most 9 digits. */
const VERSION_PARAM_PATTERN = /^[1-9][0-9]{0,8}$/;

export type StandaloneParams =
  | { ok: true; artifactId: string; storageKey: string | null; version: number | null }
  | { ok: false; reason: string };

/**
 * Reads the page's URL. Only `key` and `v` are consulted; every other
 * parameter (`write`, `access`, …) is ignored by construction — there is no
 * field here for it to land in. Each value is validated to the same shape the
 * API enforces, so nothing malformed is ever put into a request path.
 */
export function parseStandaloneParams(artifactId: string | undefined, search: URLSearchParams): StandaloneParams {
  if (!artifactId || !ARTIFACT_ID_PATTERN.test(artifactId)) {
    return { ok: false, reason: `"${artifactId ?? ""}" is not a valid artifact id.` };
  }
  const key = search.get("key");
  if (key !== null && key !== "" && !isValidStorageKey(key)) {
    return { ok: false, reason: `"${key}" is not a valid storage key.` };
  }
  const v = search.get("v");
  if (v !== null && v !== "" && !VERSION_PARAM_PATTERN.test(v)) {
    return { ok: false, reason: `"${v}" is not a valid version number.` };
  }
  return { ok: true, artifactId, storageKey: key || null, version: v ? Number(v) : null };
}

/**
 * The page's URL for one artifact, key and (optionally) pinned version.
 * Deliberately has no access argument: entry points link to what to show,
 * never to what it may do.
 */
export function standaloneArtifactHref(artifactId: string, opts: { storageKey?: string | null; version?: number | null } = {}): string {
  const q = new URLSearchParams();
  if (opts.storageKey) q.set("key", opts.storageKey);
  if (opts.version != null) q.set("v", String(opts.version));
  const qs = q.toString();
  return `/a/${encodeURIComponent(artifactId)}${qs ? `?${qs}` : ""}`;
}

/**
 * What a render outside chat — the standalone page or the Settings preview —
 * asks for. The artifact's declared access is the ceiling; below it the render
 * is read-only unless the user allowed saving. Unbound ⇒ none. The renderer
 * then takes the lesser of this and the artifact's access as it is *now*.
 */
export function requestedAccess(declared: ArtifactStorageAccess, storageKey: string | null, allowWrites: boolean): ArtifactStorageAccess {
  if (!storageKey) return "none";
  return minArtifactStorageAccess(declared, allowWrites ? "readwrite" : "read");
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === SETTINGS_STORAGE_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(ARTIFACT_WRITE_GRANT_CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(ARTIFACT_WRITE_GRANT_CHANGE_EVENT, onChange);
  };
}

/**
 * The remembered "allow saving" choice for (artifact, key), live: unticking in
 * one tab revokes in every other open on the same pair, since the change is a
 * new requested access and so a fresh frame. `storageKey` null ⇒ always false.
 */
export function useArtifactWriteGrant(artifactId: string, storageKey: string | null): [boolean, (allowed: boolean) => void] {
  const allowed = useSyncExternalStore(subscribe, () => (storageKey ? getArtifactWriteGrant(artifactId, storageKey) : false));
  const set = useCallback(
    (next: boolean) => {
      if (!storageKey) return;
      saveArtifactWriteGrant(artifactId, storageKey, next);
    },
    [artifactId, storageKey],
  );
  return [allowed, set];
}
