import { useState, useEffect, useCallback } from "react";
import { AppWindow, Plus, Trash2, ChevronLeft } from "lucide-react";
import {
  listArtifacts,
  getArtifact,
  createArtifact,
  updateArtifact,
  deleteArtifact,
  saveArtifactVersion,
  getArtifactVersionSource,
  listStorageKeys,
  ARTIFACT_ID_PATTERN,
  minArtifactStorageAccess,
} from "../../api";
import type { ArtifactSummary, Artifact, ArtifactContentType, ArtifactStorageAccess, StorageKeySummary, RenderArtifactToolResult } from "../../api";
import ConfirmModal from "../../components/ConfirmModal";
import ArtifactRenderer from "../../components/ArtifactRenderer";

const sectionStyle: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: 20,
  background: "var(--bg)",
  marginBottom: 16,
};

const labelStyle: React.CSSProperties = { display: "block", fontSize: 13, fontWeight: 600, marginBottom: 6, color: "var(--text)" };

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
  fontSize: 13,
  boxSizing: "border-box",
};

const helpStyle: React.CSSProperties = { fontSize: 12, color: "var(--text-muted)", marginTop: 4 };

const errorBoxStyle: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 6,
  background: "var(--danger-bg)",
  border: "1px solid var(--danger-border)",
  color: "var(--danger)",
  fontSize: 13,
  marginBottom: 12,
};

const primaryButton: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 12px",
  borderRadius: 6,
  border: "none",
  background: "var(--accent)",
  color: "var(--text-on-accent)",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

const secondaryButton: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 12px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text)",
  fontSize: 13,
  cursor: "pointer",
};

const subheadStyle: React.CSSProperties = { fontSize: 13, fontWeight: 600, margin: "0 0 8px 0" };

const ACCESS_LABEL: Record<ArtifactStorageAccess, string> = { none: "No storage", read: "Read", readwrite: "Read/write" };

/** Reads a picked file as text for "new version"/"new artifact" — artifacts are single text files. */
function readFileText(file: File): Promise<string> {
  return file.text();
}

/**
 * What the Settings preview grants. The artifact's declared access is the
 * ceiling; the preview itself defaults to read and only reaches readwrite when
 * the user ticks "allow writes" — a preview is someone looking, and should not
 * mutate a key as a side effect of looking.
 */
export function previewAccess(declared: ArtifactStorageAccess, storageKey: string, allowWrites: boolean): ArtifactStorageAccess {
  if (!storageKey) return "none";
  return minArtifactStorageAccess(declared, allowWrites ? "readwrite" : "read");
}

interface NewArtifactDraft {
  id: string;
  name: string;
  description: string;
  contentType: ArtifactContentType;
  storageAccess: ArtifactStorageAccess;
  content: string;
}

