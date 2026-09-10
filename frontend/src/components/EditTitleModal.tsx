import { useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { regenerateChatTitle, setChatTitle } from "../api";
import ModalOverlay from "./ModalOverlay";

/** Matches the route's cap, which in turn matches the `set_chat_title` tool's. */
const MAX_TITLE_LENGTH = 240;

interface Props {
  chatId: string;
  /** The chat's stored title, or "" if it has never had one. */
  currentTitle: string;
  /**
   * What the sidebar row falls back to with no stored title — its opening
   * message, or the folder name. Shown as the placeholder so an empty field
   * reads as "this is what you'll get back", not as a blank row.
   */
  fallbackName: string;
  onClose: () => void;
  /**
   * A title has landed server-side. Fires on save AND on regeneration, because
   * regenerating persists immediately (see the button below) — the parent is
   * expected to patch its copy of the chat either way.
   */
  onSaved: (title: string | null) => void;
}

/**
 * Rename one chat, by hand or by asking the model.
 *
 * The two live together because they are one decision — "this row is called the
 * wrong thing" — and were previously one menu entry that could only take the
 * model's answer. Typing is the primary action; regeneration is a way to fill
 * the field when you'd rather not think of the words yourself.
 *
 * **Regenerating writes.** The route re-derives, persists and notifies in a
 * single call, so the new title is live the moment it comes back and Cancel
 * cannot take it away — it only leaves further edits unsaved. That is why the
 * field is populated from the result rather than the result being held here
 * pending a save: showing an unsaved value that the list is already displaying
 * would be the lie, not the write.
 *
 * Mounted only while open (the call site renders it conditionally), so the
 * field is seeded from `currentTitle` once per open and no reset effect is
 * needed.
 */
export default function EditTitleModal({ chatId, currentTitle, fallbackName, onClose, onSaved }: Props) {
  const [value, setValue] = useState(currentTitle);
  /**
   * What the chat is called on the server right now — the baseline Save is
   * measured against. Not `currentTitle`, which is the title at open time and
   * goes stale the moment a regeneration lands: comparing against the prop
   * would leave Save lit up over a value that is already persisted, offering a
   * write that says nothing.
   */
  const [savedTitle, setSavedTitle] = useState(currentTitle);
  const [busy, setBusy] = useState<"saving" | "regenerating" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const trimmed = value.trim();
  // A no-op save still costs a write, a notify and a list-cache clear, so the
  // button is only live when there is a change to make. Clearing a title the
  // chat actually has counts as a change; clearing one it never had does not.
  // The field's own maxLength keeps the value inside the route's cap, so there
  // is no over-length state to guard here.
  const dirty = trimmed !== savedTitle.trim();

  const handleSave = async () => {
    if (busy || !dirty) return;
    setBusy("saving");
    setError(null);
    try {
      const { title } = await setChatTitle(chatId, trimmed);
      onSaved(title);
      onClose();
    } catch (err) {
      // Inline rather than an alert: the dialog is still open and is where the
      // user will retry, and the route's failures are worth reading (a retired
      // harness, a chat with nothing to title).
      setError(err instanceof Error ? err.message : "Failed to save chat title");
      setBusy(null);
    }
  };

  const handleRegenerate = async () => {
    if (busy) return;
    setBusy("regenerating");
    setError(null);
    try {
      const { title } = await regenerateChatTitle(chatId);
      setValue(title);
      setSavedTitle(title);
      onSaved(title);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to regenerate chat title");
    } finally {
      setBusy(null);
    }
  };

  return (
    <ModalOverlay onClose={onClose}>
      <div
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
        style={{
          background: "var(--bg)",
          borderRadius: 8,
          padding: 24,
          width: "90%",
          maxWidth: 480,
          border: "1px solid var(--border)",
        }}
      >
        <h2 style={{ margin: "0 0 16px 0", fontSize: 18 }}>Edit Title</h2>

        <label htmlFor="chat-title-input" style={{ display: "block", marginBottom: 8, fontSize: 14, fontWeight: 500 }}>
          Title
        </label>
        <input
          id="chat-title-input"
          ref={inputRef}
          autoFocus
          value={value}
          maxLength={MAX_TITLE_LENGTH}
          placeholder={fallbackName}
          disabled={busy === "regenerating"}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleSave();
            }
          }}
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "8px 12px",
            borderRadius: 6,
            fontSize: 14,
            background: "var(--surface)",
            border: "1px solid var(--border)",
            color: "var(--text)",
          }}
        />

        <p style={{ margin: "8px 0 0 0", fontSize: 12, color: "var(--text-muted)", lineHeight: 1.4 }}>
          Leave blank to fall back to the chat&apos;s opening message.
        </p>

        {error && (
          <div
            style={{
              color: "var(--danger)",
              fontSize: 12,
              margin: "16px 0 0 0",
              padding: 8,
              background: "var(--danger-bg)",
              borderRadius: 4,
            }}
          >
            {error}
          </div>
        )}

        <div style={{ display: "flex", gap: 12, alignItems: "center", justifyContent: "flex-end", marginTop: 24 }}>
          {/* Left of the divide: it fills the field rather than closing the dialog. */}
          <button
            type="button"
            onClick={handleRegenerate}
            disabled={busy !== null}
            title={
              busy === "regenerating"
                ? "Already regenerating this chat's title"
                : "Re-derive a title from what the conversation has become — saved as soon as it arrives"
            }
            style={{
              marginRight: "auto",
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "8px 12px",
              borderRadius: 6,
              fontSize: 14,
              background: "var(--bg-secondary)",
              border: "1px solid var(--border)",
              color: busy !== null ? "var(--text-muted)" : "var(--text)",
              cursor: busy !== null ? "default" : "pointer",
            }}
          >
            <Sparkles size={14} />
            {busy === "regenerating" ? "Regenerating…" : "Regenerate"}
          </button>

          <button
            type="button"
            onClick={onClose}
            disabled={busy !== null}
            style={{
              padding: "8px 16px",
              borderRadius: 6,
              fontSize: 14,
              background: "var(--bg-secondary)",
              border: "1px solid var(--border)",
              color: "var(--text)",
              cursor: busy !== null ? "default" : "pointer",
            }}
          >
            Cancel
          </button>

          <button
            type="button"
            onClick={handleSave}
            disabled={busy !== null || !dirty}
            style={{
              padding: "8px 16px",
              borderRadius: 6,
              fontSize: 14,
              background: busy !== null || !dirty ? "var(--border)" : "var(--accent)",
              // Accent ink on the accent fill, muted on the disabled one:
              // `--text-on-accent` is chosen for contrast against `--accent`
              // and is nearly invisible on `--border` in the light theme.
              color: busy !== null || !dirty ? "var(--text-muted)" : "var(--text-on-accent)",
              border: "none",
              cursor: busy !== null || !dirty ? "default" : "pointer",
            }}
          >
            {busy === "saving" ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}
