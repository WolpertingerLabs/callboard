import { Sparkles, Plus, Pencil, Trash2 } from "lucide-react";
import { listCustomSkills, getCustomSkill, createCustomSkill, updateCustomSkill, deleteCustomSkill } from "../../api";
import type { CustomSkillListItem } from "../../api";
import FavoriteStar from "../../components/FavoriteStar";
import { useFavorites } from "../../utils/favorites";
import { sectionStyle, labelStyle, inputStyle, helpStyle } from "./styles";
import { useCrudList } from "./useCrudList";

const errorBoxStyle: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 6,
  background: "var(--danger-bg)",
  border: "1px solid var(--danger-border)",
  color: "var(--danger)",
  fontSize: 13,
  marginBottom: 12,
};

interface EditorState {
  /** Name of the skill being edited, or null when creating a new one. */
  originalName: string | null;
  name: string;
  description: string;
  content: string;
}

export default function SkillsSettings() {
  const {
    items: skills,
    loading,
    editor,
    setEditor,
    saving,
    error,
    setError,
    openEditor,
    closeEditor,
    handleSave,
    handleDelete,
  } = useCrudList<CustomSkillListItem, EditorState>({
    list: listCustomSkills,
    nameOf: (skill) => skill.name,
    save: (editor) =>
      editor.originalName === null
        ? createCustomSkill({ name: editor.name, description: editor.description, content: editor.content })
        : updateCustomSkill(editor.originalName, {
            name: editor.name,
            description: editor.description,
            content: editor.content,
          }),
    remove: deleteCustomSkill,
    confirmDeleteMessage: (name) => `Delete the skill "${name}"? This cannot be undone.`,
  });
  const favoriteSkills = useFavorites("skills");

  const openCreate = () => openEditor({ originalName: null, name: "", description: "", content: "" });

  // Unlike Keywords, the list row lacks the skill body, so editing costs a GET.
  const openEdit = async (name: string) => {
    setError(null);
    try {
      const skill = await getCustomSkill(name);
      setEditor({ originalName: name, name: skill.name, description: skill.description, content: skill.content });
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div style={{ maxWidth: 720 }}>
      <div style={sectionStyle}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Sparkles size={16} style={{ color: "var(--accent-text)" }} />
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
          Reusable instructions your chat sessions can invoke. Each skill is available as{" "}
          <code>callboard:&lt;name&gt;</code> from the next message after saving. Agents can also list, read, and edit these skills mid-chat with the{" "}
          <code>list_custom_skills</code>, <code>read_custom_skill</code>, and <code>write_custom_skill</code> tools. Star a skill to pin it to the New Chat
          screen, where one click drops it into the composer.
        </div>

        {error && <div style={errorBoxStyle}>{error}</div>}

        {/* A star that quietly un-fills is indistinguishable from a misclick,
            and the rollback is silent by design (see `utils/favorites.ts`:
            there is no hand-rolled revert, the last confirmed list simply
            stands). Something has to say the click did not take. */}
        {favoriteSkills.writeError && <div style={errorBoxStyle}>{favoriteSkills.writeError}</div>}

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
                <FavoriteStar
                  active={favoriteSkills.isFavorite(skill.name)}
                  onToggle={() => favoriteSkills.toggle(skill.name)}
                  label={`skill "${skill.name}"`}
                  disabled={!favoriteSkills.ready}
                  disabledReason={favoriteSkills.error ?? undefined}
                />
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
