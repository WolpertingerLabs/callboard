import { useState } from "react";
import { recipeLineDiff, type SandboxProfileProposalCardInput } from "shared/types/index.js";

/**
 * The card a human answers to approve and build a Sandbox desktop profile an
 * agent proposed (`SANDBOX_PROFILE_PROPOSE_TOOL_NAME`). Everything on it but
 * the note is the host's: the validated canonical recipe and what Callboard
 * computed from it. The risky parts are surfaced first — the setup script,
 * the hosts the build downloads from, the packages, the limits — and the
 * agent's note is boxed and labelled as its own words.
 *
 * Every string here is rendered as React text (escaped), never as HTML or
 * markdown: the name, description, script and note were all written by an
 * agent, possibly a prompt-injected one.
 */
type Review = SandboxProfileProposalCardInput["review"];
type Limits = Review["limits"];

const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter(isStr) : []);
const limitsOf = (v: unknown): Limits | undefined => {
  const l = v as Record<string, unknown> | undefined;
  return l && ["cpus", "memoryMb", "homeMb", "sessionMinutes"].every((k) => isNum(l[k]))
    ? { cpus: l.cpus as number, memoryMb: l.memoryMb as number, homeMb: l.homeMb as number, sessionMinutes: l.sessionMinutes as number }
    : undefined;
};

/** The card's input, checked field by field: `input` is an opaque record on the wire. Undefined if it is not a proposal card. */
export function promptProfileProposal(input: Record<string, unknown> | undefined): SandboxProfileProposalCardInput | undefined {
  if (!input || !isStr(input.name) || !isNum(input.version) || !isStr(input.digest) || !isStr(input.recipe)) return undefined;
  const scope = input.scope as Record<string, unknown> | undefined;
  const review = input.review as Record<string, unknown> | undefined;
  if (!scope || (scope.kind !== "workspace" && scope.kind !== "folder") || !isStr(scope.key) || !isStr(scope.label) || !review) return undefined;
  const limits = limitsOf(review.limits);
  const caps = limitsOf(review.caps);
  if (!limits || !caps) return undefined;
  const previous = input.previous as Record<string, unknown> | undefined;
  const downloads = (Array.isArray(review.downloads) ? review.downloads : [])
    .map((d) => d as Record<string, unknown>)
    .filter((d) => isStr(d.host) && isStr(d.url) && isStr(d.sha256) && isStr(d.dest) && isStr(d.unpack))
    .map((d) => ({ host: d.host as string, url: d.url as string, sha256: d.sha256 as string, dest: d.dest as string, unpack: d.unpack as string }));
  const requested = (review.requested ?? {}) as Record<string, unknown>;
  const env = review.env && typeof review.env === "object" ? Object.entries(review.env as Record<string, unknown>).filter(([, v]) => isStr(v)) : [];
  return {
    name: input.name,
    version: input.version,
    digest: input.digest,
    scope: { kind: scope.kind, key: scope.key, label: scope.label },
    recipe: input.recipe,
    ...(previous && isNum(previous.version) && isStr(previous.recipe) && isStr(previous.digest) && isStr(previous.state)
      ? { previous: { version: previous.version, digest: previous.digest, state: previous.state as never, recipe: previous.recipe } }
      : {}),
    ...(isStr(input.note) && input.note ? { note: input.note } : {}),
    review: {
      description: isStr(review.description) ? review.description : "",
      setup: isStr(review.setup) ? review.setup : "",
      setupLines: isNum(review.setupLines) ? review.setupLines : 0,
      downloads,
      hosts: strs(review.hosts),
      packages: strs(review.packages),
      gl: review.gl === "software" ? "software" : "none",
      architectures: strs(review.architectures),
      requested: Object.fromEntries(["cpus", "memoryMb", "homeMb", "sessionMinutes"].filter((k) => isNum(requested[k])).map((k) => [k, requested[k]])),
      limits,
      ...(Array.isArray(review.clamped) ? { clamped: strs(review.clamped) as (keyof Limits)[] } : {}),
      caps,
      path: strs(review.path),
      env: Object.fromEntries(env) as Record<string, string>,
    },
  };
}

const mb = (value: number) => (value >= 1024 && value % 1024 === 0 ? `${value / 1024} GiB` : `${value} MiB`);
const LIMIT_LABELS: Record<keyof Limits, string> = { cpus: "CPUs", memoryMb: "Memory", homeMb: "Home (tmpfs)", sessionMinutes: "Session" };
const formatLimit = (key: keyof Limits, value: number) => (key === "cpus" ? String(value) : key === "sessionMinutes" ? `${value} min` : mb(value));

