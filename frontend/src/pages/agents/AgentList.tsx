import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Trash2, Bot, ChevronRight, ChevronLeft, Download, Upload } from "lucide-react";
import { useIsMobile } from "../../hooks/useIsMobile";
import { listAgents, deleteAgent, getAgentExportUrl, importAgent } from "../../api";
import type { AgentConfig } from "shared";

export default function AgentList() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchAgents = async () => {
    try {
      const data = await listAgents();
      setAgents(data);
    } catch {
      // silently fail, agents will be empty
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAgents();
  }, []);

  const handleDelete = async (alias: string) => {
    try {
      await deleteAgent(alias);
      setAgents((prev) => prev.filter((a) => a.alias !== alias));
    } catch {
      // silently fail
    }
    setDeleteTarget(null);
  };

  const handleExport = (alias: string) => {
    const url = getAgentExportUrl(alias);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${alias}-export.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleImport = async (file: File) => {
    setImporting(true);
    setImportError(null);
    try {
      const agent = await importAgent(file);
      navigate(`/agents/${agent.alias}`);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Failed to import agent");
    } finally {
      setImporting(false);
      // Reset file input so the same file can be selected again
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/* Header */}
      <div
        style={{
          padding: isMobile ? "12px 16px" : "16px 20px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {isMobile && (
            <button
              onClick={() => navigate("/")}
              style={{
                background: "none",
                border: "none",
                padding: "4px 8px",
                cursor: "pointer",
                color: "var(--text)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
              title="Back"
            >
              <ChevronLeft size={20} />
            </button>
          )}
          <h1 style={{ fontSize: 20, fontWeight: 600 }}>Agents</h1>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* Hidden file input for import */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip"
            style={{ display: "none" }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleImport(file);
            }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={importing}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              background: "var(--bg-secondary)",
              color: "var(--text)",
              padding: "8px 14px",
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 500,
              border: "1px solid var(--border)",
              opacity: importing ? 0.6 : 1,
              cursor: importing ? "not-allowed" : "pointer",
              transition: "border-color 0.15s",
            }}
            onMouseEnter={(e) => {
              if (!importing) e.currentTarget.style.borderColor = "var(--accent)";
            }}
            onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--border)")}
            title="Import agent from zip"
          >
            <Upload size={16} />
            {!isMobile && (importing ? "Importing..." : "Import")}
          </button>
          <button
            onClick={() => navigate("/agents/new")}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              background: "var(--accent)",
              color: "#fff",
              padding: "8px 14px",
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 500,
              transition: "background 0.15s",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--accent-hover)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "var(--accent)")}
          >
            <Plus size={16} />
            {!isMobile && "New Agent"}
          </button>
        </div>
      </div>

      {/* Import error banner */}
      {importError && (
        <div
          style={{
            padding: "10px 20px",
            background: "color-mix(in srgb, var(--danger) 10%, transparent)",
            borderBottom: "1px solid color-mix(in srgb, var(--danger) 30%, transparent)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexShrink: 0,
          }}
        >
          <p style={{ fontSize: 14, color: "var(--danger)", margin: 0 }}>{importError}</p>
          <button
            onClick={() => setImportError(null)}
            style={{
              background: "none",
              border: "none",
              color: "var(--danger)",
              cursor: "pointer",
              fontSize: 14,
              fontWeight: 500,
              flexShrink: 0,
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Main content */}
      <div
        style={{
          flex: 1,
          overflow: "auto",
          padding: isMobile ? "16px" : "24px 20px",
        }}
      >
        {loading ? null : agents.length === 0 ? (
          /* Empty state */
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
              textAlign: "center",
              gap: 16,
            }}
          >
            <div
              style={{
                width: 56,
                height: 56,
                borderRadius: "50%",
                background: "color-mix(in srgb, var(--accent) 12%, transparent)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Bot size={28} style={{ color: "var(--accent)" }} />
            </div>
            <div>
              <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 6 }}>No agents yet</h2>
              <p style={{ fontSize: 14, color: "var(--text-muted)", lineHeight: 1.6 }}>Create your first agent to get started.</p>
            </div>
            <button
              onClick={() => navigate("/agents/new")}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                background: "var(--accent)",
                color: "#fff",
                padding: "10px 20px",
                borderRadius: 10,
                fontSize: 14,
                fontWeight: 500,
                marginTop: 4,
                transition: "background 0.15s",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--accent-hover)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "var(--accent)")}
            >
              <Plus size={16} />
              New Agent
            </button>
          </div>
        ) : (
          /* Agent list */
          <div
            style={{
              maxWidth: 720,
              margin: "0 auto",
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            {agents.map((agent) => (
              <div
                key={agent.alias}
                onClick={() => navigate(`/agents/${agent.alias}`)}
                style={{
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  padding: isMobile ? "14px 16px" : "16px 20px",
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  cursor: "pointer",
                  transition: "border-color 0.15s",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--accent)")}
                onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--border)")}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                    <h3 style={{ fontSize: 16, fontWeight: 600 }}>{agent.name}</h3>
                    <span
                      style={{
                        fontSize: 12,
                        fontFamily: "monospace",
                        color: "var(--accent)",
                        background: "color-mix(in srgb, var(--accent) 12%, transparent)",
                        padding: "2px 8px",
                        borderRadius: 6,
                        flexShrink: 0,
                      }}
                    >
                      {agent.alias}
                    </span>
                  </div>
                  <p
                    style={{
                      fontSize: 14,
                      color: "var(--text-muted)",
                      lineHeight: 1.5,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {agent.description}
                  </p>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleExport(agent.alias);
                  }}
                  title="Export agent"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: "transparent",
                    color: "var(--text-muted)",
                    padding: 8,
                    borderRadius: 8,
                    border: "none",
                    flexShrink: 0,
                    transition: "color 0.15s, background 0.15s",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.color = "var(--accent)";
                    e.currentTarget.style.background = "color-mix(in srgb, var(--accent) 10%, transparent)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.color = "var(--text-muted)";
                    e.currentTarget.style.background = "transparent";
                  }}
                >
                  <Download size={16} />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeleteTarget(agent.alias);
                  }}
                  title="Delete agent"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: "transparent",
                    color: "var(--text-muted)",
                    padding: 8,
                    borderRadius: 8,
                    border: "none",
                    flexShrink: 0,
                    transition: "color 0.15s, background 0.15s",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.color = "var(--danger)";
                    e.currentTarget.style.background = "color-mix(in srgb, var(--danger) 10%, transparent)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.color = "var(--text-muted)";
                    e.currentTarget.style.background = "transparent";
                  }}
                >
                  <Trash2 size={16} />
                </button>
                <ChevronRight size={16} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Confirm delete modal */}
      {deleteTarget && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0, 0, 0, 0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: 20,
          }}
          onClick={() => setDeleteTarget(null)}
        >
          <div
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              padding: 24,
              maxWidth: 360,
              width: "100%",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Delete agent</h3>
            <p style={{ fontSize: 14, color: "var(--text-muted)", marginBottom: 20, lineHeight: 1.5 }}>
              Are you sure you want to delete <strong style={{ color: "var(--text)" }}>{deleteTarget}</strong>? This cannot be undone.
            </p>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button
                onClick={() => setDeleteTarget(null)}
                style={{
                  padding: "8px 16px",
                  borderRadius: 8,
                  fontSize: 14,
                  background: "var(--bg-secondary)",
                  border: "1px solid var(--border)",
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(deleteTarget)}
                style={{
                  padding: "8px 16px",
                  borderRadius: 8,
                  fontSize: 14,
                  fontWeight: 500,
                  background: "var(--danger)",
                  color: "#fff",
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
