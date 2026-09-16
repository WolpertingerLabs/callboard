import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Sparkles, Workflow, Play, Star, ChevronLeft } from "lucide-react";
import { listCustomSkills, listJobs, spawnJob, type CustomSkillListItem, type JobDefinition } from "../api";
import { useFavorites, orderByFavorites } from "../utils/favorites";
import JobRunPanel from "./JobRunPanel";

interface Props {
  /** Drop text into the composer (already includes its trailing space). */
  onInsertPrompt: (value: string) => void;
  /** Fallback content when nothing is favorited yet. */
  slashCommands: string[];
  /** Open the full slash-commands modal. */
  onOpenCommands: () => void;
}

const cardStyle: React.CSSProperties = {
  background: "var(--bg-secondary)",
  borderRadius: 12,
  padding: "20px 24px",
  marginBottom: 16,
};

const chipStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: "8px 12px",
  fontSize: 13,
  color: "var(--text)",
  cursor: "pointer",
  textAlign: "left",
  maxWidth: "100%",
};

const groupLabelStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: 12,
  fontWeight: 600,
  color: "var(--text-muted)",
  marginBottom: 8,
};

/**
 * The favorites launchpad on the new-chat welcome screen: the starred skills
 * and jobs, one click from being used.
 *
 * ## Why the two halves behave differently
 *
 * A skill chip **fills the composer** with `/callboard:<name> ` and stops
 * there. Skills almost always take an argument ("release-notes for v2"), and
 * even when they don't, the user is about to type the rest of the message
 * anyway — sending on click would discard the message they came here to write.
 *
 * A job chip **opens an inline form and waits for a second click**, because
 * spawning a job is an irreversible side effect that starts real sessions and
 * spends real tokens. That second click is required even for a job with no
 * inputs, where the form is nothing but a confirm button — the point is the
 * confirmation, not the fields.
 *
 * After a successful spawn the launchpad hands its space to the run panel. The
 * new-chat screen has nowhere else to put a run (there is no `/jobs/:runId`
 * route, and the run has no chat of its own to navigate to), and the run is now
 * the only thing the user is waiting on.
 */
