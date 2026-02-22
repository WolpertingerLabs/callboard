import { useState, useEffect, useCallback } from "react";
import { useOutletContext } from "react-router-dom";
import { Save, FileText, Calendar, ChevronRight, Check } from "lucide-react";
import { useIsMobile } from "../../../hooks/useIsMobile";
import { getWorkspaceFiles, getWorkspaceFile, updateWorkspaceFile, getAgentMemory, getAgentDailyMemory } from "../../../api";
import type { AgentConfig } from "../../../api";

const FILE_LABELS: Record<string, string> = {
  "SOUL.md": "Soul & Personality",
  "USER.md": "Human Context",
  "TOOLS.md": "Environment & Tools",
  "HEARTBEAT.md": "Heartbeat Tasks",
  "MEMORY.md": "Curated Memory",
};

const FILE_DESCRIPTIONS: Record<string, string> = {
  "SOUL.md": "Personality, values, tone, boundaries — who the agent IS",
  "USER.md": "Info about the human — name, timezone, preferences",
  "TOOLS.md": "Environment-specific notes — devices, SSH, APIs",
  "HEARTBEAT.md": "Checklist for heartbeat polls — agent populates this",
  "MEMORY.md": "Curated long-term memory — distilled from daily journals",
};

export default function Memory() {
  const { agent } = useOutletContext<{ agent: AgentConfig }>();
  const isMobile = useIsMobile();

  const [files, setFiles] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Daily memory
  const [dailyFiles, setDailyFiles] = useState<string[]>([]);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [dailyContent, setDailyContent] = useState("");
  const [showDaily, setShowDaily] = useState(false);

  // Load workspace file list
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      getWorkspaceFiles(agent.alias),
      getAgentMemory(agent.alias),
    ])
      .then(([fileList, memoryInfo]) => {
        if (cancelled) return;
        const ordered = ["SOUL.md", "USER.md", "TOOLS.md", "HEARTBEAT.md", "MEMORY.md"];
        const available = ordered.filter((f) => fileList.includes(f));
        setFiles(available);
        setDailyFiles(memoryInfo.dailyFiles);
        // Auto-select first file only on initial load
        setSelectedFile((prev) => prev || (available.length > 0 ? available[0] : null));
      })
      .catch(() => {
        if (cancelled) return;
        setFiles([]);
        setDailyFiles([]);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [agent.alias]);

  // Load selected file content
  useEffect(() => {
    if (!selectedFile) return;
    setLoading(true);
    getWorkspaceFile(agent.alias, selectedFile)
      .then((c) => {
        setContent(c);
        setOriginalContent(c);
      })
      .catch(() => {
        setContent("");
        setOriginalContent("");
      })
      .finally(() => setLoading(false));
  }, [agent.alias, selectedFile]);

  // Load daily memory content
  useEffect(() => {
    if (!selectedDate) return;
    getAgentDailyMemory(agent.alias, selectedDate.replace(".md", ""))
      .then(setDailyContent)
      .catch(() => setDailyContent(""));
  }, [agent.alias, selectedDate]);

  const hasChanges = content !== originalContent;

  const handleSave = useCallback(async () => {
    if (!selectedFile || !hasChanges) return;
    setSaving(true);
    try {
      await updateWorkspaceFile(agent.alias, selectedFile, content);
      setOriginalContent(content);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  }, [agent.alias, selectedFile, content, hasChanges]);

  // Ctrl+S shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleSave]);

  return (
    <div style={{ padding: isMobile ? "16px" : "24px 32px", maxWidth: 900, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700 }}>Memory & Workspace</h1>
        <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 2 }}>
          Edit workspace files and view agent memory
        </p>
      </div>

      <div style={{ display: "flex", gap: 20, flexDirection: isMobile ? "column" : "row" }}>
        {/* File sidebar */}
        <div style={{ width: isMobile ? "100%" : 220, flexShrink: 0 }}>
          <h3
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: "var(--text-muted)",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              marginBottom: 8,
            }}
          >
            Workspace Files
          </h3>
          <div
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              overflow: "hidden",
              marginBottom: 16,
            }}
          >
            {files.map((file, i) => (
              <button
                key={file}
                onClick={() => {
                  setSelectedFile(file);
                  setShowDaily(false);
                }}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "10px 14px",
                  background: selectedFile === file && !showDaily ? "var(--bg-secondary)" : "transparent",
                  borderBottom: i < files.length - 1 ? "1px solid var(--border)" : "none",
                  textAlign: "left",
                  cursor: "pointer",
                  transition: "background 0.1s",
                }}
                onMouseEnter={(e) => {
                  if (selectedFile !== file || showDaily) e.currentTarget.style.background = "var(--bg-secondary)";
                }}
                onMouseLeave={(e) => {
                  if (selectedFile !== file || showDaily) e.currentTarget.style.background = "transparent";
                }}
              >
                <FileText size={14} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, fontFamily: "monospace" }}>{file}</div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {FILE_LABELS[file] || file}
                  </div>
                </div>
              </button>
            ))}
          </div>

          {/* Daily journals */}
          <h3
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: "var(--text-muted)",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              marginBottom: 8,
            }}
          >
            Daily Journals ({dailyFiles.length})
          </h3>
          {dailyFiles.length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--text-muted)" }}>No journal entries yet.</p>
          ) : (
            <div
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius)",
                overflow: "hidden",
                maxHeight: 200,
                overflowY: "auto",
              }}
            >
              {dailyFiles.map((file, i) => (
                <button
                  key={file}
                  onClick={() => {
                    setSelectedDate(file);
                    setShowDaily(true);
                  }}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "8px 14px",
                    background: selectedDate === file && showDaily ? "var(--bg-secondary)" : "transparent",
                    borderBottom: i < dailyFiles.length - 1 ? "1px solid var(--border)" : "none",
                    textAlign: "left",
                    cursor: "pointer",
                    fontSize: 13,
                    fontFamily: "monospace",
                    transition: "background 0.1s",
                  }}
                >
                  <Calendar size={12} style={{ color: "var(--text-muted)" }} />
                  {file.replace(".md", "")}
                  <ChevronRight size={12} style={{ marginLeft: "auto", color: "var(--text-muted)" }} />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Editor area */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {showDaily && selectedDate ? (
            <>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <div>
                  <h3 style={{ fontSize: 15, fontWeight: 600, fontFamily: "monospace" }}>
                    {selectedDate.replace(".md", "")}
                  </h3>
                  <p style={{ fontSize: 12, color: "var(--text-muted)" }}>Daily journal (read-only)</p>
                </div>
              </div>
              <div
                style={{
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  padding: 16,
                  fontSize: 14,
                  lineHeight: 1.7,
                  whiteSpace: "pre-wrap",
                  fontFamily: "monospace",
                  minHeight: 300,
                  color: dailyContent ? "var(--text)" : "var(--text-muted)",
                }}
              >
                {dailyContent || "No entries for this day."}
              </div>
            </>
          ) : selectedFile ? (
            <>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <div>
                  <h3 style={{ fontSize: 15, fontWeight: 600, fontFamily: "monospace" }}>
                    {selectedFile}
                  </h3>
                  <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
                    {FILE_DESCRIPTIONS[selectedFile] || ""}
                  </p>
                </div>
                <button
                  onClick={handleSave}
                  disabled={!hasChanges || saving}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "8px 14px",
                    borderRadius: 8,
                    fontSize: 13,
                    fontWeight: 500,
                    background: hasChanges ? "var(--accent)" : "var(--border)",
                    color: "#fff",
                    cursor: hasChanges && !saving ? "pointer" : "default",
                    transition: "background 0.15s",
                    opacity: hasChanges ? 1 : 0.5,
                  }}
                >
                  {saved ? <Check size={14} /> : <Save size={14} />}
                  {saving ? "Saving..." : saved ? "Saved" : "Save"}
                </button>
              </div>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                disabled={loading}
                style={{
                  width: "100%",
                  minHeight: 400,
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  padding: 16,
                  fontSize: 14,
                  lineHeight: 1.7,
                  fontFamily: "monospace",
                  resize: "vertical",
                  color: "var(--text)",
                }}
                placeholder={`Edit ${selectedFile}...`}
              />
              {hasChanges && (
                <p style={{ fontSize: 12, color: "var(--warning)", marginTop: 6 }}>
                  Unsaved changes. Press Ctrl+S or click Save.
                </p>
              )}
            </>
          ) : (
            <div style={{ textAlign: "center", padding: "48px 20px", color: "var(--text-muted)", fontSize: 14 }}>
              Select a file to edit.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
