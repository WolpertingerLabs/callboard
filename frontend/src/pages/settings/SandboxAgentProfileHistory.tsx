import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { recipeLineDiff, type SandboxAgentProfileSummary, type SandboxAgentProfileVersion } from "shared/types/index.js";
import { getAgentSandboxProfile } from "../../api";
import { errorMessage } from "../../utils/errorMessage";
import { helpStyle } from "./styles";

const smallButton: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "3px 8px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text)",
  fontSize: 12,
  cursor: "pointer",
};
const preStyle: React.CSSProperties = {
  maxHeight: 280,
  maxWidth: "100%",
  overflow: "auto",
  fontSize: 11,
  background: "var(--code-bg)",
  color: "var(--text)",
  padding: 8,
  borderRadius: 6,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  margin: "4px 0",
  boxSizing: "border-box",
};

const VERSION_STATE_LABELS: Record<string, string> = {
  proposed: "Proposed, not approved",
  approved: "Approved (in force)",
  superseded: "Superseded",
  refused: "Refused",
  withdrawn: "Withdrawn",
};
function versionStateColor(state: string): string {
  return state === "approved" ? "var(--success)" : state === "refused" ? "var(--danger)" : state === "proposed" ? "var(--warning)" : "var(--text-muted)";
}

/** A line diff of two recipes: adds and removes coloured with the diff tokens, a "+ "/"- "/"  " prefix on each line. */
function RecipeDiff({ before, after, testId }: { before: string; after: string; testId: string }) {
  const lines = recipeLineDiff(before, after);
  return (
    <pre style={{ ...preStyle, whiteSpace: "pre", padding: 0 }} data-testid={testId}>
      {lines.map((line, i) => (
        <div
          key={i}
          data-op={line.op}
          style={{
            padding: "0 8px",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            background: line.op === "add" ? "var(--diff-added-bg)" : line.op === "remove" ? "var(--diff-removed-bg)" : "transparent",
            color: line.op === "add" ? "var(--diff-added-text)" : line.op === "remove" ? "var(--diff-removed-text)" : "var(--text)",
          }}
        >
          {line.op === "add" ? "+ " : line.op === "remove" ? "- " : "  "}
          {line.text}
        </div>
      ))}
    </pre>
  );
}

function VersionRow({ profileId, version, previous }: { profileId: string; version: SandboxAgentProfileVersion; previous?: SandboxAgentProfileVersion }) {
  const [show, setShow] = useState<"recipe" | "diff" | null>(null);
  const toggle = (what: "recipe" | "diff") => setShow((current) => (current === what ? null : what));
  const canDiff = version.recipe !== undefined && previous?.recipe !== undefined;
  return (
    <div data-testid={`sandbox-agent-version-${profileId}-${version.version}`} style={{ borderTop: "1px solid var(--border)", padding: "6px 0", minWidth: 0 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 10px", fontSize: 13 }}>
        <strong>v{version.version}</strong>
        <span style={{ color: versionStateColor(version.state) }}>{VERSION_STATE_LABELS[version.state] ?? version.state}</span>
        {version.pending && (
          <span role="status" style={{ fontSize: 12, color: "var(--accent)", border: "1px solid currentColor", borderRadius: 10, padding: "0 6px" }}>
            card open in chat
          </span>
        )}
        <span style={{ color: "var(--text-muted)", fontSize: 12 }}>proposed {new Date(version.proposedAt).toLocaleString()}</span>
        {version.approvedAt ? <span style={{ color: "var(--text-muted)", fontSize: 12 }}>approved {new Date(version.approvedAt).toLocaleString()}</span> : null}
        {version.buildId ? <span style={{ color: "var(--text-muted)", fontSize: 12, wordBreak: "break-all" }}>build {version.buildId}</span> : null}
      </div>
      {version.note ? (
        <div style={{ marginTop: 4, minWidth: 0 }}>
          <p style={{ ...helpStyle, margin: 0 }}>The agent&apos;s note (its own words, unverified):</p>
          <p style={{ fontSize: 12, margin: "2px 0 0 0", whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--text)" }}>{version.note}</p>
        </div>
      ) : null}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
        {version.recipe !== undefined && (
          <button style={smallButton} aria-expanded={show === "recipe"} onClick={() => toggle("recipe")} aria-label={`View the recipe of v${version.version}`}>
            {show === "recipe" ? "Hide recipe" : "View recipe"}
          </button>
        )}
        {canDiff && (
          <button
            style={smallButton}
            aria-expanded={show === "diff"}
            onClick={() => toggle("diff")}
            aria-label={`Diff v${version.version} against v${previous!.version}`}
          >
            {show === "diff" ? "Hide diff" : `Diff vs v${previous!.version}`}
          </button>
        )}
      </div>
      {show === "recipe" && version.recipe !== undefined && <pre style={preStyle}>{version.recipe}</pre>}
      {show === "diff" && canDiff && (
        <RecipeDiff before={previous!.recipe!} after={version.recipe!} testId={`sandbox-agent-diff-${profileId}-${version.version}`} />
      )}
    </div>
  );
}

/**
 * An agent-built profile's kept versions, newest first: each one's state, its
 * build, the agent's note (untrusted: plain text), its recipe and a diff
 * against the previous kept version. Fetched when opened.
 */
export default function SandboxAgentProfileHistory({ name, scope, id }: { name: string; scope: string; id: string }) {
  const [profile, setProfile] = useState<SandboxAgentProfileSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    getAgentSandboxProfile(name, scope).then(
      (detail) => live && setProfile(detail),
      (e) => live && setError(errorMessage(e, `Failed to read the history of profile ${name}`)),
    );
    return () => {
      live = false;
    };
  }, [name, scope]);
  if (error)
    return (
      <p role="alert" style={{ ...helpStyle, color: "var(--danger)" }}>
        {error}
      </p>
    );
  if (!profile)
    return (
      <p style={{ ...helpStyle, display: "flex", alignItems: "center", gap: 6 }}>
        <Loader2 size={12} className="spin" /> Loading the history…
      </p>
    );
  const versions = [...profile.versions].sort((a, b) => b.version - a.version);
  return (
    <div data-testid={`sandbox-agent-history-${id}`} style={{ marginTop: 8, minWidth: 0 }}>
      <p style={{ ...helpStyle, margin: "0 0 4px 0" }}>
        {versions.length} version{versions.length === 1 ? "" : "s"} kept, newest first. Each was proposed by an agent; only an approved one is ever built.
      </p>
      {versions.map((version, i) => (
        <VersionRow key={version.version} profileId={id} version={version} previous={versions[i + 1]} />
      ))}
    </div>
  );
}
