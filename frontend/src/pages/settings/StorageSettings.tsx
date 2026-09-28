import { useState, useEffect, useCallback, useRef } from "react";
import { Database, Plus, Trash2, Upload, FilePlus, Download, Pencil } from "lucide-react";
import {
  listStorageKeys,
  createStorageKey,
  getStorageKey,
  updateStorageKey,
  deleteStorageKey,
  fetchStorageItem,
  putStorageItem,
  deleteStorageItem,
  storageItemUrl,
} from "../../api";
import type { StorageKeySummary, StorageKeyDetail, StorageItemMeta } from "../../api";
import { isValidStorageItemName, isValidStorageKey } from "../../types/storageArtifacts";
import ConfirmModal from "../../components/ConfirmModal";
import MarkdownRenderer from "../../components/MarkdownRenderer";

const sectionStyle: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: 20,
  background: "var(--bg)",
  marginBottom: 16,
};

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

const iconButton: React.CSSProperties = { background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 4 };

/** Plan §2: text previews show the first 256 KB. */
export const TEXT_PREVIEW_BYTES = 256 * 1024;

const RASTER_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * How an item is previewed. Only raster images load by URL — the item route
 * serves those inline. Everything textual is fetched and shown as text
 * (markdown through MarkdownRenderer), so HTML and SVG items are displayed as
 * their source and never rendered.
 */
export function previewKind(item: Pick<StorageItemMeta, "name" | "mimeType">): "image" | "markdown" | "text" | "binary" {
  const mime = item.mimeType.toLowerCase().split(";")[0].trim();
  if (RASTER_TYPES.has(mime)) return "image";
  if (mime === "text/markdown" || /\.(md|markdown)$/i.test(item.name)) return "markdown";
  if (
    mime.startsWith("text/") ||
    mime.endsWith("+json") ||
    mime.endsWith("+xml") ||
    ["application/json", "application/javascript", "application/xml", "application/x-yaml", "application/yaml", "application/toml", "image/svg+xml"].includes(mime)
  )
    return "text";
  return "binary";
}