interface Props {
  input: SandboxProfileProposalCardInput;
  agentName: string;
  approveLocked: boolean;
  nonBlocking?: boolean;
  onRespond: (allow: boolean) => void;
}

export default function SandboxProfileProposalCard({ input, agentName, approveLocked, nonBlocking, onRespond }: Props) {
  const [showRecipe, setShowRecipe] = useState(false);
  const [showPackages, setShowPackages] = useState(input.review.packages.length <= 12);
  const { review } = input;
  const diff = input.previous ? recipeLineDiff(input.previous.recipe, input.recipe) : undefined;
  const unchanged = diff ? diff.every((line) => line.op === "same") : false;
  return (
    <div style={panelStyle} data-testid="profile-proposal-card">
      <strong>Approve and build a Sandbox desktop profile?</strong>
      <div style={scrollArea}>
        <p style={{ margin: "6px 0" }}>
          {agentName} proposes the <strong>agent-built</strong> profile <code style={codeStyle}>{input.name}</code>, version {input.version}
          {input.previous ? ` (replacing version ${input.previous.version})` : " (a new profile)"}. Approving builds it now; the agent can then ask to start
          sessions on it, each needing your consent again. Nothing is built unless you approve, and only this exact recipe (sha256{" "}
          <code style={codeStyle}>{input.digest.slice(0, 16)}…</code>).
        </p>
        <p style={{ margin: "6px 0" }} data-testid="proposal-scope">
          <strong>Scope:</strong> {input.scope.kind === "workspace" ? "this chat's workspace" : "this chat's folder"} — {input.scope.label}. Chats there can use
          it; it stays labelled agent-built until you promote it to global in Settings.
        </p>
        {input.note && (
          <div style={noteStyle} data-testid="proposal-note">
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>The agent&apos;s note — its own words, not checked by Callboard:</div>
            <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{input.note}</div>
          </div>
        )}

        <h4 style={h4}>Review the risky parts</h4>
        <div style={dangerBox} data-testid="proposal-setup">
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            Setup script{review.setup ? ` (${review.setupLines} line${review.setupLines === 1 ? "" : "s"})` : ""} — runs at build time as the desktop user, with
            no network
          </div>
          {review.setup ? <pre style={preStyle}>{review.setup}</pre> : <div style={muted}>No setup script.</div>}
        </div>
        <div style={box} data-testid="proposal-downloads">
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            Downloads:{" "}
            {review.downloads.length ? `${review.downloads.length} file${review.downloads.length === 1 ? "" : "s"} from ${review.hosts.join(", ")}` : "none"}
          </div>
          {review.downloads.length > 0 && (
            <>
              <div style={muted}>Callboard&apos;s host fetches these over https, and keeps a file only if its SHA-256 matches the pin below.</div>
              <ul style={listStyle}>
                {review.downloads.map((d) => (
                  <li key={d.dest} style={{ wordBreak: "break-all" }}>
                    <code style={codeStyle}>{d.url}</code> → /opt/{d.dest} ({d.unpack}), sha256 <code style={codeStyle}>{d.sha256}</code>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
        <div style={box} data-testid="proposal-packages">
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            Debian packages: {review.packages.length} — installed as root at build time (their maintainer scripts run as root)
          </div>
          {review.packages.length > 0 &&
            (showPackages ? (
              <div style={{ wordBreak: "break-word", fontFamily: "var(--font-mono)", fontSize: 12 }}>{review.packages.join(" ")}</div>
            ) : (
              <button type="button" style={linkBtn} onClick={() => setShowPackages(true)}>
                Show all {review.packages.length}
              </button>
            ))}
        </div>
        <div style={box} data-testid="proposal-limits">
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Limits a session gets (asked for → after this Callboard&apos;s caps)</div>
          <div style={limitGrid}>
            {(Object.keys(LIMIT_LABELS) as (keyof Limits)[]).map((key) => (
              <div key={key} style={{ minWidth: 0 }}>
                {LIMIT_LABELS[key]}: {review.requested[key] !== undefined ? formatLimit(key, review.requested[key]!) : "default"} →{" "}
                <strong>{formatLimit(key, review.limits[key])}</strong>
                {review.clamped?.includes(key) ? <span style={{ color: "var(--warning)" }}> (capped at {formatLimit(key, review.caps[key])})</span> : null}
              </div>
            ))}
          </div>
          <div style={muted}>The home is in memory: its files count toward the memory limit.</div>
        </div>
        <div style={box}>
          <div>
            <strong>Architectures:</strong> {review.architectures.length ? review.architectures.join(", ") : "any"} · <strong>OpenGL:</strong>{" "}
            {review.gl === "software" ? "software (Mesa llvmpipe)" : "none"}
          </div>
          {(review.path.length > 0 || Object.keys(review.env).length > 0) && (
            <div style={{ ...muted, wordBreak: "break-word" }}>
              {review.path.length > 0 && <>PATH adds {review.path.join(":")}. </>}
              {Object.keys(review.env).length > 0 && <>Variables: {Object.keys(review.env).join(", ")}.</>}
            </div>
          )}
        </div>

        <h4 style={h4}>{input.previous ? `Changes since version ${input.previous.version} (${input.previous.state})` : "New profile"}</h4>
        {diff ? (
          unchanged ? (
            <div style={muted}>The recipe is identical to version {input.previous!.version}: approving rebuilds it.</div>
          ) : (
            <pre style={{ ...preStyle, padding: 0 }} data-testid="proposal-diff">
              {diff.map((line, i) => (
                <div
                  key={i}
                  style={{
                    padding: "0 8px",
                    background: line.op === "add" ? "var(--diff-added-bg)" : line.op === "remove" ? "var(--diff-removed-bg)" : undefined,
                    color: line.op === "add" ? "var(--diff-added-text)" : line.op === "remove" ? "var(--diff-removed-text)" : undefined,
                  }}
                >
                  {line.op === "add" ? "+ " : line.op === "remove" ? "- " : "  "}
                  {line.text}
                </div>
              ))}
            </pre>
          )
        ) : (
          <div style={muted}>There is no earlier version of {input.name} in this scope.</div>
        )}
        <button type="button" style={linkBtn} onClick={() => setShowRecipe((v) => !v)} aria-expanded={showRecipe}>
          {showRecipe ? "Hide" : "Show"} the full canonical recipe
        </button>
        {showRecipe && <pre style={preStyle}>{input.recipe}</pre>}
        {nonBlocking && (
          <p style={{ ...muted, marginTop: 8 }}>
            {agentName} isn&apos;t waiting on this: it will be told your answer. The card stays until you answer it, or it is withdrawn by Stop, a permission
            change, archiving the chat, or removing the profile in Settings.
          </p>
        )}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", flexShrink: 0 }}>
        <button onClick={() => !approveLocked && onRespond(true)} disabled={approveLocked} style={allowBtn}>
          Approve &amp; build
        </button>
        <button onClick={() => onRespond(false)} style={denyBtn}>
          Refuse
        </button>
      </div>
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  padding: "12px 16px",
  borderTop: "1px solid var(--border)",
  background: "var(--surface)",
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
  maxHeight: "70vh",
  minWidth: 0,
};
const scrollArea: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  minHeight: 0,
  marginBottom: 8,
  WebkitOverflowScrolling: "touch",
  fontSize: 14,
  minWidth: 0,
};
const h4: React.CSSProperties = { margin: "12px 0 6px 0", fontSize: 14 };
const muted: React.CSSProperties = { fontSize: 12, color: "var(--text-muted)" };
const box: React.CSSProperties = { border: "1px solid var(--border)", borderRadius: 6, padding: "6px 10px", margin: "6px 0", minWidth: 0 };
const dangerBox: React.CSSProperties = { ...box, border: "1px solid var(--danger-border)", background: "var(--danger-bg)" };
const noteStyle: React.CSSProperties = { ...box, borderStyle: "dashed", background: "var(--bg)", fontSize: 13 };
const listStyle: React.CSSProperties = { margin: "4px 0 0 0", paddingLeft: 18, fontSize: 12 };
const codeStyle: React.CSSProperties = { fontSize: 12, wordBreak: "break-all" };
const limitGrid: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 4, fontSize: 13 };
const preStyle: React.CSSProperties = {
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "8px 10px",
  fontSize: 12,
  overflow: "auto",
  maxHeight: 260,
  maxWidth: "100%",
  margin: "4px 0",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};
const linkBtn: React.CSSProperties = { background: "transparent", border: "none", color: "var(--accent)", cursor: "pointer", padding: "2px 0", fontSize: 13 };
const allowBtn: React.CSSProperties = {
  background: "var(--accent)",
  color: "var(--text-on-accent)",
  padding: "8px 20px",
  borderRadius: 6,
  fontSize: 14,
  fontWeight: 500,
};
const denyBtn: React.CSSProperties = {
  background: "var(--danger-solid)",
  color: "var(--text-on-danger)",
  padding: "8px 20px",
  borderRadius: 6,
  fontSize: 14,
  fontWeight: 500,
};