function ArtifactDetail({ id, onBack, onDeleted }: { id: string; onBack: () => void; onDeleted: () => void }) {
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [meta, setMeta] = useState<{ name: string; description: string; storageAccess: ArtifactStorageAccess } | null>(null);
  const [viewVersion, setViewVersion] = useState<number | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [newVersion, setNewVersion] = useState<{ content: string; note: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [keys, setKeys] = useState<StorageKeySummary[]>([]);
  const [previewKey, setPreviewKey] = useState("");
  const [allowWrites, setAllowWrites] = useState(false);

  const load = useCallback(async () => {
    try {
      const a = await getArtifact(id);
      setArtifact(a);
      setMeta({ name: a.name, description: a.description ?? "", storageAccess: a.storageAccess });
      setViewVersion((v) => (v !== null && a.versions.some((x) => x.version === v) ? v : a.currentVersion));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!artifact || artifact.storageAccess === "none") return;
    listStorageKeys()
      .then(setKeys)
      .catch((err: Error) => setError(err.message));
  }, [artifact]);

  useEffect(() => {
    if (viewVersion === null) return;
    let cancelled = false;
    setSource(null);
    getArtifactVersionSource(id, viewVersion)
      .then((s) => !cancelled && setSource(s))
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [id, viewVersion]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!artifact || !meta) {
    return <div style={{ color: "var(--text-muted)", fontSize: 13 }}>{error ? <div style={errorBoxStyle}>{error}</div> : "Loading…"}</div>;
  }

  const metaDirty = meta.name !== artifact.name || meta.description !== (artifact.description ?? "") || meta.storageAccess !== artifact.storageAccess;
  const shownVersion = viewVersion ?? artifact.currentVersion;
  const boundKey = artifact.storageAccess !== "none" ? previewKey : "";
  const access = previewAccess(artifact.storageAccess, boundKey, allowWrites);
  const previewData: RenderArtifactToolResult = {
    type: "render_artifact",
    artifact_id: artifact.id,
    version: shownVersion,
    // Pinned like a chat render, so the renderer's re-check treats the preview no differently.
    sha256: artifact.versions.find((v) => v.version === shownVersion)?.sha256,
    name: artifact.name,
    content_type: artifact.contentType,
    storage_key: boundKey || undefined,
    storage_access: access,
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button style={secondaryButton} onClick={onBack}>
          <ChevronLeft size={14} />
          All artifacts
        </button>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 14, fontWeight: 600, flex: 1 }}>{artifact.id}</span>
        <button style={{ ...secondaryButton, color: "var(--danger)" }} onClick={() => setConfirmDelete(true)} disabled={busy}>
          <Trash2 size={14} />
          Delete
        </button>
      </div>

      {error && <div style={errorBoxStyle}>{error}</div>}

      {/* Metadata */}
      <div>
        <h3 style={subheadStyle}>Details</h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label style={labelStyle} htmlFor="artifact-name">
              Name
            </label>
            <input id="artifact-name" style={inputStyle} value={meta.name} onChange={(e) => setMeta({ ...meta, name: e.target.value })} />
          </div>
          <div>
            <label style={labelStyle} htmlFor="artifact-access">
              Storage access (maximum)
            </label>
            <select
              id="artifact-access"
              style={inputStyle}
              value={meta.storageAccess}
              onChange={(e) => setMeta({ ...meta, storageAccess: e.target.value as ArtifactStorageAccess })}
            >
              <option value="none">None</option>
              <option value="read">Read</option>
              <option value="readwrite">Read/write</option>
            </select>
          </div>
        </div>
        <div style={{ marginTop: 12 }}>
          <label style={labelStyle} htmlFor="artifact-description">
            Description
          </label>
          <input id="artifact-description" style={inputStyle} value={meta.description} onChange={(e) => setMeta({ ...meta, description: e.target.value })} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
          <div style={helpStyle}>
            Type {artifact.contentType} · current v{artifact.currentVersion}
          </div>
          <button
            style={{ ...primaryButton, opacity: metaDirty && meta.name.trim() ? 1 : 0.5 }}
            disabled={busy || !metaDirty || !meta.name.trim()}
            onClick={() =>
              run(async () => {
                await updateArtifact(artifact.id, { name: meta.name.trim(), description: meta.description, storageAccess: meta.storageAccess });
                // Lowered to none: nothing may be bound, so the picked key and the write opt-in go too
                // (the preview already binds nothing — `boundKey` — this stops them resurfacing if access is raised again).
                if (meta.storageAccess === "none") {
                  setPreviewKey("");
                  setAllowWrites(false);
                }
                await load();
              })
            }
          >
            Save details
          </button>
        </div>
      </div>

      {/* Preview */}
      <div>
        <h3 style={subheadStyle}>Preview (v{shownVersion})</h3>
        {artifact.storageAccess !== "none" && (
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, marginBottom: 8, fontSize: 13 }}>
            <label htmlFor="artifact-preview-key" style={{ fontWeight: 600 }}>
              Storage key
            </label>
            <select id="artifact-preview-key" style={{ ...inputStyle, width: "auto", minWidth: 200 }} value={previewKey} onChange={(e) => setPreviewKey(e.target.value)}>
              <option value="">(none — unbound)</option>
              {keys.map((k) => (
                <option key={k.key} value={k.key}>
                  {k.key}
                </option>
              ))}
            </select>
            {artifact.storageAccess === "readwrite" && (
              <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input type="checkbox" checked={allowWrites} onChange={(e) => setAllowWrites(e.target.checked)} disabled={!previewKey} />
                Allow writes
              </label>
            )}
            <span style={{ ...helpStyle, marginTop: 0 }}>
              {!previewKey
                ? "Unbound: the artifact's storage calls will be refused."
                : access === "readwrite"
                  ? `⚠ Read/write: this preview can change or delete items in "${previewKey}".`
                  : `Read-only preview of "${previewKey}" — writes are refused.`}
            </span>
          </div>
        )}
        <ArtifactRenderer data={previewData} maxWidth="100%" />
      </div>

      {/* Versions */}
      <div>
        <h3 style={subheadStyle}>Versions</h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }} data-testid="artifact-versions">
          {[...artifact.versions]
            .sort((a, b) => b.version - a.version)
            .map((v) => {
              const active = v.version === shownVersion;
              return (
                <div
                  key={v.version}
                  role="button"
                  tabIndex={0}
                  aria-pressed={active}
                  onClick={() => setViewVersion(v.version)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") setViewVersion(v.version);
                  }}
                  style={{
                    display: "flex",
                    gap: 10,
                    alignItems: "center",
                    padding: "6px 10px",
                    borderRadius: 6,
                    border: active ? "1px solid var(--accent)" : "1px solid var(--border)",
                    background: active ? "var(--accent-bg)" : "var(--surface)",
                    fontSize: 12,
                    cursor: "pointer",
                  }}
                >
                  <span style={{ fontWeight: 600, minWidth: 32 }}>v{v.version}</span>
                  <span style={{ flex: 1, color: v.note ? "var(--text)" : "var(--text-muted)" }}>{v.note || "(no note)"}</span>
                  <span style={{ color: "var(--text-muted)" }}>{new Date(v.created).toLocaleString()}</span>
                </div>
              );
            })}
        </div>
      </div>

      {/* Source */}
      <div>
        <h3 style={subheadStyle}>Source (v{shownVersion})</h3>
        <pre
          data-testid="artifact-source"
          style={{
            margin: 0,
            padding: 12,
            maxHeight: 400,
            overflow: "auto",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            background: "var(--code-bg)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            color: "var(--text)",
          }}
        >
          {source ?? "Loading…"}
        </pre>
      </div>

      {/* New version */}
      <div>
        <h3 style={subheadStyle}>New version</h3>
        {newVersion === null ? (
          <button style={secondaryButton} onClick={() => setNewVersion({ content: source ?? "", note: "" })}>
            <Plus size={14} />
            New version
          </button>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <textarea
              aria-label="New version source"
              style={{ ...inputStyle, fontFamily: "var(--font-mono)", minHeight: 220, resize: "vertical" }}
              value={newVersion.content}
              onChange={(e) => setNewVersion({ ...newVersion, content: e.target.value })}
            />
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                aria-label="Version note"
                style={inputStyle}
                placeholder="Note (optional)"
                value={newVersion.note}
                onChange={(e) => setNewVersion({ ...newVersion, note: e.target.value })}
              />
              <input
                type="file"
                aria-label="Load version from file"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (file) setNewVersion({ ...newVersion, content: await readFileText(file) });
                }}
                style={{ fontSize: 12 }}
              />
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button style={secondaryButton} onClick={() => setNewVersion(null)} disabled={busy}>
                Cancel
              </button>
              <button
                style={{ ...primaryButton, opacity: newVersion.content ? 1 : 0.5 }}
                disabled={busy || !newVersion.content}
                onClick={() =>
                  run(async () => {
                    const updated = await saveArtifactVersion(artifact.id, newVersion.content, newVersion.note.trim() || undefined);
                    setNewVersion(null);
                    setViewVersion(updated.currentVersion);
                    await load();
                  })
                }
              >
                Save version
              </button>
            </div>
          </div>
        )}
      </div>

      <ConfirmModal
        isOpen={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() =>
          run(async () => {
            await deleteArtifact(artifact.id);
            onDeleted();
          })
        }
        title="Delete artifact"
        message={`Delete "${artifact.name}" (${artifact.id}) and all ${artifact.versions.length} version(s)? This cannot be undone.`}
        confirmText="Delete"
        confirmStyle="danger"
      />
    </div>
  );
}

