import { useEffect, useState } from "react";
import { X, Braces } from "lucide-react";
import ModalOverlay from "./ModalOverlay";
import { createKeyword, type Keyword } from "../api";

interface Props {
  isOpen: boolean;
  /**
   * Body to seed the editor with — the composer's selection if there was one,
   * otherwise the whole composer. Fully editable before saving, so this is a
   * starting point rather than the thing being saved.
   */
  initialBody: string;
  onClose: () => void;
  /** The created keyword, so the caller can make it live without a reload. */
  onSaved: (keyword: Keyword) => void;
}

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

/**
 * "Save as keyword" — turn what is in the composer right now into a reusable
 * `$keyword`.
 *
 * The name starts empty and **Save stays disabled until it has one**: unlike
 * the body, there is no sensible default to guess, and a keyword's name is the
 * whole handle the user will reach for later. The backend rejects an empty name
 * too, but that is the backstop, not the mechanism — the user should never get
 * far enough to see the error.
 *
 * The description is optional. Plenty of snippets explain themselves.
 */
export default function SaveKeywordModal({ isOpen, initialBody, onClose, onSaved }: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState(initialBody);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed on each open. The composer's contents move on between openings, and
  // a modal that re-appeared holding the *previous* selection would be saving
  // text the user is no longer looking at.
  useEffect(() => {
    if (!isOpen) return;
    setName("");
    setDescription("");
    setBody(initialBody);
    setError(null);
    setSaving(false);
  }, [isOpen, initialBody]);

  if (!isOpen) return null;

  const canSave = name.trim().length > 0 && body.trim().length > 0 && !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const keyword = await createKeyword({ name, description, body });
      onSaved(keyword);
      onClose();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalOverlay style={{ padding: 20 }} onClose={onClose}>
      <div
        style={{
          background: "var(--bg)",
          borderRadius: 12,
          width: "100%",
          maxWidth: 560,
          maxHeight: "85vh",
          overflow: "auto",
          border: "1px solid var(--border)",
          boxShadow: "var(--shadow-lg)",
          padding: "20px 24px 24px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Braces size={16} style={{ color: "var(--accent-text)" }} />
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600, color: "var(--text)" }}>Save as keyword</h2>
          </div>
          <button
            onClick={onClose}
            title="Close"
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: 4,
              borderRadius: 4,
              color: "var(--text-muted)",
              display: "flex",
              alignItems: "center",
            }}
          >
            <X size={20} />
          </button>
        </div>
        <div style={{ ...helpStyle, marginBottom: 16 }}>
          Type <code>$name</code> in the composer to paste this text back in.
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

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle} htmlFor="keyword-name">
            Name
          </label>
          <input id="keyword-name" style={inputStyle} value={name} placeholder="e.g. review-checklist" onChange={(e) => setName(e.target.value)} autoFocus />
          <div style={helpStyle}>Lowercased to kebab-case on save; typed as $&lt;name&gt;.</div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle} htmlFor="keyword-description">
            Description <span style={{ fontWeight: 400, color: "var(--text-muted)" }}>(optional)</span>
          </label>
          <input
            id="keyword-description"
            style={inputStyle}
            value={description}
            placeholder="One line, shown beside the name in the dropdown"
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle} htmlFor="keyword-body">
            Text
          </label>
          <textarea
            id="keyword-body"
            style={{ ...inputStyle, fontFamily: "var(--font-mono)", minHeight: 180, resize: "vertical", lineHeight: 1.5 }}
            value={body}
            placeholder="The text pasted into the composer when the keyword is used…"
            onChange={(e) => setBody(e.target.value)}
          />
        </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            onClick={onClose}
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
            disabled={!canSave}
            style={{
              padding: "8px 16px",
              borderRadius: 6,
              border: "none",
              background: canSave ? "var(--accent)" : "var(--surface)",
              color: canSave ? "var(--text-on-accent)" : "var(--text-muted)",
              fontSize: 13,
              fontWeight: 600,
              cursor: canSave ? "pointer" : "default",
            }}
          >
            {saving ? "Saving…" : "Save keyword"}
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}
