import { useState } from "react";
import { foldRecipeDiff, recipeReviewDiff, type RecipeDiffLine, type SandboxProfileProposalCardInput } from "shared/types/index.js";

/**
 * What a human reads before any profile that is not built in gets built: the
 * agent's proposal card, and Settings' Build/Rebuild review. The same parts
 * in both, so a recipe reads the same wherever it is approved. Every string
 * is rendered as React text, never markup: an agent may have written all of
 * it.
 */
type Review = SandboxProfileProposalCardInput["review"];
type Limits = Review["limits"];

const mb = (value: number) => (value >= 1024 && value % 1024 === 0 ? `${value / 1024} GiB` : `${value} MiB`);
const LIMIT_LABELS: Record<keyof Limits, string> = { cpus: "CPUs", memoryMb: "Memory", homeMb: "Home (tmpfs)", sessionMinutes: "Session" };
const formatLimit = (key: keyof Limits, value: number) => (key === "cpus" ? String(value) : key === "sessionMinutes" ? `${value} min` : mb(value));

/** The risky parts first: the setup script, the download hosts, the packages, the limits against the caps, architectures and GL. */
export function RecipeRiskReview({ review }: { review: Review }) {
  const [showPackages, setShowPackages] = useState(review.packages.length <= 12);
  return (
    <>
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
    </>
  );
}

function DiffLines({ lines, testId }: { lines: readonly RecipeDiffLine[]; testId: string }) {
  return (
    <pre style={{ ...preStyle, padding: 0 }} data-testid={testId}>
      {foldRecipeDiff(lines).map((line, i) =>
        line.op === "fold" ? (
          <div key={i} data-op="fold" style={{ padding: "0 8px", color: "var(--text-muted)", fontStyle: "italic" }}>
            {`  … ${line.count} unchanged line${line.count === 1 ? "" : "s"}`}
          </div>
        ) : (
          <div
            key={i}
            data-op={line.op}
            style={{
              padding: "0 8px",
              background: line.op === "add" ? "var(--diff-added-bg)" : line.op === "remove" ? "var(--diff-removed-bg)" : undefined,
              color: line.op === "add" ? "var(--diff-added-text)" : line.op === "remove" ? "var(--diff-removed-text)" : undefined,
            }}
          >
            {line.op === "add" ? "+ " : line.op === "remove" ? "- " : "  "}
            {line.text}
          </div>
        ),
      )}
    </pre>
  );
}

/**
 * Two canonical recipes compared: the setup script on its own, line by line
 * (in the canonical JSON it is one escaped string), then every other field;
 * long unchanged runs are folded.
 */
export function RecipeDiffView({ before, after }: { before: string; after: string }) {
  const diff = recipeReviewDiff(before, after);
  const setupChanged = diff.setup.some((l) => l.op !== "same");
  const fieldsChanged = diff.fields.some((l) => l.op !== "same");
  if (!setupChanged && !fieldsChanged) return <div style={muted}>The recipe is identical.</div>;
  return (
    <div data-testid="proposal-diff">
      {setupChanged && (
        <>
          <div style={{ fontSize: 12, fontWeight: 600, margin: "4px 0" }}>Setup script</div>
          <DiffLines lines={diff.setup} testId="proposal-diff-setup" />
        </>
      )}
      {fieldsChanged ? (
        <>
          <div style={{ fontSize: 12, fontWeight: 600, margin: "4px 0" }}>Other fields</div>
          <DiffLines lines={diff.fields} testId="proposal-diff-fields" />
        </>
      ) : (
        <div style={muted}>No other field changed.</div>
      )}
    </div>
  );
}

export const muted: React.CSSProperties = { fontSize: 12, color: "var(--text-muted)" };
export const box: React.CSSProperties = { border: "1px solid var(--border)", borderRadius: 6, padding: "6px 10px", margin: "6px 0", minWidth: 0 };
export const dangerBox: React.CSSProperties = { ...box, border: "1px solid var(--danger-border)", background: "var(--danger-bg)" };
export const listStyle: React.CSSProperties = { margin: "4px 0 0 0", paddingLeft: 18, fontSize: 12 };
export const codeStyle: React.CSSProperties = { fontSize: 12, wordBreak: "break-all" };
const limitGrid: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 4, fontSize: 13 };
export const preStyle: React.CSSProperties = {
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
export const linkBtn: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--accent-text)",
  cursor: "pointer",
  padding: "2px 0",
  fontSize: 13,
};
