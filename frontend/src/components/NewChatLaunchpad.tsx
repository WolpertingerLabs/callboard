import { useCallback, useState } from "react";
import { Link } from "react-router-dom";
import { Sparkles, Workflow, Play, Star, ChevronLeft, AlertCircle } from "lucide-react";
import { spawnJob, type JobDefinition } from "../api";
import type { ResolvedFavorites } from "../hooks/useResolvedFavorites";
import JobRunPanel from "./JobRunPanel";
import JobSpawnForm from "./JobSpawnForm";
import { MIN_TAP_TARGET } from "./SessionInfoNav";

interface Props {
  /**
   * Put a command in the composer (the string already includes its trailing
   * space). The parent *prefixes* rather than overwrites — anything already
   * typed becomes the command's argument. See `Chat.tsx`'s
   * `insertCommandPrompt`.
   */
  onInsertPrompt: (value: string) => void;
  /** Fallback content when nothing is favorited yet. */
  slashCommands: string[];
  /** Open the full slash-commands modal. */
  onOpenCommands: () => void;
  /**
   * Owned by the parent, not fetched here — `SessionInfoNav` next door has to
   * know which of these modes won so it can drop its duplicate Commands pill,
   * and the only place that can know without a child-to-parent effect is the
   * component that renders both.
   */
  favorites: ResolvedFavorites;
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
  // These are the screen's primary call to action and they are pressed with a
  // thumb as often as a mouse — see MIN_TAP_TARGET.
  padding: "10px 12px",
  minHeight: MIN_TAP_TARGET,
  boxSizing: "border-box",
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
 * The card's inline actions — Retry, and Unpin on the stale note.
 *
 * Same floor as everything else here, for the same reason (MIN_TAP_TARGET):
 * measured 41×14 at 390px otherwise. The negative vertical margin keeps the
 * note the height a line of 12px text is, so the target grows into the 12px
 * gap above the note rather than pushing the card open.
 */
const inlineActionStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--accent-text)",
  fontSize: 12,
  cursor: "pointer",
  padding: "0 6px",
  margin: "-12px -6px",
  minHeight: MIN_TAP_TARGET,
  display: "inline-flex",
  alignItems: "center",
};

/** One form is open at a time, so one id serves every chip's `aria-controls`. */
const SPAWN_FORM_ID = "launchpad-job-spawn-form";

/** Which of the launchpad's shapes a given set of favorites produces. */
export type LaunchpadMode = "hidden" | "error" | "commands" | "hint" | "favorites";

/**
 * Decide the mode from the resolved favorites — exported so `Chat.tsx` can ask
 * the same question `SessionInfoNav` needs the answer to (does the launchpad
 * already have a Commands grid on screen?) without the launchpad reporting it
 * upward through an effect.
 */
export function launchpadMode(favorites: ResolvedFavorites, slashCommands: string[]): LaunchpadMode {
  // Nothing renders while unsettled. Not a skeleton: what is coming might be
  // the commands grid, and a placeholder shaped like the favorites card would
  // be a promise we cannot keep. See `useResolvedFavorites`.
  if (!favorites.settled) return "hidden";
  // Whatever resolved is worth showing even if the other half failed — one
  // side's error is not a reason to hide the side that worked. The card
  // carries the note inline in that case.
  if (favorites.skills.length > 0 || favorites.jobs.length > 0) return "favorites";
  if (favorites.error) return "error";
  // Nothing starred and nothing to fall back on. This used to be "hidden",
  // which put the feature's only in-app pointer — the "star something in
  // Settings" line, which lived inside the commands grid — behind having slash
  // commands. A fresh install has neither, so the one user who has to be told
  // this feature exists was the one user guaranteed never to see it. The hint
  // stands on its own.
  return slashCommands.length > 0 ? "commands" : "hint";
}

