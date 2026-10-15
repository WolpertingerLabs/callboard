import { useState } from "react";
import { Folder } from "lucide-react";
import { SIDEBAR_FOLDER_MAX, parseSidebarFolder } from "shared/types/sidebarFolder.js";
import { compareSidebarFolders } from "../utils/chatSections";
import ModalOverlay from "./ModalOverlay";

interface MoveToFolderModalProps {
  /** What is being filed, for the heading — e.g. `"Fix login bug"`. */
  subject: string;
  /** The folder the chat is in now, if any. Marked in the list, and enables "Remove from folder". */
  currentFolder?: string;
  /**
   * Folder names to offer, gathered by the caller from the chats it holds.
   * There is no folder registry: a folder exists because a chat names it.
   */
  existingFolders: readonly string[];
  /** Persist the choice — a name, or `null` to take the chat out of its folder. Rejects with a user-facing message. */
  onSubmit: (folder: string | null) => Promise<void>;
  onClose: () => void;
}

/**
 * Pick an existing sidebar folder, type a new one, or take the chat out of its
 * folder. A row is filed whole — by its root — so the copy says "with its
 * tree", the same way "Move to space" does.
 *
 * A typed name matching an existing folder case-insensitively is filed under
 * the existing spelling. Folder identity is the exact string, and section
 * headers render in capitals, so "Work" and "work" would otherwise be two
 * sections that read as one.
 */
export default function MoveToFolderModal({ subject, currentFolder, existingFolders, onSubmit, onClose }: MoveToFolderModalProps) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const folders = [...new Set(existingFolders)].sort(compareSidebarFolders);

  const submit = async (folder: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(folder);
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const submitTyped = () => {
    const parsed = parseSidebarFolder(name);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    if (parsed.value === null) {
      setError("Type a folder name, or pick one above");
      return;
    }
    const typed = parsed.value;
    const existing = folders.find((f) => f.localeCompare(typed, undefined, { sensitivity: "base" }) === 0);
    void submit(existing ?? typed);
  };

  const rowButton = (active: boolean) =>
    ({
      display: "flex",
      alignItems: "center",
      gap: 8,
      padding: "8px 10px",
      borderRadius: 6,
      border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
      background: "var(--bg-secondary)",
      color: "var(--text)",
      fontSize: 14,
      textAlign: "left",
      cursor: busy || active ? "default" : "pointer",
    }) as const;

  return (
    <ModalOverlay onClose={onClose} onBackdropClick={onClose}>
      <div
        role="dialog"
        aria-label="Move to folder"
        style={{ background: "var(--bg)", borderRadius: 8, padding: 20, width: "90%", maxWidth: 380, border: "1px solid var(--border)" }}
      >
        <h2 style={{ margin: "0 0 6px", fontSize: 17 }}>Move to folder</h2>
        <p style={{ margin: "0 0 14px", fontSize: 13, color: "var(--text-muted)", lineHeight: 1.4 }}>{subject} — with every chat in its tree.</p>

        {folders.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 14, maxHeight: 240, overflowY: "auto" }}>
            {folders.map((folder) => {
              const isCurrent = folder === currentFolder;
              return (
                <button
                  key={folder}
                  type="button"
                  disabled={busy || isCurrent}
                  aria-current={isCurrent || undefined}
                  onClick={() => void submit(folder)}
                  style={rowButton(isCurrent)}
                >
                  <Folder size={14} style={{ flexShrink: 0, color: "var(--text-muted)" }} />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{folder}</span>
                  {isCurrent && <span style={{ fontSize: 12, color: "var(--text-muted)" }}>current</span>}
                </button>
              );
            })}
          </div>
        )}

        <label htmlFor="sidebar-folder-input" style={{ display: "block", marginBottom: 6, fontSize: 13, fontWeight: 500 }}>
          {folders.length > 0 ? "Or a new folder" : "New folder"}
        </label>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            id="sidebar-folder-input"
            autoFocus
            value={name}
            maxLength={SIDEBAR_FOLDER_MAX}
            placeholder="Folder name"
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitTyped();
              }
            }}
            style={{
              flex: 1,
              minWidth: 0,
              boxSizing: "border-box",
              padding: "8px 12px",
              borderRadius: 6,
              fontSize: 14,
              background: "var(--surface)",
              border: "1px solid var(--border)",
              color: "var(--text)",
            }}
          />
          <button
            type="button"
            onClick={submitTyped}
            disabled={busy || name.trim() === ""}
            style={{
              padding: "8px 14px",
              borderRadius: 6,
              fontSize: 14,
              background: busy || name.trim() === "" ? "var(--border)" : "var(--accent)",
              color: busy || name.trim() === "" ? "var(--text-muted)" : "var(--text-on-accent)",
              border: "none",
              cursor: busy || name.trim() === "" ? "default" : "pointer",
            }}
          >
            Move
          </button>
        </div>

        {error && (
          <p role="alert" style={{ margin: "12px 0 0", fontSize: 13, color: "var(--danger)" }}>
            {error}
          </p>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
          {currentFolder && (
            <button
              type="button"
              onClick={() => void submit(null)}
              disabled={busy}
              style={{
                marginRight: "auto",
                padding: "6px 14px",
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: "var(--bg-secondary)",
                color: "var(--text)",
                cursor: busy ? "default" : "pointer",
              }}
            >
              Remove from folder
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: "6px 14px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg-secondary)",
              color: "var(--text)",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}
