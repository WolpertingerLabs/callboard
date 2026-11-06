import { useEffect, useState } from "react";
import { Folder, Star } from "lucide-react";
import { SIDEBAR_FOLDER_MAX, includesSidebarFolder, parseSidebarFolder, sameSidebarFolder } from "shared/types/sidebarFolder.js";
import { compareSidebarFolders } from "../utils/chatSections";
import ModalOverlay from "./ModalOverlay";

interface MoveToFolderModalProps {
  /** What is being filed, for the heading — e.g. `"Fix login bug"`. */
  subject: string;
  /** The folder the chat is in now, if any. Marked in the list, and enables "Remove from folder". */
  currentFolder?: string;
  /**
   * Folder names to offer, gathered by the caller from the chats it holds.
   * There is no folder registry: a folder exists because a chat names it —
   * or because it is in {@link starredFolders}.
   */
  existingFolders: readonly string[];
  /**
   * Folders the user starred (`AgentSettings.starredSidebarFolders`). Listed
   * first, and offered even when no chat names them. Matched to
   * `existingFolders` case-insensitively; a chat's spelling wins.
   */
  starredFolders?: readonly string[];
  /** Star or unstar one folder. Omit to render no stars. */
  onToggleStar?: (folder: string) => void;
  /** True until the starred list has been read — a toggle before then would be a guess. */
  starDisabled?: boolean;
  /** Tooltip on a disabled star, and the reason a star write failed. */
  starError?: string | null;
  /**
   * Whether the row is pinned (any member of its group). A pinned row stays
   * under Pinned whatever its folder — pinned wins — so the dialog says so
   * rather than let the move look like it did nothing.
   */
  pinned?: boolean;
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
export default function MoveToFolderModal({
  subject,
  currentFolder,
  existingFolders,
  starredFolders = [],
  onToggleStar,
  starDisabled = false,
  starError,
  pinned = false,
  onSubmit,
  onClose,
}: MoveToFolderModalProps) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Escape closes, from `document` — `EditTitleModal`'s shape and reason: the
   * buttons disable while a save is in flight, the browser blurs a disabled
   * focused element, and a panel-scoped handler would stop hearing keys.
   * Held while busy, like Cancel and the backdrop: closing over a save in
   * flight discards the only place its error can be read.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, busy]);
  const closeUnlessBusy = () => {
    if (!busy) onClose();
  };
  // A starred folder no chat names joins the list under its starred spelling;
  // one a chat does name keeps the chat's. Starred first, then the rest, each
  // sorted the way the sidebar sorts its sections.
  const offered = [...new Set(existingFolders)];
  for (const starred of starredFolders) {
    if (!includesSidebarFolder(offered, starred)) offered.push(starred);
  }
  const isStarred = (folder: string) => includesSidebarFolder(starredFolders, folder);
  const folders = [...offered.filter(isStarred).sort(compareSidebarFolders), ...offered.filter((f) => !isStarred(f)).sort(compareSidebarFolders)];

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
    // Exact match first; the daemon applies the same rule across every record,
    // including ones this list has not loaded.
    const existing = folders.find((f) => f === typed) ?? folders.find((f) => sameSidebarFolder(f, typed));
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
    <ModalOverlay onClose={onClose} onBackdropClick={closeUnlessBusy}>
      <div
        role="dialog"
        aria-label="Move to folder"
        style={{ background: "var(--bg)", borderRadius: 8, padding: 20, width: "90%", maxWidth: 380, border: "1px solid var(--border)" }}
      >
        <h2 style={{ margin: "0 0 6px", fontSize: 17 }}>Move to folder</h2>
        <p style={{ margin: "0 0 14px", fontSize: 13, color: "var(--text-muted)", lineHeight: 1.4 }}>{subject} — with every chat in its tree.</p>
        {pinned && (
          <p style={{ margin: "-6px 0 14px", fontSize: 12, color: "var(--text-muted)", lineHeight: 1.4 }}>
            This chat is pinned, so it stays under Pinned until you unpin it.
          </p>
        )}

        {folders.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 14, maxHeight: 240, overflowY: "auto" }}>
            {folders.map((folder) => {
              const isCurrent = folder === currentFolder;
              const starred = isStarred(folder);
              // The star sits beside the row's button, not inside it — a button
              // cannot contain a button — so it never selects the folder.
              return (
                <div key={folder} style={{ display: "flex", alignItems: "stretch", gap: 4 }}>
                  <button
                    type="button"
                    disabled={busy || isCurrent}
                    aria-current={isCurrent || undefined}
                    onClick={() => void submit(folder)}
                    style={{ ...rowButton(isCurrent), flex: 1, minWidth: 0 }}
                  >
                    <Folder size={14} style={{ flexShrink: 0, color: "var(--text-muted)" }} />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{folder}</span>
                    {isCurrent && <span style={{ fontSize: 12, color: "var(--text-muted)" }}>current</span>}
                  </button>
                  {onToggleStar && (
                    <button
                      type="button"
                      aria-label={`${starred ? "Unstar" : "Star"} folder ${folder}`}
                      title={starDisabled ? (starError ?? "Loading starred folders…") : starred ? "Unstar — stop keeping this folder at the top" : "Star — keep this folder at the top"}
                      disabled={starDisabled}
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleStar(folder);
                      }}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                        width: 36,
                        borderRadius: 6,
                        border: "1px solid var(--border)",
                        background: "var(--bg-secondary)",
                        color: starred ? "var(--accent-text)" : "var(--text-muted)",
                        opacity: starDisabled ? 0.4 : 1,
                        cursor: starDisabled ? "default" : "pointer",
                      }}
                    >
                      <Star size={14} fill={starred ? "currentColor" : "none"} />
                    </button>
                  )}
                </div>
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
        {/* Visible, not only the disabled star's tooltip — a touch screen has no hover. */}
        {starError && (
          <p role="status" style={{ margin: "12px 0 0", fontSize: 13, color: "var(--danger)" }}>
            {starDisabled ? "Couldn't load starred folders." : starError}
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
            disabled={busy}
            style={{
              padding: "6px 14px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg-secondary)",
              color: "var(--text)",
              cursor: busy ? "default" : "pointer",
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}
