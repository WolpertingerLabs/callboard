import { useState, useEffect, useCallback, useRef } from "react";
import { Workflow, Plus, Pencil, Trash2, Play, ChevronDown, ChevronRight, RefreshCw, Download, Upload } from "lucide-react";
import { listJobs, createJob, updateJob, deleteJob, spawnJob, listJobRuns, getJobExportUrl, importJob } from "../../api";
import type { JobDefinition, JobDefinitionPayload, JobRunListItem } from "../../api";
import JobRunPanel, { JOB_RUN_STATUS_META } from "../../components/JobRunPanel";
import ModalOverlay from "../../components/ModalOverlay";

const sectionStyle: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: 20,
  background: "var(--bg)",
  marginBottom: 16,
};

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

const errorBoxStyle: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 6,
  background: "var(--danger-bg)",
  border: "1px solid var(--danger-border)",
  color: "var(--danger)",
  fontSize: 13,
  marginBottom: 12,
  whiteSpace: "pre-wrap",
};

const successBoxStyle: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 6,
  background: "var(--success-bg)",
  border: "1px solid var(--success)",
  color: "var(--success)",
  fontSize: 13,
  marginBottom: 12,
};

const NEW_JOB_TEMPLATE = `{
  "name": "My Job",
  "description": "What this workflow does",
  "inputs": [
    { "key": "task", "label": "Task description", "type": "text", "required": true }
  ],
  "defaults": { "folder": "/absolute/path/to/repo" },
  "steps": [
    {
      "id": "parallel_checks",
      "type": "parallel",
      "mode": "all",
      "branches": [
        { "id": "work", "type": "agent", "prompt": "Do the following task: {{inputs.task}}", "outputs": ["result"] },
        { "id": "review", "type": "agent", "prompt": "Review this task for risks: {{inputs.task}}", "outputs": ["notes"] }
      ],
      "onFailure": "fail"
    },
    {
      "id": "signoff",
      "type": "approval",
      "message": "Result ready:\\n\\n{{steps.parallel_checks.outputs.work.result}}",
      "notify": false
    },
    {
      "id": "done",
      "type": "notify",
      "message": "The job finished: {{steps.parallel_checks.outputs.work.result}}"
    }
  ]
}`;

/** Strip server-managed fields so the editor shows only the editable payload. */
function toEditorJson(job: JobDefinition): string {
  const { version: _v, createdAt: _c, updatedAt: _u, createdBy: _b, ...payload } = job;
  return JSON.stringify(payload, null, 2);
}

interface EditorState {
  /** Job id being edited, or null when creating. */
  originalId: string | null;
  json: string;
}

interface SpawnState {
  jobId: string;
  values: Record<string, string>;
}