function ItemPreview({ storageKey, item }: { storageKey: string; item: StorageItemMeta }) {
  const kind = previewKind(item);
  const [text, setText] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const url = storageItemUrl(storageKey, item.name);

  useEffect(() => {
    if (kind !== "text" && kind !== "markdown") return;
    let cancelled = false;
    setText(null);
    setError(null);
    fetchStorageItem(storageKey, item.name)
      .then((res) => res.blob())
      .then(async (blob) => {
        const head = await blob.slice(0, TEXT_PREVIEW_BYTES).text();
        if (cancelled) return;
        setTruncated(blob.size > TEXT_PREVIEW_BYTES);
        setText(head);
      })
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [storageKey, item.name, item.sha256, kind]);

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface)", overflow: "hidden" }} data-testid="storage-preview">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          borderBottom: "1px solid var(--border)",
          fontSize: 12,
          color: "var(--text-muted)",
        }}
      >
        <span style={{ fontFamily: "var(--font-mono)", color: "var(--text)", fontWeight: 600, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
          {item.name}
        </span>
        <span>{item.mimeType}</span>
        <span>{formatBytes(item.size)}</span>
        <a href={url} download={item.name} title="Download" style={{ color: "var(--accent-text)", display: "flex" }}>
          <Download size={14} />
        </a>
      </div>
      <div style={{ padding: 12, maxHeight: 480, overflow: "auto" }}>
        {error && <div style={errorBoxStyle}>{error}</div>}
        {kind === "image" && <img src={url} alt={item.name} referrerPolicy="no-referrer" style={{ maxWidth: "100%", maxHeight: 440, display: "block" }} />}
        {kind === "markdown" && text !== null && <MarkdownRenderer content={text} />}
        {kind === "text" && text !== null && (
          <pre style={{ margin: 0, fontFamily: "var(--font-mono)", fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--text)" }}>{text}</pre>
        )}
        {truncated && <div style={helpStyle}>Showing the first {formatBytes(TEXT_PREVIEW_BYTES)} — download for the whole item.</div>}
        {kind === "binary" && (
          <div style={{ fontSize: 13, color: "var(--text-muted)", display: "flex", flexDirection: "column", gap: 4 }}>
            <div>No preview for {item.mimeType}.</div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>sha256 {item.sha256}</div>
            <div>Updated {new Date(item.updated).toLocaleString()}</div>
            <a href={url} download={item.name} style={{ color: "var(--accent-text)" }}>
              Download {item.name}
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

type Pending = { kind: "key"; key: string } | { kind: "item"; key: string; name: string };

export default function StorageSettings() {
  const [keys, setKeys] = useState<StorageKeySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<StorageKeyDetail | null>(null);
  const [previewName, setPreviewName] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<{ key: string; description: string } | null>(null);
  const [newItem, setNewItem] = useState<{ name: string; content: string; mimeType: string } | null>(null);
  const [editingDescription, setEditingDescription] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const refreshKeys = useCallback(() => {
    return listStorageKeys()
      .then(setKeys)
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const refreshDetail = useCallback(async (key: string) => {
    try {
      setDetail(await getStorageKey(key));
    } catch (err: any) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    refreshKeys();
  }, [refreshKeys]);

  useEffect(() => {
    setDetail(null);
    setPreviewName(null);
    setNewItem(null);
    setEditingDescription(null);
    if (selected) refreshDetail(selected);
  }, [selected, refreshDetail]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleCreateKey = () =>
    run(async () => {
      if (!newKey) return;
      await createStorageKey(newKey.key.trim(), newKey.description.trim() || undefined);
      const created = newKey.key.trim();
      setNewKey(null);
      await refreshKeys();
      setSelected(created);
    });

  const handleSaveDescription = () =>
    run(async () => {
      if (!selected || editingDescription === null) return;
      await updateStorageKey(selected, editingDescription);
      setEditingDescription(null);
      await Promise.all([refreshDetail(selected), refreshKeys()]);
    });

  const handleUpload = (files: FileList | null) =>
    run(async () => {
      if (!selected || !files || files.length === 0) return;
      const bad = Array.from(files).filter((f) => !isValidStorageItemName(f.name));
      if (bad.length) throw new Error(`Invalid item name: ${bad.map((f) => f.name).join(", ")} — letters, digits, ".", "_" and "-" only, not starting with "."`);
      for (const file of Array.from(files)) await putStorageItem(selected, file.name, { file });
      if (fileInput.current) fileInput.current.value = "";
      await Promise.all([refreshDetail(selected), refreshKeys()]);
    });

  const handleCreateItem = () =>
    run(async () => {
      if (!selected || !newItem) return;
      await putStorageItem(selected, newItem.name.trim(), { content: newItem.content, mimeType: newItem.mimeType.trim() || undefined });
      const name = newItem.name.trim();
      setNewItem(null);
      await Promise.all([refreshDetail(selected), refreshKeys()]);
      setPreviewName(name);
    });

  const confirmDelete = () => {
    const target = pendingDelete;
    if (!target) return;
    run(async () => {
      if (target.kind === "key") {
        await deleteStorageKey(target.key);
        if (selected === target.key) setSelected(null);
        await refreshKeys();
      } else {
        await deleteStorageItem(target.key, target.name);
        if (previewName === target.name) setPreviewName(null);
        await Promise.all([refreshDetail(target.key), refreshKeys()]);
      }
    });
  };

  const previewItem = detail?.items.find((i) => i.name === previewName) ?? null;
  const newKeyValid = newKey !== null && isValidStorageKey(newKey.key.trim());
  const newItemValid = newItem !== null && isValidStorageItemName(newItem.name.trim());

  return (
    <div style={{ maxWidth: 1100 }}>
      <div style={sectionStyle}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Database size={16} style={{ color: "var(--accent-text)" }} />
            <span style={{ fontSize: 15, fontWeight: 600 }}>Storage</span>
          </div>
          {!newKey && (
            <button style={primaryButton} onClick={() => setNewKey({ key: "", description: "" })}>
              <Plus size={14} />
              New key
            </button>
          )}
        </div>
        <div style={{ ...helpStyle, marginBottom: 16 }}>
          Named buckets of files that agents and artifacts share. Agents use <code>list_storage_keys</code>, <code>read_storage_item</code> and{" "}
          <code>save_storage_item</code>; an artifact rendered against a key can read (and, if granted, write) that key&apos;s items only.
        </div>

        {error && <div style={errorBoxStyle}>{error}</div>}

        {newKey && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16, padding: 12, border: "1px solid var(--border)", borderRadius: 6 }}>
            <input
              style={inputStyle}
              aria-label="Key name"
              placeholder="e.g. birds-of-western-europe"
              value={newKey.key}
              onChange={(e) => setNewKey({ ...newKey, key: e.target.value })}
            />
            <input
              style={inputStyle}
              aria-label="Key description"
              placeholder="Description (optional)"
              value={newKey.description}
              onChange={(e) => setNewKey({ ...newKey, description: e.target.value })}
            />
            <div style={helpStyle}>Lowercase letters, digits, dots, underscores and hyphens; up to 64 characters.</div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button style={secondaryButton} onClick={() => setNewKey(null)} disabled={busy}>
                Cancel
              </button>
              <button style={{ ...primaryButton, opacity: newKeyValid ? 1 : 0.5 }} onClick={handleCreateKey} disabled={busy || !newKeyValid}>
                Create key
              </button>
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
          {/* Key list */}
          <div style={{ flex: "0 0 280px", minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }} data-testid="storage-key-list">
            {loading ? (
              <div style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading…</div>
            ) : keys.length === 0 ? (
              <div style={{ color: "var(--text-muted)", fontSize: 13 }}>No storage keys yet.</div>
            ) : (
              keys.map((k) => {
                const active = k.key === selected;
                return (
                  <div
                    key={k.key}
                    role="button"
                    tabIndex={0}
                    aria-pressed={active}
                    onClick={() => setSelected(k.key)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") setSelected(k.key);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "8px 10px",
                      borderRadius: 6,
                      border: active ? "1px solid var(--accent)" : "1px solid var(--border)",
                      background: active ? "var(--accent-bg)" : "var(--surface)",
                      cursor: "pointer",
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis" }}>{k.key}</div>
                      <div style={{ fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {k.itemCount} item{k.itemCount === 1 ? "" : "s"} · {formatBytes(k.totalSize)}
                        {k.description ? ` · ${k.description}` : ""}
                      </div>
                    </div>
                    <button
                      title={`Delete key ${k.key}`}
                      style={iconButton}
                      onClick={(e) => {
                        e.stopPropagation();
                        setPendingDelete({ kind: "key", key: k.key });
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                );
              })
            )}
          </div>

          {/* Selected key */}
          <div style={{ flex: "1 1 400px", minWidth: 0 }}>
            {!selected ? (
              <div style={{ color: "var(--text-muted)", fontSize: 13 }}>Select a key to browse its items.</div>
            ) : !detail ? (
              <div style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading…</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 14, fontWeight: 600 }}>{detail.key}</div>
                  {editingDescription === null ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-muted)" }}>
                      <span>{detail.description || "(no description)"}</span>
                      <button title="Edit description" style={iconButton} onClick={() => setEditingDescription(detail.description ?? "")}>
                        <Pencil size={12} />
                      </button>
                    </div>
                  ) : (
                    <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                      <input
                        style={inputStyle}
                        aria-label="Edit key description"
                        value={editingDescription}
                        onChange={(e) => setEditingDescription(e.target.value)}
                      />
                      <button style={secondaryButton} onClick={() => setEditingDescription(null)} disabled={busy}>
                        Cancel
                      </button>
                      <button style={primaryButton} onClick={handleSaveDescription} disabled={busy}>
                        Save
                      </button>
                    </div>
                  )}
                </div>

                <div style={{ display: "flex", gap: 8 }}>
                  <button style={secondaryButton} onClick={() => fileInput.current?.click()} disabled={busy}>
                    <Upload size={14} />
                    Upload files
                  </button>
                  <input
                    ref={fileInput}
                    type="file"
                    multiple
                    aria-label="Upload files"
                    style={{ display: "none" }}
                    onChange={(e) => handleUpload(e.target.files)}
                  />
                  {!newItem && (
                    <button style={secondaryButton} onClick={() => setNewItem({ name: "", content: "", mimeType: "" })} disabled={busy}>
                      <FilePlus size={14} />
                      New text item
                    </button>
                  )}
                </div>

                {newItem && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12, border: "1px solid var(--border)", borderRadius: 6 }}>
                    <div style={{ display: "flex", gap: 8 }}>
                      <input
                        style={inputStyle}
                        aria-label="Item name"
                        placeholder="e.g. deck.json"
                        value={newItem.name}
                        onChange={(e) => setNewItem({ ...newItem, name: e.target.value })}
                      />
                      <input
                        style={{ ...inputStyle, maxWidth: 200 }}
                        aria-label="Item MIME type"
                        placeholder="MIME type (optional)"
                        value={newItem.mimeType}
                        onChange={(e) => setNewItem({ ...newItem, mimeType: e.target.value })}
                      />
                    </div>
                    <textarea
                      style={{ ...inputStyle, fontFamily: "var(--font-mono)", minHeight: 160, resize: "vertical" }}
                      aria-label="Item content"
                      value={newItem.content}
                      onChange={(e) => setNewItem({ ...newItem, content: e.target.value })}
                    />
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                      <button style={secondaryButton} onClick={() => setNewItem(null)} disabled={busy}>
                        Cancel
                      </button>
                      <button style={{ ...primaryButton, opacity: newItemValid ? 1 : 0.5 }} onClick={handleCreateItem} disabled={busy || !newItemValid}>
                        Save item
                      </button>
                    </div>
                  </div>
                )}

                {detail.items.length === 0 ? (
                  <div style={{ color: "var(--text-muted)", fontSize: 13 }}>This key is empty.</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }} data-testid="storage-item-list">
                    {detail.items.map((item) => {
                      const active = item.name === previewName;
                      return (
                        <div
                          key={item.name}
                          role="button"
                          tabIndex={0}
                          aria-pressed={active}
                          onClick={() => setPreviewName(item.name)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") setPreviewName(item.name);
                          }}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            padding: "6px 10px",
                            borderRadius: 6,
                            border: active ? "1px solid var(--accent)" : "1px solid var(--border)",
                            background: active ? "var(--accent-bg)" : "var(--surface)",
                            cursor: "pointer",
                            fontSize: 12,
                          }}
                        >
                          <span style={{ fontFamily: "var(--font-mono)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{item.name}</span>
                          <span style={{ color: "var(--text-muted)" }}>{item.mimeType}</span>
                          <span style={{ color: "var(--text-muted)", minWidth: 60, textAlign: "right" }}>{formatBytes(item.size)}</span>
                          <button
                            title={`Delete item ${item.name}`}
                            style={iconButton}
                            onClick={(e) => {
                              e.stopPropagation();
                              setPendingDelete({ kind: "item", key: detail.key, name: item.name });
                            }}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}

                {previewItem && <ItemPreview key={`${detail.key}/${previewItem.name}`} storageKey={detail.key} item={previewItem} />}
              </div>
            )}
          </div>
        </div>
      </div>

      <ConfirmModal
        isOpen={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
        title={pendingDelete?.kind === "key" ? "Delete storage key" : "Delete item"}
        message={
          pendingDelete?.kind === "key"
            ? `Delete the key "${pendingDelete.key}" and every item in it? This cannot be undone.`
            : pendingDelete
              ? `Delete "${pendingDelete.name}" from "${pendingDelete.key}"? This cannot be undone.`
              : ""
        }
        confirmText="Delete"
        confirmStyle="danger"
      />
    </div>
  );
}
