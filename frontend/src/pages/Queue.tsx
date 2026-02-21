import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronLeft, RotateCw, Loader, Pencil } from "lucide-react";
import { getDrafts, deleteDraft, executeDraft, type QueueItem } from "../api";
import { useIsMobile } from "../hooks/useIsMobile";
import EditDraftModal from "../components/EditDraftModal";

export default function Queue() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [drafts, setDrafts] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [executingId, setExecutingId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState<QueueItem | null>(null);

  const loadDrafts = useCallback(async () => {
    try {
      setLoading(true);
      const items = await getDrafts();
      setDrafts(items);
    } catch (err: any) {
      setError(err.message || "Failed to load drafts");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDrafts();
  }, [loadDrafts]);

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await deleteDraft(id);
        await loadDrafts();
      } catch (err: any) {
        setError(err.message || "Failed to delete draft");
      }
    },
    [loadDrafts],
  );

  const handleExecuteNow = useCallback(
    async (id: string) => {
      setExecutingId(id);
      try {
        await executeDraft(id);
        await loadDrafts();
      } catch (err: any) {
        setError(err.message || "Failed to execute draft");
      } finally {
        setExecutingId(null);
      }
    },
    [loadDrafts],
  );

  const formatTime = (isoString: string) => {
    return new Date(isoString).toLocaleString();
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <header
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexShrink: 0,
        }}
      >
        {isMobile && (
          <button onClick={() => navigate("/")} style={{ background: "none", padding: "4px 8px", display: "flex", alignItems: "center", color: "var(--text)" }}>
            <ChevronLeft size={20} />
          </button>
        )}
        <div style={{ fontSize: 18, fontWeight: 600 }}>Drafts</div>
        <button
          onClick={() => loadDrafts()}
          style={{
            marginLeft: "auto",
            background: "var(--accent)",
            color: "#fff",
            padding: "6px 12px",
            borderRadius: 6,
            fontSize: 13,
          }}
        >
          <RotateCw size={14} style={{ marginRight: 6 }} />
          Refresh
        </button>
      </header>

      {/* Content */}
      <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
        {error && (
          <div
            style={{
              color: "var(--danger)",
              background: "var(--danger-bg, rgba(255, 0, 0, 0.1))",
              padding: 12,
              borderRadius: 6,
              marginBottom: 16,
            }}
          >
            {error}
          </div>
        )}

        {loading ? (
          <div style={{ textAlign: "center", padding: 40, color: "var(--text-muted)" }}>Loading...</div>
        ) : drafts.length === 0 ? (
          <div style={{ textAlign: "center", padding: 40, color: "var(--text-muted)" }}>No draft messages</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {drafts.map((item) => (
              <div
                key={item.id}
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  padding: 16,
                  background: "var(--bg)",
                }}
              >
                <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                  <div style={{ flex: 1 }}>
                    <div
                      style={{
                        background: "var(--surface)",
                        padding: 12,
                        borderRadius: 6,
                        marginBottom: 12,
                        fontSize: 14,
                        fontFamily: "monospace",
                        whiteSpace: "pre-wrap",
                        maxHeight: 120,
                        overflow: "auto",
                      }}
                    >
                      {item.user_message}
                    </div>

                    <div style={{ display: "flex", flexWrap: "wrap", gap: 16, fontSize: 12, color: "var(--text-muted)" }}>
                      <span>Created: {formatTime(item.created_at)}</span>
                      {item.chat_id && <span>Chat: {item.chat_id}</span>}
                      {item.folder && !item.chat_id && <span>Folder: {item.folder}</span>}
                    </div>
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: 8, flexShrink: 0 }}>
                    <button
                      onClick={() => handleExecuteNow(item.id)}
                      disabled={executingId === item.id}
                      style={{
                        background: executingId === item.id ? "var(--border)" : "var(--accent)",
                        color: "#fff",
                        padding: "6px 12px",
                        borderRadius: 4,
                        fontSize: 12,
                        border: "none",
                        cursor: executingId === item.id ? "default" : "pointer",
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                      }}
                    >
                      {executingId === item.id ? (
                        <>
                          <Loader size={12} style={{ animation: "spin 1s linear infinite" }} />
                          Executing...
                        </>
                      ) : (
                        "Execute Now"
                      )}
                    </button>
                    <button
                      onClick={() => setEditingDraft(item)}
                      disabled={executingId === item.id}
                      style={{
                        background: "var(--bg-secondary)",
                        color: "var(--text)",
                        padding: "6px 12px",
                        borderRadius: 4,
                        fontSize: 12,
                        border: "1px solid var(--border)",
                        cursor: executingId === item.id ? "default" : "pointer",
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                      }}
                    >
                      <Pencil size={12} />
                      Edit
                    </button>
                    <button
                      onClick={() => handleDelete(item.id)}
                      disabled={executingId === item.id}
                      style={{
                        background: executingId === item.id ? "var(--border)" : "var(--danger)",
                        color: "#fff",
                        padding: "6px 12px",
                        borderRadius: 4,
                        fontSize: 12,
                        border: "none",
                        cursor: executingId === item.id ? "default" : "pointer",
                      }}
                    >
                      Delete
                    </button>
                    {item.chat_id && (
                      <button
                        onClick={() => navigate(`/chat/${item.chat_id}`)}
                        style={{
                          background: "var(--bg-secondary)",
                          color: "var(--text)",
                          padding: "6px 12px",
                          borderRadius: 4,
                          fontSize: 12,
                          border: "1px solid var(--border)",
                          cursor: "pointer",
                        }}
                      >
                        View Chat
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <EditDraftModal
        isOpen={editingDraft !== null}
        onClose={() => setEditingDraft(null)}
        draft={editingDraft}
        onSaved={loadDrafts}
      />
    </div>
  );
}
