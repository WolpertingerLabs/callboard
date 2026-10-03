import { Braces, Plus, Pencil, Trash2 } from "lucide-react";
import { listKeywords, createKeyword, updateKeyword, deleteKeyword } from "../../api";
import type { Keyword } from "../../api";
import { sectionStyle, labelStyle, inputStyle, helpStyle } from "./styles";
import { useCrudList } from "./useCrudList";

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
  const {
    items: keywords,
    loading,
    editor,
    setEditor,
    saving,
    error,
    openEditor,
    closeEditor,
    handleSave,
    handleDelete,
  } = useCrudList<Keyword, EditorState>({
    list: listKeywords,
    nameOf: (keyword) => keyword.name,
    save: (editor) =>
      editor.originalName === null
        ? createKeyword({ name: editor.name, description: editor.description, body: editor.body })
        : updateKeyword(editor.originalName, { name: editor.name, description: editor.description, body: editor.body }),
    remove: deleteKeyword,
    confirmDeleteMessage: (name) => `Delete the keyword "$${name}"? This cannot be undone.`,
  });

  const openCreate = () => openEditor({ originalName: null, name: "", description: "", body: "" });

  const openEdit = (keyword: Keyword) => openEditor({ originalName: keyword.name, name: keyword.name, description: keyword.description, body: keyword.body });

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
              // Store-level failures name a path and a remedy, so they are a
              // sentence or three rather than a phrase. Wrapping on words and
              // honouring line breaks keeps `keywords.json.corrupt-…` readable
              // instead of running it off the edge of the banner.
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
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
                onClick={closeEditor}
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