/**
 * The favorites launchpad on the new-chat welcome screen: the starred skills
 * and jobs, one click from being used.
 *
 * ## Why the two halves behave differently
 *
 * A skill chip **puts `/callboard:<name> ` in the composer** and stops there.
 * Skills almost always take an argument ("release-notes for v2"), and even when
 * they don't, the user is about to type the rest of the message anyway —
 * sending on click would discard the message they came here to write.
 *
 * Which is also why it prefixes rather than sets. A chip clicked over a typed
 * message used to overwrite it, discarding exactly what not-sending was meant
 * to protect; now the message becomes the command's argument. The parent owns
 * that — it has the command list the composer parses against. See `Chat.tsx`'s
 * `insertCommandPrompt`.
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
 *
 * ## The card is decided on what RESOLVES, never on the ids
 *
 * A favorite naming a renamed skill is the normal case. Gating the card on "the
 * user has favorites" and its body on "those favorites resolve" is how you get
 * a Quick start header with nothing under it, permanently, and no commands
 * fallback either. `launchpadMode` asks the resolved question once.
 */
export default function NewChatLaunchpad({ onInsertPrompt, slashCommands, onOpenCommands, favorites }: Props) {
  // Which favorited job's spawn form is open, plus the values typed into it.
  const [spawnForm, setSpawnForm] = useState<{ jobId: string; values: Record<string, string> } | null>(null);
  const [spawning, setSpawning] = useState(false);
  const [spawnError, setSpawnError] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  const openSpawn = useCallback((job: JobDefinition) => {
    setSpawnError(null);
    const values: Record<string, string> = {};
    for (const input of job.inputs ?? []) {
      if (input.default !== undefined) values[input.key] = input.default;
    }
    setSpawnForm({ jobId: job.id, values });
  }, []);

  const spawnJobDef = spawnForm ? favorites.jobs.find((j) => j.id === spawnForm.jobId) : null;

  /**
   * Close a form whose job stopped resolving — unstarred from Settings in
   * another tab, or deleted outright.
   *
   * Explicitly, rather than leaving `spawnForm` set and letting the render
   * collapse on the missing definition: that state still holds a half-filled
   * form's worth of values and an `aria-expanded` chip, and it survives until
   * something else happens to clear it — so re-starring the job re-opens a form
   * the user had moved on from.
   *
   * Adjusted during render rather than in an effect, which is React's own
   * prescription for state that is stale with respect to a prop: the re-render
   * happens before anything commits, so nothing ever paints the closed-over
   * form.
   *
   * Gated on `jobsResolved`, not on `settled`. `settled` includes "the job
   * catalog failed", and a job whose re-read failed has gone exactly as far as
   * one still being re-read: nowhere. Clearing on it threw away a half-filled
   * form — the typed values, no undo — because a request lost the network,
   * which is the same class of bug as the commit this guard shipped in.
   */
  if (spawnForm && favorites.jobsResolved && !spawnJobDef) {
    setSpawnForm(null);
    setSpawnError(null);
  }

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

  const mode = launchpadMode(favorites, slashCommands);

  if (mode === "hidden") return null;

  const errorNote = favorites.error && (
    <div style={{ fontSize: 12, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6, marginTop: mode === "error" ? 0 : 12 }}>
      <AlertCircle size={13} />
      <span>{favorites.error}</span>
      <button onClick={favorites.retry} style={inlineActionStyle}>
        Retry
      </button>
    </div>
  );

  /**
   * Some favorite named something that no longer exists.
   *
   * Renaming a starred skill is the ordinary way to get here, and before this
   * the chip simply stopped being drawn: no error, no gap, nothing to tell the
   * user whether the star failed to save or the thing it named moved.
   *
   * It has to name them and it has to offer the undo. A bare count is a
   * permanent complaint about something the user cannot find: the skill exists
   * only under its new name, so there is no row left in Settings carrying a
   * star to un-set, and the note would sit there for the life of the install.
   * Un-pinning here is a deliberate user action on named ids — the *write* path
   * still never prunes by itself (see `AgentSettings.favoriteSkills`), because
   * a briefly unreadable catalog must not cost anyone their list.
   */
  const missingIds = [...favorites.missingSkills, ...favorites.missingJobs];
  const staleNote = missingIds.length > 0 && (
    <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 12, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      <span>
        {missingIds.length} pinned item{missingIds.length === 1 ? "" : "s"} no longer exist{missingIds.length === 1 ? "s" : ""}:{" "}
        <span style={{ fontFamily: "var(--font-mono)" }}>{missingIds.join(", ")}</span>.
      </span>
      <button onClick={favorites.dropMissing} style={inlineActionStyle}>
        {missingIds.length === 1 ? "Unpin it" : "Unpin them"}
      </button>
    </div>
  );

  const settingsHint = (
    <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: mode === "hint" ? 0 : 12, display: "flex", alignItems: "center", gap: 4 }}>
      <Star size={12} />
      Star a skill or job in{" "}
      <Link to="/settings/skills" style={{ color: "var(--accent-text)" }}>
        Settings
      </Link>{" "}
      to pin it here.
    </div>
  );

  // A read failed and nothing resolved. Say so and offer the retry, rather than
  // rendering the "nothing starred" fallback — which would claim, about the one
  // thing the user cannot check from here, something we do not know to be true.
  // The stale note still belongs here too: one catalog failing is exactly when
  // the *other* one's favorites can be stale, and dropping it in this branch
  // hid it in the only case where both facts are true at once.
  if (mode === "error") {
    return (
      <div style={cardStyle}>
        {errorNote}
        {staleNote}
      </div>
    );
  }

  // Nothing starred yet — keep the old "Available Commands" grid so this card
  // is never empty, and say where the stars are. The grid is the discovery
  // surface it always was; the hint is what turns it into an onboarding step.
  if (mode === "commands") {
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
        {settingsHint}
        {staleNote}
      </div>
    );
  }

  // No favorites and no commands either — a bare checkout on a fresh install.
  // The hint is the whole card. See `launchpadMode`.
  if (mode === "hint") {
    return (
      <div style={cardStyle}>
        {settingsHint}
        {staleNote}
      </div>
    );
  }

  const { skills: pinnedSkills, jobs: pinnedJobs } = favorites;

  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div style={{ fontSize: 13, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
          <Star size={14} />
          Quick start
        </div>
        {/* Whichever tab holds what they actually pinned. Skills is the
            default and the tie-break; a user who starred only jobs was being
            sent to a skills tab with nothing of theirs on it.

            It is also this card's only navigation, and it measured 43×14 at
            390px while every button beside it took the floor — see
            MIN_TAP_TARGET. Padding rather than type size: it is deliberately
            the quiet control on a card whose chips are the loud ones. The
            negative margins keep the row the height it was — the target grows
            into the card's own padding (20px above, the header's 14px gap
            below), so nothing below it moves and nothing overlaps. */}
        <Link
          to={pinnedSkills.length === 0 && pinnedJobs.length > 0 ? "/settings/jobs" : "/settings/skills"}
          style={{
            fontSize: 12,
            color: "var(--text-muted)",
            display: "inline-flex",
            alignItems: "center",
            minHeight: MIN_TAP_TARGET,
            padding: "0 8px",
            margin: "-12px -8px",
          }}
        >
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
                  // The chip is a disclosure, and the border colour it used to
                  // carry that in is invisible to anything that is not a pair
                  // of eyes.
                  aria-expanded={open}
                  // Only while open — the id it names does not exist otherwise.
                  aria-controls={open ? SPAWN_FORM_ID : undefined}
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
            <JobSpawnForm
              id={SPAWN_FORM_ID}
              job={spawnJobDef}
              values={spawnForm.values}
              onChange={(values) => setSpawnForm({ ...spawnForm, values })}
              onSubmit={handleSpawn}
              onCancel={() => setSpawnForm(null)}
              submitting={spawning}
              submitLabel="Run job"
              submittingLabel="Starting…"
              submitIcon={<Play size={13} />}
              error={spawnError}
              style={{ marginTop: 12, padding: 14, borderRadius: 8 }}
              header={
                <>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>Run {spawnJobDef.name}</div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: (spawnJobDef.inputs ?? []).length > 0 ? 12 : 10 }}>
                    {spawnJobDef.description || "This job runs independently of the chat you are about to start."}
                  </div>
                </>
              }
            />
          )}
        </div>
      )}

      {/* One half loaded and the other did not. The chips above are real; this
          says the list is incomplete, which is the part they cannot show. */}
      {errorNote}
      {staleNote}
    </div>
  );
}
