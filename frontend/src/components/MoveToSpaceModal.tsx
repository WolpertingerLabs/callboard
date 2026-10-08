import { useState } from "react";
import { moveToSpace, type SpaceMoveResult } from "../api";
import { useSpaces } from "../contexts/SpaceContext";
import ModalOverlay from "./ModalOverlay";
import { SpaceDot, spaceLabel } from "./SpaceChip";

interface MoveToSpaceModalProps {
  /** Any member chat id of each tree to move (card ids are root chat ids). */
  chatIds: string[];
  /** What is being moved, for the heading — e.g. `"Fix login bug"` or `"3 chats"`. */
  subject: string;
  /** The space the selection is in now, when known — it is left out of the list. */
  currentSpaceId?: string;
  onClose: () => void;
  onMoved?: (result: SpaceMoveResult, spaceId: string) => void;
}

/**
 * Pick a space and move whole trees into it. A tree never spans two spaces,
 * so moving one chat moves everything spawned from (and above) it — the copy
 * says so, because six rows leaving at once is otherwise a surprise.
 */
export default function MoveToSpaceModal({ chatIds, subject, currentSpaceId, onClose, onMoved }: MoveToSpaceModalProps) {
  const { spaces } = useSpaces();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const targets = spaces.filter((s) => s.id !== currentSpaceId);

  const move = async (spaceId: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await moveToSpace(spaceId, { chatIds });
      if (result.failed.length && !result.movedRoots.length) {
        setError(result.failed[0].error);
        setBusy(false);
        return;
      }
      onMoved?.(result, spaceId);
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <ModalOverlay onClose={onClose} onBackdropClick={onClose}>
      <div
        role="dialog"
        aria-label="Move to space"
        style={{ background: "var(--bg)", borderRadius: 8, padding: 20, width: "90%", maxWidth: 380, border: "1px solid var(--border)" }}
      >
        <h2 style={{ margin: "0 0 6px", fontSize: 17 }}>Move to space</h2>
        <p style={{ margin: "0 0 14px", fontSize: 13, color: "var(--text-muted)", lineHeight: 1.4 }}>
          {subject} — with every chat in {chatIds.length === 1 ? "its tree" : "their trees"}.
        </p>
        {targets.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--text-muted)" }}>There is no other space yet. Create one in Settings → Spaces.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {targets.map((space) => (
              <button
                key={space.id}
                disabled={busy}
                onClick={() => void move(space.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "8px 10px",
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  background: "var(--bg-secondary)",
                  color: "var(--text)",
                  fontSize: 14,
                  textAlign: "left",
                  cursor: busy ? "default" : "pointer",
                }}
              >
                <SpaceDot space={space} />
                {spaceLabel(space)}
              </button>
            ))}
          </div>
        )}
        {error && (
          <p role="alert" style={{ margin: "12px 0 0", fontSize: 13, color: "var(--danger)" }}>
            {error}
          </p>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
          <button
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
