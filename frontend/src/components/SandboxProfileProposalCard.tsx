import { useState } from "react";
import { type SandboxProfileProposalCardInput } from "shared/types/index.js";
import { RecipeDiffView, RecipeRiskReview, box, codeStyle, linkBtn, muted, preStyle } from "./SandboxProfileReviewParts";

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

interface Props {
  input: SandboxProfileProposalCardInput;
  agentName: string;
  approveLocked: boolean;
  nonBlocking?: boolean;
  onRespond: (allow: boolean) => void;
}

export default function SandboxProfileProposalCard({ input, agentName, approveLocked, nonBlocking, onRespond }: Props) {
  const [showRecipe, setShowRecipe] = useState(false);
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

        <h4 style={h4}>Review the risky parts</h4>
        <RecipeRiskReview review={input.review} />

        <h4 style={h4}>{input.previous ? `Changes since version ${input.previous.version} (${input.previous.state})` : "New profile"}</h4>
        {input.previous ? (
          <RecipeDiffView before={input.previous.recipe} after={input.recipe} />
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
        {/* Last, after what Callboard computed: a prompt-injected "safe to approve" should not be the first thing read. */}
        {input.note && (
          <div style={noteStyle} data-testid="proposal-note">
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>The agent&apos;s note — its own words, not checked by Callboard:</div>
            <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{input.note}</div>
          </div>
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
const noteStyle: React.CSSProperties = { ...box, borderStyle: "dashed", background: "var(--bg)", fontSize: 13 };
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