export default function JobsSettings() {
  const [jobs, setJobs] = useState<JobDefinition[]>([]);
  const [runs, setRuns] = useState<JobRunListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [spawnForm, setSpawnForm] = useState<SpawnState | null>(null);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);

  // Import state
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);
  // The parsed payload + conflicting id while awaiting a copy/overwrite choice.
  const [conflict, setConflict] = useState<{ id: string; payload: unknown } | null>(null);
  // Id of the just-imported job to scroll to and briefly highlight.
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const refreshJobs = useCallback(() => {
    return listJobs()
      .then(setJobs)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const refreshRuns = useCallback(() => {
    return listJobRuns({ limit: 50 })
      .then((r) => {
        setRuns(r);
        setRunsError(null);
      })
      .catch((err) => setRunsError(err.message));
  }, []);

  useEffect(() => {
    refreshJobs();
    refreshRuns();
  }, [refreshJobs, refreshRuns]);

  // Keep the runs table live while any run is active.
  useEffect(() => {
    const hasActive = runs.some((r) => !["succeeded", "failed", "cancelled"].includes(r.status));
    if (!hasActive) return;
    const interval = setInterval(refreshRuns, 5000);
    return () => clearInterval(interval);
  }, [runs, refreshRuns]);

  const handleSave = async () => {
    if (!editor) return;
    setSaving(true);
    setError(null);
    try {
      const payload: JobDefinitionPayload = JSON.parse(editor.json);
      if (editor.originalId === null) {
        await createJob(payload);
      } else {
        await updateJob(editor.originalId, payload);
      }
      setEditor(null);
      await refreshJobs();
    } catch (err: any) {
      setError(err instanceof SyntaxError ? `Invalid JSON: ${err.message}` : err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm(`Delete the job "${id}"? Existing runs keep their frozen copy.`)) return;
    setError(null);
    try {
      await deleteJob(id);
      setJobs((prev) => prev.filter((j) => j.id !== id));
    } catch (err: any) {
      setError(err.message);
      refreshJobs();
    }
  };

  const openSpawn = (job: JobDefinition) => {
    setError(null);
    const values: Record<string, string> = {};
    for (const input of job.inputs ?? []) {
      if (input.default !== undefined) values[input.key] = input.default;
    }
    setSpawnForm({ jobId: job.id, values });
  };

  const handleSpawn = async () => {
    if (!spawnForm) return;
    setSaving(true);
    setError(null);
    try {
      const run = await spawnJob(spawnForm.jobId, spawnForm.values);
      setSpawnForm(null);
      await refreshRuns();
      setExpandedRun(run.runId);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleExport = (id: string) => {
    const a = document.createElement("a");
    a.href = getJobExportUrl(id);
    a.download = `${id}.job.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  // Run the import for an already-parsed payload, surfacing conflicts and errors.
  const runImport = useCallback(
    async (payload: unknown, mode?: "copy" | "overwrite") => {
      setImporting(true);
      setImportError(null);
      try {
        const result = await importJob(payload, mode);
        if (result.conflict?.id) {
          setConflict({ id: result.conflict.id, payload });
          return;
        }
        const job = result.job!;
        setConflict(null);
        setImportOpen(false);
        setImportText("");
        await refreshJobs();
        setHighlightId(job.id);
        setImportSuccess(`Imported "${job.name}" (${job.id}).`);
      } catch (err: any) {
        setConflict(null);
        setImportError(err.message);
      } finally {
        setImporting(false);
      }
    },
    [refreshJobs],
  );

  // Parse raw JSON text, then import. Returns false on parse failure.
  const importFromText = useCallback(
    (text: string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (err: any) {
        setImportError(`Invalid JSON: ${err.message}`);
        return;
      }
      void runImport(parsed);
    },
    [runImport],
  );

  const handleFile = async (file: File) => {
    setImportError(null);
    setImportSuccess(null);
    let text: string;
    try {
      text = await file.text();
    } catch {
      setImportError("Could not read the selected file.");
      return;
    }
    importFromText(text);
  };

  // Scroll to and briefly highlight a freshly imported job.
  useEffect(() => {
    if (!highlightId) return;
    cardRefs.current.get(highlightId)?.scrollIntoView({ behavior: "smooth", block: "center" });
    const t = setTimeout(() => setHighlightId(null), 2500);
    return () => clearTimeout(t);
  }, [highlightId, jobs]);

  const spawnJobDef = spawnForm ? jobs.find((j) => j.id === spawnForm.jobId) : null;

  return (
    <div style={{ maxWidth: 860 }}>
      {/* ── Definitions ─────────────────────────────────────────── */}
      <div style={sectionStyle}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Workflow size={16} style={{ color: "var(--accent)" }} />
            <span style={{ fontSize: 15, fontWeight: 600 }}>Jobs</span>
          </div>
          {!editor && (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {/* Hidden file input for import */}
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                style={{ display: "none" }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleFile(file);
                  e.target.value = "";
                }}
              />
              <button
                onClick={() => {
                  setImportOpen((v) => !v);
                  setImportError(null);
                  setImportSuccess(null);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "6px 12px",
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  background: "transparent",
                  color: "var(--text)",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                <Upload size={14} />
                Import job
              </button>
              <button
                onClick={() => {
                  setError(null);
                  setEditor({ originalId: null, json: NEW_JOB_TEMPLATE });
                }}
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
                New job
              </button>
            </div>
          )}
        </div>
        <div style={{ ...helpStyle, marginBottom: 16 }}>
          Deterministic multi-step workflows: each step spawns an agent session, waits for your signoff, polls until a condition holds, waits for an event,
          branches on a gate, runs parallel agent branches, or notifies you. You can also create and spawn jobs from any chat — ask the agent to use the{" "}
          <code>create_job</code> and <code>spawn_job</code> tools.
        </div>

        {error && <div style={errorBoxStyle}>{error}</div>}
        {importSuccess && !importOpen && <div style={successBoxStyle}>{importSuccess}</div>}

        {/* ── Import panel: pick a file or paste JSON ─────────────── */}
        {importOpen && !editor && (
          <div style={{ marginBottom: 16, padding: 12, borderRadius: 6, border: "1px solid var(--accent)", background: "var(--surface)" }}>
            <label style={labelStyle}>Import a job definition</label>
            <div style={{ ...helpStyle, marginTop: 0, marginBottom: 10 }}>
              Choose an exported <code>.job.json</code> file, or paste the exported JSON (envelope or bare definition) below.
            </div>
            {importError && <div style={errorBoxStyle}>{importError}</div>}
            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={importing}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "6px 12px",
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  background: "transparent",
                  color: "var(--text)",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: importing ? "default" : "pointer",
                }}
              >
                <Upload size={14} />
                Choose file…
              </button>
            </div>
            <textarea
              style={{ ...inputStyle, fontFamily: "var(--font-mono)", minHeight: 160, resize: "vertical", lineHeight: 1.5 }}
              placeholder='Paste exported JSON here, e.g. {"callboardJobExport":1,...} or a bare {"name":...,"steps":[...]}'
              value={importText}
              spellCheck={false}
              disabled={importing}
              onChange={(e) => {
                setImportText(e.target.value);
                if (importError) setImportError(null);
              }}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 10 }}>
              <button
                onClick={() => {
                  setImportOpen(false);
                  setImportText("");
                  setImportError(null);
                }}
                disabled={importing}
                style={{
                  padding: "6px 12px",
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
                onClick={() => importFromText(importText)}
                disabled={importing || !importText.trim()}
                style={{
                  padding: "6px 12px",
                  borderRadius: 6,
                  border: "none",
                  background: importing || !importText.trim() ? "var(--surface)" : "var(--accent)",
                  color: importing || !importText.trim() ? "var(--text-muted)" : "var(--text-on-accent)",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: importing || !importText.trim() ? "default" : "pointer",
                }}
              >
                {importing ? "Importing…" : "Import from text"}
              </button>
            </div>
          </div>
        )}

        {editor ? (
          <div>
            <div style={{ marginBottom: 12 }}>
              <label style={labelStyle}>{editor.originalId === null ? "New job definition" : `Editing "${editor.originalId}"`}</label>
              <textarea
                style={{ ...inputStyle, fontFamily: "var(--font-mono)", minHeight: 380, resize: "vertical", lineHeight: 1.5 }}
                value={editor.json}
                spellCheck={false}
                onChange={(e) => setEditor({ ...editor, json: e.target.value })}
              />
              <div style={helpStyle}>
                JSON definition — step types: <code>agent</code>, <code>approval</code>, <code>poll</code>, <code>wait_event</code>, <code>gate</code>,{" "}
                <code>notify</code>, <code>parallel</code>. Parallel v1 supports only agent branches (<code>mode</code>: <code>race</code> or <code>all</code>).
                Prompts support <code>{"{{inputs.<key>}}"}</code> and <code>{"{{steps.<id>.outputs.<key>}}"}</code> templating. The server validates on save and
                lists every problem.
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                onClick={() => {
                  setEditor(null);
                  setError(null);
                }}
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
                disabled={saving || !editor.json.trim()}
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
                {saving ? "Saving…" : editor.originalId === null ? "Create job" : "Save changes"}
              </button>
            </div>
          </div>
        ) : loading ? (
          <div style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading…</div>
        ) : jobs.length === 0 ? (
          <div style={{ color: "var(--text-muted)", fontSize: 13 }}>
            No jobs yet. Create one here, or describe a workflow to any chat and ask it to create a job.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {jobs.map((job) => (
              <div key={job.id}>
                <div
                  ref={(el) => {
                    if (el) cardRefs.current.set(job.id, el);
                    else cardRefs.current.delete(job.id);
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "10px 12px",
                    borderRadius: 6,
                    border: `1px solid ${highlightId === job.id ? "var(--accent)" : "var(--border)"}`,
                    background: "var(--surface)",
                    transition: "border-color 0.3s",
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>
                      {job.name}{" "}
                      <span style={{ color: "var(--text-muted)", fontWeight: 400, fontFamily: "var(--font-mono)", fontSize: 11 }}>
                        {job.id} · v{job.version} · {job.steps.length} steps
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {job.description || "(no description)"}
                    </div>
                  </div>
                  <button
                    onClick={() => openSpawn(job)}
                    title="Spawn a run"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                      background: "none",
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      color: "var(--accent)",
                      cursor: "pointer",
                      padding: "4px 10px",
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    <Play size={13} /> Spawn
                  </button>
                  <button
                    onClick={() => handleExport(job.id)}
                    title="Export job definition"
                    style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 4 }}
                  >
                    <Download size={15} />
                  </button>
                  <button
                    onClick={() => {
                      setError(null);
                      setEditor({ originalId: job.id, json: toEditorJson(job) });
                    }}
                    title="Edit job"
                    style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 4 }}
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    onClick={() => handleDelete(job.id)}
                    title="Delete job"
                    style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 4 }}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>

                {/* Inline spawn form */}
                {spawnForm?.jobId === job.id && spawnJobDef && (
                  <div style={{ margin: "8px 0 4px 16px", padding: 12, borderRadius: 6, border: "1px solid var(--accent)", background: "var(--surface)" }}>
                    {(spawnJobDef.inputs ?? []).map((input) => (
                      <div key={input.key} style={{ marginBottom: 10 }}>
                        <label style={labelStyle}>
                          {input.label || input.key}
                          {input.required && <span style={{ color: "var(--danger)" }}> *</span>}
                        </label>
                        {input.type === "text" ? (
                          <textarea
                            style={{ ...inputStyle, minHeight: 80, resize: "vertical" }}
                            value={spawnForm.values[input.key] ?? ""}
                            onChange={(e) => setSpawnForm({ ...spawnForm, values: { ...spawnForm.values, [input.key]: e.target.value } })}
                          />
                        ) : (
                          <input
                            style={inputStyle}
                            value={spawnForm.values[input.key] ?? ""}
                            onChange={(e) => setSpawnForm({ ...spawnForm, values: { ...spawnForm.values, [input.key]: e.target.value } })}
                          />
                        )}
                      </div>
                    ))}
                    {(spawnJobDef.inputs ?? []).length === 0 && <div style={{ ...helpStyle, marginBottom: 10 }}>This job takes no inputs.</div>}
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                      <button
                        onClick={() => setSpawnForm(null)}
                        disabled={saving}
                        style={{
                          padding: "6px 12px",
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
                        onClick={handleSpawn}
                        disabled={saving || (spawnJobDef.inputs ?? []).some((i) => i.required && !(spawnForm.values[i.key] ?? "").trim())}
                        style={{
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
                        {saving ? "Spawning…" : "Spawn run"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Runs ─────────────────────────────────────────────────── */}
      <div style={sectionStyle}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <span style={{ fontSize: 15, fontWeight: 600 }}>Runs</span>
          <button
            onClick={refreshRuns}
            title="Refresh runs"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            <RefreshCw size={13} /> Refresh
          </button>
        </div>

        {runsError && <div style={errorBoxStyle}>{runsError}</div>}

        {runs.length === 0 ? (
          <div style={{ color: "var(--text-muted)", fontSize: 13 }}>No runs yet.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {runs.map((run) => {
              const meta = JOB_RUN_STATUS_META[run.status];
              const expanded = expandedRun === run.runId;
              return (
                <div key={run.runId} style={{ border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface)" }}>
                  <div
                    onClick={() => setExpandedRun(expanded ? null : run.runId)}
                    style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", cursor: "pointer" }}
                  >
                    {expanded ? (
                      <ChevronDown size={14} style={{ color: "var(--text-muted)" }} />
                    ) : (
                      <ChevronRight size={14} style={{ color: "var(--text-muted)" }} />
                    )}
                    <span style={{ fontSize: 13, fontWeight: 600, flexShrink: 0 }}>{run.jobName}</span>
                    <span
                      style={{
                        padding: "1px 8px",
                        borderRadius: 999,
                        fontSize: 11,
                        fontWeight: 600,
                        color: meta.color,
                        border: `1px solid ${meta.color}`,
                        flexShrink: 0,
                      }}
                    >
                      {meta.label}
                    </span>
                    {run.currentStepId && !["succeeded", "cancelled"].includes(run.status) && (
                      <span style={{ fontSize: 12, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        step: {run.currentStepId}
                      </span>
                    )}
                    <span style={{ flex: 1 }} />
                    <span style={{ fontSize: 11, color: "var(--text-muted)", flexShrink: 0 }}>{new Date(run.updatedAt).toLocaleString()}</span>
                  </div>
                  {expanded && (
                    <div style={{ borderTop: "1px solid var(--border)" }}>
                      <JobRunPanel runId={run.runId} compact />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Import conflict modal ───────────────────────────────── */}
      {conflict && (
        <ModalOverlay>
          <div
            style={{
              background: "var(--bg)",
              borderRadius: 8,
              padding: 24,
              width: "90%",
              maxWidth: 440,
              border: "1px solid var(--border)",
            }}
          >
            <h2 style={{ margin: "0 0 16px 0", fontSize: 18 }}>Job already exists</h2>
            <p style={{ margin: "0 0 24px 0", fontSize: 14, color: "var(--text)", lineHeight: 1.4 }}>
              A job with id <code style={{ fontFamily: "var(--font-mono)" }}>{conflict.id}</code> already exists. Import as a copy with a new id, or
              overwrite the existing definition?
            </p>
            <div style={{ display: "flex", gap: 12, justifyContent: "flex-end", flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => setConflict(null)}
                disabled={importing}
                style={{
                  padding: "8px 16px",
                  borderRadius: 6,
                  fontSize: 14,
                  background: "var(--bg-secondary)",
                  border: "1px solid var(--border)",
                  color: "var(--text)",
                  cursor: importing ? "default" : "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => runImport(conflict.payload, "copy")}
                disabled={importing}
                style={{
                  padding: "8px 16px",
                  borderRadius: 6,
                  fontSize: 14,
                  background: "transparent",
                  border: "1px solid var(--accent)",
                  color: "var(--accent)",
                  fontWeight: 600,
                  cursor: importing ? "default" : "pointer",
                }}
              >
                Import as copy
              </button>
              <button
                type="button"
                onClick={() => runImport(conflict.payload, "overwrite")}
                disabled={importing}
                style={{
                  padding: "8px 16px",
                  borderRadius: 6,
                  fontSize: 14,
                  background: "var(--danger)",
                  border: "none",
                  color: "var(--text-on-accent)",
                  fontWeight: 600,
                  cursor: importing ? "default" : "pointer",
                }}
              >
                Overwrite existing
              </button>
            </div>
          </div>
        </ModalOverlay>
      )}
    </div>
  );
}