export default function ArtifactsSettings() {
  const [artifacts, setArtifacts] = useState<ArtifactSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<NewArtifactDraft | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    return listArtifacts()
      .then(setArtifacts)
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleCreate = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createArtifact({
        id: draft.id.trim(),
        name: draft.name.trim(),
        description: draft.description.trim() || undefined,
        contentType: draft.contentType,
        storageAccess: draft.storageAccess,
        content: draft.content,
      });
      setDraft(null);
      await refresh();
      setSelected(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const draftValid = draft !== null && ARTIFACT_ID_PATTERN.test(draft.id.trim()) && !!draft.name.trim() && !!draft.content;

  return (
    <div style={{ maxWidth: 1000 }}>
      <div style={sectionStyle}>
        {selected ? (
          <ArtifactDetail
            key={selected}
            id={selected}
            onBack={() => {
              setSelected(null);
              refresh();
            }}
            onDeleted={() => {
              setSelected(null);
              refresh();
            }}
          />
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <AppWindow size={16} style={{ color: "var(--accent-text)" }} />
                <span style={{ fontSize: 15, fontWeight: 600 }}>Artifacts</span>
              </div>
              {!draft && (
                <button
                  style={primaryButton}
                  onClick={() => setDraft({ id: "", name: "", description: "", contentType: "html", storageAccess: "none", content: "" })}
                >
                  <Plus size={14} />
                  New artifact
                </button>
              )}
            </div>
            <div style={{ ...helpStyle, marginBottom: 16 }}>
              Reusable single-file apps and documents. Agents save them with <code>save_artifact</code> and show them in chat with <code>render_artifact</code>,
              optionally bound to a storage key. HTML runs sandboxed and cannot fetch or load anything from the network; its only data source is the one
              storage key it is rendered against. That is not a data-loss barrier — an artifact can still leak what it can read (by navigating its frame, or
              WebRTC) — so give read access to a key only to an artifact whose author you would let read it.
            </div>

            {error && <div style={errorBoxStyle}>{error}</div>}

            {draft && (
              <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16, padding: 12, border: "1px solid var(--border)", borderRadius: 6 }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <input style={inputStyle} aria-label="Artifact id" placeholder="id, e.g. cramhouse" value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value })} />
                  <input style={inputStyle} aria-label="Artifact name" placeholder="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                  <select
                    style={inputStyle}
                    aria-label="Artifact type"
                    value={draft.contentType}
                    onChange={(e) => setDraft({ ...draft, contentType: e.target.value as ArtifactContentType })}
                  >
                    <option value="html">HTML</option>
                    <option value="svg">SVG</option>
                    <option value="markdown">Markdown</option>
                  </select>
                  <select
                    style={inputStyle}
                    aria-label="Artifact storage access"
                    value={draft.storageAccess}
                    onChange={(e) => setDraft({ ...draft, storageAccess: e.target.value as ArtifactStorageAccess })}
                  >
                    <option value="none">Storage: none</option>
                    <option value="read">Storage: read</option>
                    <option value="readwrite">Storage: read/write</option>
                  </select>
                </div>
                <input
                  style={inputStyle}
                  aria-label="Artifact description"
                  placeholder="Description (optional)"
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                />
                <textarea
                  style={{ ...inputStyle, fontFamily: "var(--font-mono)", minHeight: 180, resize: "vertical" }}
                  aria-label="Artifact source"
                  placeholder="Paste the source, or load it from a file below"
                  value={draft.content}
                  onChange={(e) => setDraft({ ...draft, content: e.target.value })}
                />
                <input
                  type="file"
                  aria-label="Load artifact from file"
                  style={{ fontSize: 12 }}
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (file) setDraft({ ...draft, content: await readFileText(file) });
                  }}
                />
                <div style={helpStyle}>Id: lowercase letters, digits and hyphens, up to 64 characters. It is permanent.</div>
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <button style={secondaryButton} onClick={() => setDraft(null)} disabled={busy}>
                    Cancel
                  </button>
                  <button style={{ ...primaryButton, opacity: draftValid ? 1 : 0.5 }} onClick={handleCreate} disabled={busy || !draftValid}>
                    Create artifact
                  </button>
                </div>
              </div>
            )}

            {loading ? (
              <div style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading…</div>
            ) : artifacts.length === 0 ? (
              <div style={{ color: "var(--text-muted)", fontSize: 13 }}>No artifacts yet.</div>
            ) : (
              // Scrolls sideways on a narrow screen rather than pushing the Updated column past the card.
              <div style={{ overflowX: "auto" }} data-testid="artifact-list-scroll">
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }} data-testid="artifact-list">
                  <thead>
                    <tr style={{ textAlign: "left", color: "var(--text-muted)", fontSize: 12 }}>
                      <th style={{ padding: "6px 8px", fontWeight: 500 }}>Name</th>
                      <th style={{ padding: "6px 8px", fontWeight: 500 }}>Id</th>
                      <th style={{ padding: "6px 8px", fontWeight: 500 }}>Type</th>
                      <th style={{ padding: "6px 8px", fontWeight: 500 }}>Access</th>
                      <th style={{ padding: "6px 8px", fontWeight: 500 }}>Version</th>
                      <th style={{ padding: "6px 8px", fontWeight: 500 }}>Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {artifacts.map((a) => (
                      <tr key={a.id} onClick={() => setSelected(a.id)} style={{ cursor: "pointer", borderTop: "1px solid var(--border)" }}>
                        <td style={{ padding: "8px" }}>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelected(a.id);
                            }}
                            style={{ background: "none", border: "none", padding: 0, color: "var(--text)", fontWeight: 600, cursor: "pointer", fontSize: 13 }}
                          >
                            {a.name}
                          </button>
                        </td>
                        <td style={{ padding: "8px", fontFamily: "var(--font-mono)", fontSize: 12 }}>{a.id}</td>
                        <td style={{ padding: "8px" }}>{a.contentType}</td>
                        <td style={{ padding: "8px" }}>{ACCESS_LABEL[a.storageAccess]}</td>
                        <td style={{ padding: "8px" }}>v{a.currentVersion}</td>
                        <td style={{ padding: "8px", color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                          {a.updated ? new Date(a.updated).toLocaleDateString() : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
