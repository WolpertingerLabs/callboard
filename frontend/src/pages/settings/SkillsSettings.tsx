import { useState, useEffect, useCallback } from "react";
import { Sparkles, Plus, Pencil, Trash2 } from "lucide-react";
import { listCustomSkills, getCustomSkill, createCustomSkill, updateCustomSkill, deleteCustomSkill } from "../../api";
import type { CustomSkillListItem } from "../../api";

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
  /** Name of the skill being edited, or null when creating a new one. */
  originalName: string | null;
  name: string;
  description: string;
  content: string;
}

export default function SkillsSettings() {
  const [skills, setSkills] = useState<CustomSkillListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    return listCustomSkills()
      .then(setSkills)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const openCreate = () => {
    setError(null);
    setEditor({ originalName: null, name: "", description: "", content: "" });
  };

  const openEdit = async (name: string) => {
    setError(null);
    try {
      const skill = await getCustomSkill(name);
      setEditor({ originalName: name, name: skill.name, description: skill.description, content: skill.content });
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleSave = async () => {
    if (!editor) return;
    setSaving(true);
    setError(null);
    try {
      if (editor.originalName === null) {
        await createCustomSkill({ name: editor.name, description: editor.description, content: editor.content });
      } else {
        await updateCustomSkill(editor.originalName, {
          name: editor.name,
          description: editor.description,
          content: editor.content,
        });
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
    if (!window.confirm(`Delete the skill "${name}"? This cannot be undone.`)) return;
    setError(null);
    try {
      await deleteCustomSkill(name);
      setSkills((prev) => prev.filter((s) => s.name !== name));
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
            <Sparkles size={16} style={{ color: "var(--accent)" }} />
            <span style={{ fontSize: 15, fontWeight: 600 }}>Custom Skills</span>
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
              New skill
            </button>
          )}
        </div>
        <div style={{ ...helpStyle, marginBottom: 16 }}>
          Reusable instructions your chat sessions can invoke on both Claude Code and OpenRouter chats. Each skill is available as{" "}
          <code>callboard:&lt;name&gt;</code> from the next message after saving. Agents can also list, read, and edit these skills mid-chat with the{" "}
          <code>list_custom_skills</code>, <code>read_custom_skill</code>, and <code>write_custom_skill</code> tools.
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
              <input style={inputStyle} value={editor.name} placeholder="e.g. release-notes" onChange={(e) => setEditor({ ...editor, name: e.target.value })} />
              <div style={helpStyle}>Lowercased to kebab-case on save; invoked as callboard:&lt;name&gt;.</div>
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={labelStyle}>Description</label>
              <input
                style={inputStyle}
                value={editor.description}
                placeholder="One line describing when to use this skill"
                onChange={(e) => setEditor({ ...editor, description: e.target.value })}
              />
              <div style={helpStyle}>Shown to the model when it decides whether to use the skill — make it specific.</div>
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>Instructions</label>
              <textarea
                style={{
                  ...inputStyle,
                  fontFamily: "var(--font-mono)",
                  minHeight: 260,
                  resize: "vertical",
                  lineHeight: 1.5,
                }}
                value={editor.content}
                placeholder={"Markdown instructions the model follows when the skill is invoked…"}
                onChange={(e) => setEditor({ ...editor, content: e.target.value })}
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
                disabled={saving || !editor.name.trim() || !editor.description.trim() || !editor.content.trim()}
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
                {saving ? "Saving…" : editor.originalName === null ? "Create skill" : "Save changes"}
              </button>
            </div>
          </div>
        ) : loading ? (
          <div style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading…</div>
        ) : skills.length === 0 ? (
          <div style={{ color: "var(--text-muted)", fontSize: 13 }}>No custom skills yet. Create one to teach your chats a reusable workflow.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {skills.map((skill) => (
              <div
                key={skill.name}
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
                  <div style={{ fontSize: 13, fontWeight: 600, fontFamily: "var(--font-mono)" }}>callboard:{skill.name}</div>
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--text-muted)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {skill.description || "(no description)"}
                  </div>
                </div>
                <div style={{ fontSize: 11, color: "var(--text-muted)", flexShrink: 0 }}>{new Date(skill.updatedAt).toLocaleDateString()}</div>
                <button
                  onClick={() => openEdit(skill.name)}
                  title="Edit skill"
                  style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 4 }}
                >
                  <Pencil size={15} />
                </button>
                <button
                  onClick={() => handleDelete(skill.name)}
                  title="Delete skill"
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
