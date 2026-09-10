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

  /**
   * Escape closes, from `document` rather than from the panel — the same shape
   * `ForkHandoffModal` uses, and here it is load-bearing rather than stylistic.
   * A React `onKeyDown` on the panel only fires while focus is inside it, and
   * starting a regeneration disables the button that had focus; the browser
   * blurs a focused element it disables, so focus lands on `<body>` and a
   * panel-scoped handler stops hearing anything. That is precisely the moment
   * — a several-second model call behind a full-screen overlay — when Escape
   * has to work.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Held by the same lock as Cancel, and for the same reason: closing over
      // a save in flight discards the only place its error can be read. Two
      // exits from one state that disagreed about whether it may be left
      // would just be the Cancel lock with a keyboard bypass.
      if (e.key === "Escape" && busy !== "saving") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

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
      // harness, a chat with nothing to title). Logged as well as shown —
      // `setError` reports into state, and state is discarded if the dialog
      // has been dismissed, which would leave some failures with no trace at
      // all. See `handleRegenerate` below, where that is the likely case.
      console.error("Failed to save chat title:", err);
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
      // Dismissal is allowed mid-flight and actively encouraged (see Cancel
      // below), so this catch routinely runs with nowhere to render: `setError`
      // is discarded once the dialog is gone, and the row simply never
      // changes — a 422 "no readable conversation" then looks exactly like a
      // regeneration that picked the same words. The log is the floor that
      // keeps that distinguishable. Not an alert: the user dismissed this
      // dialog, and interrupting them seconds later is not the answer.
      console.error("Failed to regenerate chat title:", err);
      setError(err instanceof Error ? err.message : "Failed to regenerate chat title");
    } finally {
      setBusy(null);
    }
  };

  return (
    <ModalOverlay onClose={onClose}>
      <div
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
          // Locked through both requests: a regeneration is about to replace
          // the value outright, and a keystroke landing after Save has sent
          // its body would be dropped on the close with nothing to say so.
          disabled={busy !== null}
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

          {/*
           * Live through a regeneration, disabled only through a save. The
           * asymmetry is the request behind each: a save is a metadata write
           * that answers immediately, and closing over it would swallow the
           * error message the dialog exists to show. A regeneration is an
           * untimed model call — leaving it as the one thing that pins a
           * full-screen overlay open makes a slow provider a reload-to-escape
           * trap. Closing early loses nothing: the route persists and notifies
           * on its own, and `onSaved` still patches the row from here.
           */}
          <button
            type="button"
            onClick={onClose}
            disabled={busy === "saving"}
            style={{
              padding: "8px 16px",
              borderRadius: 6,
              fontSize: 14,
              background: "var(--bg-secondary)",
              border: "1px solid var(--border)",
              color: "var(--text)",
              cursor: busy === "saving" ? "default" : "pointer",
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