export default function NewChatLaunchpad({ onInsertPrompt, slashCommands, onOpenCommands }: Props) {
  const favoriteSkills = useFavorites("skills");
  const favoriteJobs = useFavorites("jobs");
  const [skills, setSkills] = useState<CustomSkillListItem[]>([]);
  const [jobs, setJobs] = useState<JobDefinition[]>([]);
  // Which favorited job's spawn form is open, plus the values typed into it.
  const [spawnForm, setSpawnForm] = useState<{ jobId: string; values: Record<string, string> } | null>(null);
  const [spawning, setSpawning] = useState(false);
  const [spawnError, setSpawnError] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  const hasSkillFavorites = favoriteSkills.favorites.length > 0;
  const hasJobFavorites = favoriteJobs.favorites.length > 0;

  // Only fetch the catalog a side actually needs. A user who stars skills but
  // no jobs pays for one request, not two, on every new-chat open.
  useEffect(() => {
    if (!hasSkillFavorites) return;
    let cancelled = false;
    listCustomSkills()
      .then((result) => !cancelled && setSkills(result))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [hasSkillFavorites]);

  useEffect(() => {
    if (!hasJobFavorites) return;
    let cancelled = false;
    listJobs()
      .then((result) => !cancelled && setJobs(result))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [hasJobFavorites]);

  const pinnedSkills = useMemo(() => orderByFavorites(skills, favoriteSkills.favorites, (s) => s.name), [skills, favoriteSkills.favorites]);
  const pinnedJobs = useMemo(() => orderByFavorites(jobs, favoriteJobs.favorites, (j) => j.id), [jobs, favoriteJobs.favorites]);

  const openSpawn = useCallback((job: JobDefinition) => {
    setSpawnError(null);
    const values: Record<string, string> = {};
    for (const input of job.inputs ?? []) {
      if (input.default !== undefined) values[input.key] = input.default;
    }
    setSpawnForm({ jobId: job.id, values });
  }, []);

  const spawnJobDef = spawnForm ? pinnedJobs.find((j) => j.id === spawnForm.jobId) : null;

  const handleSpawn = async () => {
    if (!spawnForm) return;
    setSpawning(true);
    setSpawnError(null);
    try {
      const run = await spawnJob(spawnForm.jobId, spawnForm.values);
      setSpawnForm(null);
      setActiveRunId(run.runId);
    } catch (err: any) {
      setSpawnError(err.message);
    } finally {
      setSpawning(false);
    }
  };

  if (activeRunId) {
    return (
      <div style={cardStyle}>
        <button
          onClick={() => setActiveRunId(null)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            background: "none",
            border: "none",
            color: "var(--text-muted)",
            fontSize: 12,
            cursor: "pointer",
            padding: 0,
            marginBottom: 12,
          }}
        >
          <ChevronLeft size={14} /> Back to quick start
        </button>
        <JobRunPanel runId={activeRunId} compact />
      </div>
    );
  }

  // Nothing starred yet — keep the old "Available Commands" grid so this card
  // is never empty, and say where the stars are. The grid is the discovery
  // surface it always was; the hint is what turns it into an onboarding step.
  if (!hasSkillFavorites && !hasJobFavorites) {
    if (slashCommands.length === 0) return null;
    return (
      <div style={cardStyle}>
        <div style={groupLabelStyle}>Available Commands</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {slashCommands.slice(0, 8).map((cmd) => (
            <button key={cmd} onClick={() => onInsertPrompt(`/${cmd} `)} style={{ ...chipStyle, color: "var(--accent-text)", fontFamily: "var(--font-mono)" }}>
              {cmd}
            </button>
          ))}
          {slashCommands.length > 8 && (
            <button onClick={onOpenCommands} style={{ ...chipStyle, color: "var(--text-muted)" }}>
              +{slashCommands.length - 8} more
            </button>
          )}
        </div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 12, display: "flex", alignItems: "center", gap: 4 }}>
          <Star size={12} />
          Star a skill or job in{" "}
          <Link to="/settings/skills" style={{ color: "var(--accent-text)" }}>
            Settings
          </Link>{" "}
          to pin it here.
        </div>
      </div>
    );
  }

  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div style={{ fontSize: 13, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
          <Star size={14} />
          Quick start
        </div>
        <Link to="/settings/skills" style={{ fontSize: 12, color: "var(--text-muted)" }}>
          Manage
        </Link>
      </div>

      {pinnedSkills.length > 0 && (
        <div style={{ marginBottom: pinnedJobs.length > 0 ? 16 : 0 }}>
          <div style={groupLabelStyle}>
            <Sparkles size={13} />
            Skills
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {pinnedSkills.map((skill) => (
              <button
                key={skill.name}
                onClick={() => onInsertPrompt(`/callboard:${skill.name} `)}
                title={skill.description || undefined}
                style={chipStyle}
              >
                <Sparkles size={13} style={{ color: "var(--accent-text)", flexShrink: 0 }} />
                <span style={{ fontFamily: "var(--font-mono)", color: "var(--accent-text)" }}>{skill.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {pinnedJobs.length > 0 && (
        <div>
          <div style={groupLabelStyle}>
            <Workflow size={13} />
            Jobs
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {pinnedJobs.map((job) => {
              const open = spawnForm?.jobId === job.id;
              return (
                <button
                  key={job.id}
                  onClick={() => (open ? setSpawnForm(null) : openSpawn(job))}
                  title={job.description || undefined}
                  style={{
                    ...chipStyle,
                    borderColor: open ? "var(--accent)" : "var(--border)",
                  }}
                >
                  <Play size={12} style={{ color: "var(--accent-text)", flexShrink: 0 }} />
                  <span>{job.name}</span>
                  <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                    {job.steps.length} step{job.steps.length === 1 ? "" : "s"}
                  </span>
                </button>
              );
            })}
          </div>

          {spawnForm && spawnJobDef && (
            <div style={{ marginTop: 12, padding: 14, borderRadius: 8, border: "1px solid var(--accent)", background: "var(--surface)" }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>Run {spawnJobDef.name}</div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: (spawnJobDef.inputs ?? []).length > 0 ? 12 : 10 }}>
                {spawnJobDef.description || "This job runs independently of the chat you are about to start."}
              </div>
              {(spawnJobDef.inputs ?? []).map((input) => (
                <div key={input.key} style={{ marginBottom: 10 }}>
                  <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                    {input.label || input.key}
                    {input.required && <span style={{ color: "var(--danger)" }}> *</span>}
                  </label>
                  {input.type === "text" ? (
                    <textarea
                      value={spawnForm.values[input.key] ?? ""}
                      onChange={(e) => setSpawnForm({ ...spawnForm, values: { ...spawnForm.values, [input.key]: e.target.value } })}
                      style={{
                        width: "100%",
                        minHeight: 64,
                        padding: "8px 10px",
                        borderRadius: 6,
                        border: "1px solid var(--border)",
                        background: "var(--bg)",
                        color: "var(--text)",
                        fontSize: 13,
                        boxSizing: "border-box",
                        resize: "vertical",
                      }}
                    />
                  ) : (
                    <input
                      value={spawnForm.values[input.key] ?? ""}
                      onChange={(e) => setSpawnForm({ ...spawnForm, values: { ...spawnForm.values, [input.key]: e.target.value } })}
                      style={{
                        width: "100%",
                        padding: "8px 10px",
                        borderRadius: 6,
                        border: "1px solid var(--border)",
                        background: "var(--bg)",
                        color: "var(--text)",
                        fontSize: 13,
                        boxSizing: "border-box",
                      }}
                    />
                  )}
                </div>
              ))}
              {spawnError && (
                <div
                  style={{
                    padding: "8px 12px",
                    borderRadius: 6,
                    background: "var(--danger-bg)",
                    border: "1px solid var(--danger-border)",
                    color: "var(--danger)",
                    fontSize: 12,
                    marginBottom: 10,
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {spawnError}
                </div>
              )}
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button
                  onClick={() => setSpawnForm(null)}
                  disabled={spawning}
                  style={{
                    padding: "7px 14px",
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
                  disabled={spawning || (spawnJobDef.inputs ?? []).some((i) => i.required && !(spawnForm.values[i.key] ?? "").trim())}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "7px 14px",
                    borderRadius: 6,
                    border: "none",
                    background: spawning ? "var(--surface)" : "var(--accent)",
                    color: spawning ? "var(--text-muted)" : "var(--text-on-accent)",
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: spawning ? "default" : "pointer",
                  }}
                >
                  <Play size={13} />
                  {spawning ? "Starting…" : "Run job"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
