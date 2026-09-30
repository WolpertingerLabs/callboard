import { useEffect, useState, type CSSProperties } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { getArtifact, listStorageKeys } from "../api";
import type { Artifact, ArtifactStorageAccess, RenderArtifactToolResult, StorageKeySummary } from "../api";
import ArtifactRenderer, { ArtifactErrorBox } from "../components/ArtifactRenderer";
import { parseStandaloneParams, requestedAccess, useArtifactWriteGrant } from "../components/artifactStandalone";

const ACCESS_LABEL: Record<ArtifactStorageAccess, string> = { none: "no access", read: "read-only", readwrite: "read/write" };

const barStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "6px 12px",
  padding: "6px 12px",
  borderBottom: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
  fontSize: 13,
  flexShrink: 0,
};

const chipStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  padding: "1px 6px",
  borderRadius: 4,
  background: "var(--accent)",
  color: "var(--text-on-accent)",
  flexShrink: 0,
};

const selectStyle: CSSProperties = {
  padding: "4px 6px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 13,
  maxWidth: "100%",
  fontFamily: "var(--font-mono)",
};

type Loaded = { artifact: Artifact; keys: StorageKeySummary[] } | { error: string };

/**
 * `/a/<artifactId>?key=<storageKey>&v=<version>` — one artifact filling the
 * window, bound to one storage key: a bookmarkable app page, behind the same
 * login as the rest of the SPA.
 *
 * It is the chat's ArtifactRenderer (same sandboxed frame, bridge, sha pin,
 * judge-before-mount and live re-check) in its `fill` layout, under a slim bar.
 * The version defaults to the artifact's current one, pinned to its sha256 at
 * load like any render; `v` pins another.
 *
 * Access never comes from the URL (the parser reads only `key` and `v`): it
 * is read unless the user ticked "Allow saving" for this artifact on this key
 * in this browser, and always the lesser of that and the artifact's declared
 * access — which the renderer re-reads before mounting and the bridge
 * re-checks while it runs.
 *
 * This page is its own tab, so it has its own tab request budget. Two tabs (or
 * a tab and a chat bubble) bound read/write to one key are independent
 * instances: last write wins.
 */
export default function ArtifactPage() {
  const { artifactId, "*": rest } = useParams();
  const [search, setSearch] = useSearchParams();
  const params = parseStandaloneParams(artifactId, search, rest);
  const id = params.ok ? params.artifactId : null;

  const [loaded, setLoaded] = useState<{ id: string; value: Loaded } | null>(null);
  const [shownAccess, setShownAccess] = useState<ArtifactStorageAccess>("none");

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      let value: Loaded;
      try {
        const artifact = await getArtifact(id);
        // Keys are listed only for an artifact that can bind one: the picker, and the check that a bookmarked key still exists.
        const keys = artifact.storageAccess === "none" ? [] : await listStorageKeys();
        value = { artifact, keys };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        value = { error: /not found/i.test(message) ? `"${id}" does not exist.` : message };
      }
      if (!cancelled) setLoaded({ id, value });
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const current = loaded && loaded.id === id ? loaded.value : null;
  const artifact = current && "artifact" in current ? current.artifact : null;
  const declared = artifact?.storageAccess ?? "none";
  // An artifact that takes no storage is shown unbound, whatever key the link names.
  const storageKey = params.ok && declared !== "none" ? params.storageKey : null;
  const [allowWrites, setAllowWrites] = useArtifactWriteGrant(id ?? "", artifact?.created ?? null, storageKey);

  useEffect(() => {
    if (!artifact) return;
    const before = document.title;
    document.title = `${artifact.name} · Callboard`;
    return () => {
      document.title = before;
    };
  }, [artifact]);

  const frame = (child: React.ReactNode) => (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--bg)", color: "var(--text)" }} data-testid="artifact-page">
      {child}
    </div>
  );
  const failure = (reason: string) =>
    frame(
      <div style={{ padding: 16 }}>
        <ArtifactErrorBox maxWidth="100%">
          Failed to load artifact: {artifactId} — {reason}
        </ArtifactErrorBox>
      </div>,
    );

  if (!params.ok) return failure(params.reason);
  if (!current) return frame(<div style={{ padding: 16, color: "var(--text-muted)", fontSize: 13 }}>Loading…</div>);
  if ("error" in current) return failure(current.error);
  const { keys } = current;
  const a = current.artifact;
  if (storageKey && !keys.some((k) => k.key === storageKey)) return failure(`storage key "${storageKey}" does not exist.`);

  const version = params.version ?? a.currentVersion;
  const data: RenderArtifactToolResult = {
    type: "render_artifact",
    artifact_id: a.id,
    version,
    // Pinned like a chat render. A version that is gone leaves this undefined and the renderer refuses it by name.
    sha256: a.versions.find((v) => v.version === version)?.sha256,
    name: a.name,
    content_type: a.contentType,
    storage_key: storageKey ?? undefined,
    storage_access: requestedAccess(declared, storageKey, allowWrites),
  };

  const pickKey = (next: string) => {
    const q = new URLSearchParams();
    if (next) q.set("key", next);
    if (params.version !== null) q.set("v", String(params.version));
    setSearch(q, { replace: true });
  };

  return frame(
    <>
      <div style={barStyle} data-testid="artifact-page-bar">
        <span style={{ fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</span>
        <span style={chipStyle} title={params.version === null ? "The current version" : "A pinned version"}>
          v{version}
        </span>
        {declared !== "none" && (
          <label style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
            <span style={{ color: "var(--text-muted)" }}>Key</span>
            <select aria-label="Storage key" style={selectStyle} value={storageKey ?? ""} onChange={(e) => pickKey(e.target.value)}>
              <option value="">(none — unbound)</option>
              {keys.map((k) => (
                <option key={k.key} value={k.key}>
                  {k.key}
                </option>
              ))}
            </select>
          </label>
        )}
        <span style={{ color: "var(--text-muted)", fontSize: 12 }} data-testid="artifact-page-access">
          {storageKey ? ACCESS_LABEL[shownAccess] : declared === "none" ? "no storage" : "unbound"}
        </span>
        {declared === "readwrite" && storageKey && (
          <label style={{ display: "flex", alignItems: "center", gap: 6 }} title="Remembered for this artifact and key, in this browser only">
            <input type="checkbox" checked={allowWrites} onChange={(e) => setAllowWrites(e.target.checked)} />
            Allow saving
          </label>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <ArtifactRenderer data={data} fill onAccessChange={setShownAccess} />
      </div>
    </>,
  );
}
