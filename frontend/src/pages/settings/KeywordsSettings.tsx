import { useState, useEffect, useCallback } from "react";
import { Braces, Plus, Pencil, Trash2 } from "lucide-react";
import { listKeywords, createKeyword, updateKeyword, deleteKeyword } from "../../api";
import type { Keyword } from "../../api";

const sectionStyle: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: 20,
  background: "var(--bg)",
  marginBottom: 16,
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 600,
  marginBottom: 6,
  color: "var(--text)",
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

const helpStyle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--text-muted)",
  marginTop: 4,
};

interface EditorState {
  /** Name of the keyword being edited, or null when creating a new one. */
  originalName: string | null;
  name: string;
  description: string;
  body: string;
}

/**
 * Full CRUD over the install's injectable keywords.
 *
 * The list is small and cheap (one JSON file behind the API), so this page
 * holds the whole thing rather than paging — and unlike the Skills page there
 * is no second GET per row, since the list response already carries every
 * field the editor needs.
 */
export default function KeywordsSettings() {
  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    return listKeywords()
      .then(setKeywords)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const openCreate = () => {
    setError(null);
    setEditor({ originalName: null, name: "", description: "", body: "" });
  };

  const openEdit = (keyword: Keyword) => {
    setError(null);
    setEditor({ originalName: keyword.name, name: keyword.name, description: keyword.description, body: keyword.body });
  };

  const handleSave = async () => {
    if (!editor) return;
    setSaving(true);
    setError(null);
    try {
      if (editor.originalName === null) {
        await createKeyword({ name: editor.name, description: editor.description, body: editor.body });
      } else {
        await updateKeyword(editor.originalName, { name: editor.name, description: editor.description, body: editor.body });
      }
      setEditor(null);
      await refresh();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (name: string) => {
    if (!window.confirm(`Delete the keyword "$${name}"? This cannot be undone.`)) return;
    setError(null);
    try {
      await deleteKeyword(name);
      setKeywords((prev) => prev.filter((k) => k.name !== name));
    } catch (err: any) {
      setError(err.message);
      refresh();
    }
  };

  return (
    <div style={{ maxWidth: 720 }}>
      <div style={sectionStyle}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Braces size={16} style={{ color: "var(--accent-text)" }} />
            <span style={{ fontSize: 15, fontWeight: 600 }}>Keywords</span>
          </div>
          {!editor && (
            <button
              onClick={openCreate}
              style={{
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
              }}
            >
              <Plus size={14} />
              New keyword
            </button>
          )}
        </div>
        <div style={{ ...helpStyle, marginBottom: 16 }}>
          Reusable prompt snippets. Type <code>$name</code> anywhere in the composer and pick from the dropdown — the text is pasted inline where you typed it,
          and stays editable. Nothing about the message that gets sent differs from having typed the text by hand.
        </div>

        {error && (
          <div
            style={{
              padding: "8px 12px",
              borderRadius: 6,
              background: "var(--danger-bg)",
              border: "1px solid var(--danger-border)",
              color: "var(--danger)",
              fontSize: 13,
              marginBottom: 12,
            }}
          >
            {error}
          </div>
        )}

        {editor ? (
          <div>
            <div style={{ marginBottom: 12 }}>
              <label style={labelStyle}>Name</label>
              <input
                style={inputStyle}
                value={editor.name}
                placeholder="e.g. review-checklist"
                onChange={(e) => setEditor({ ...editor, name: e.target.value })}
              />
              <div style={helpStyle}>Lowercased to kebab-case on save; typed as $&lt;name&gt;.</div>
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={labelStyle}>
                Description <span style={{ fontWeight: 400, color: "var(--text-muted)" }}>(optional)</span>
              </label>
              <input
                style={inputStyle}
                value={editor.description}
                placeholder="One line, shown beside the name in the dropdown"
                onChange={(e) => setEditor({ ...editor, description: e.target.value })}
              />
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>Text</label>
              <textarea
                style={{
                  ...inputStyle,
                  fontFamily: "var(--font-mono)",
                  minHeight: 220,
                  resize: "vertical",
                  lineHeight: 1.5,
                }}
                value={editor.body}
                placeholder={"The text pasted into the composer when the keyword is used…"}
                onChange={(e) => setEditor({ ...editor, body: e.target.value })}
              />
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                onClick={() => {
                  setEditor(null);
                  setError(null);
                }}
                disabled={saving}
                style={{
                  padding: "8px 16px",
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  background: "transparent",
                  color: "var(--text)",
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving || !editor.name.trim() || !editor.body.trim()}
                style={{
                  padding: "8px 16px",
                  borderRadius: 6,
                  border: "none",
                  background: saving ? "var(--surface)" : "var(--accent)",
                  color: saving ? "var(--text-muted)" : "var(--text-on-accent)",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: saving ? "default" : "pointer",
                }}
              >
                {saving ? "Saving…" : editor.originalName === null ? "Create keyword" : "Save changes"}
              </button>
            </div>
          </div>
        ) : loading ? (
          <div style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading…</div>
        ) : keywords.length === 0 ? (
          <div style={{ color: "var(--text-muted)", fontSize: 13 }}>No keywords yet. Create one to stop retyping the same prompt.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {keywords.map((keyword) => (
              <div
                key={keyword.name}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "10px 12px",
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  background: "var(--surface)",
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, fontFamily: "var(--font-mono)" }}>${keyword.name}</div>
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--text-muted)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {keyword.description || "(no description)"}
                  </div>
                </div>
                <div style={{ fontSize: 11, color: "var(--text-muted)", flexShrink: 0 }}>{new Date(keyword.updatedAt).toLocaleDateString()}</div>
                <button
                  onClick={() => openEdit(keyword)}
                  title="Edit keyword"
                  style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 4 }}
                >
                  <Pencil size={15} />
                </button>
                <button
                  onClick={() => handleDelete(keyword.name)}
                  title="Delete keyword"
                  style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 4 }}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
