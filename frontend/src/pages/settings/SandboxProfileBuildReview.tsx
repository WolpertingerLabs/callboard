import { useEffect, useState } from "react";
import { Hammer, Loader2 } from "lucide-react";
import type { SandboxProfileBuildReview as Review } from "shared/types/index.js";
import { getSandboxProfileReview } from "../../api";
import { RecipeDiffView, RecipeRiskReview, box, codeStyle, muted, preStyle } from "../../components/SandboxProfileReviewParts";

/**
 * What a human reads before building any profile that is not built in —
 * agent-built, promoted, or any other recipe from the profile store. The
 * store is plain JSON in the data directory, so anything that can write
 * files there (an agent with file access, say) could have put a recipe,
 * an "approved" state or a promotion record in it. So this shows exactly
 * what would build — the risky parts, the diff against what is built now,
 * the canonical recipe and its digest — and the build it starts is pinned
 * to that digest: if the recipe changes after this was read, the build is
 * refused rather than run. The provenance is shown for what it is: the
 * store's claim, unverified. Built-ins ship with Callboard and skip this.
 */
export default function SandboxProfileBuildReview({
  name,
  scope,
  onBuild,
  onCancel,
}: {
  name: string;
  scope: string;
  onBuild: (digest: string) => void;
  onCancel: () => void;
}) {
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRecipe, setShowRecipe] = useState(false);
  useEffect(() => {
    let live = true;
    getSandboxProfileReview(name, scope).then(
      (value) => live && setReview(value),
      (e: unknown) => live && setError(e instanceof Error ? e.message : "Failed to read the recipe"),
    );
    return () => {
      live = false;
    };
  }, [name, scope]);

  if (error)
    return (
      <div role="alert" style={{ ...box, color: "var(--danger)" }}>
        {error}
      </div>
    );
  if (!review)
    return (
      <div style={{ ...muted, display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
        <Loader2 size={14} className="spin" /> Reading the recipe…
      </div>
    );
  const p = review.provenance;
  const builtDiffers = review.built && review.built.digest !== review.digest;
  return (
    <div data-testid={`sandbox-profile-review-${name}`} style={{ ...box, marginTop: 10, minWidth: 0 }}>
      <strong style={{ fontSize: 14 }}>Review before building {name}</strong>
      <p style={{ ...muted, margin: "4px 0" }}>
        This recipe is not one Callboard shipped: it comes from the profile store, or from an unrecognised file. Read what will build. The build is pinned to
        this exact recipe (sha256 <code style={codeStyle}>{review.digest}</code>), so if the recipe changes before it runs, nothing is built.
      </p>
      {review.builtinProblem && (
        <p role="alert" data-testid="sandbox-profile-review-builtin-problem" style={{ ...box, borderColor: "var(--warning)", fontSize: 13 }}>
          <strong>{review.builtinProblem === "modified" ? "Not the shipped recipe." : "Not shipped with Callboard."}</strong>{" "}
          {review.builtinProblem === "modified"
            ? "This file in the built-in profiles' folder differs from the recipe this Callboard version shipped."
            : "No recipe of this name ships with this Callboard version."}{" "}
          That folder is writable by this machine&apos;s user (in a source checkout or a user-level install), so read it like any other recipe.
        </p>
      )}
      {review.unverified && (
        <p role="alert" data-testid="sandbox-profile-review-unverified" style={{ ...box, borderColor: "var(--warning)", fontSize: 13 }}>
          <strong>Unverified global profile.</strong> No image Callboard built for it exists now (never built here, image removed, or needs a rebuild
          {review.imageState ? `: ${review.imageState}` : ""}). Its file can&apos;t be trusted on its own: agents don&apos;t see it and it can&apos;t start
          until you build it here.
        </p>
      )}
      <RecipeRiskReview review={review.review} />
      {builtDiffers && (
        <>
          <div style={{ fontSize: 13, fontWeight: 600, margin: "8px 0 4px 0" }}>
            Changes since the image built now{review.built!.version !== undefined ? ` (version ${review.built!.version})` : ""}
          </div>
          {review.built!.recipe ? (
            <RecipeDiffView before={review.built!.recipe} after={review.recipe} />
          ) : (
            <div style={muted}>The image there now was built from a recipe the store no longer has (sha256 {review.built!.digest.slice(0, 16)}…).</div>
          )}
        </>
      )}
      <button
        type="button"
        style={{ background: "transparent", border: "none", color: "var(--accent-text)", cursor: "pointer", padding: "2px 0", fontSize: 13 }}
        onClick={() => setShowRecipe((v) => !v)}
        aria-expanded={showRecipe}
      >
        {showRecipe ? "Hide" : "Show"} the full canonical recipe
      </button>
      {showRecipe && <pre style={preStyle}>{review.recipe}</pre>}
      {p && (
        <div style={{ ...box, borderStyle: "dashed", fontSize: 12 }} data-testid="sandbox-profile-review-provenance">
          <div style={{ fontWeight: 600, marginBottom: 2 }}>
            Stored provenance — unverified store data (anything with access to the data directory could have written it):
          </div>
          <div style={{ wordBreak: "break-word" }}>
            {p.createdBy ? `Proposed in chat ${p.createdBy}. ` : ""}
            {p.ownerLabel ? `Owner: ${p.ownerLabel}. ` : ""}
            {review.version !== undefined ? `Version in force: v${review.version}. ` : ""}
            {p.approvedAt
              ? `Approved ${new Date(p.approvedAt).toLocaleString()}${p.approvalId ? ` (proposal ${p.approvalId})` : ""}. `
              : "No approval recorded. "}
            {p.promoted ? `Promoted ${new Date(p.promoted.at).toLocaleString()} from ${p.promoted.fromScope} v${p.promoted.fromVersion}.` : ""}
          </div>
        </div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
        <button
          onClick={() => onBuild(review.digest)}
          aria-label={`Build profile ${name} from this exact recipe`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            background: "var(--accent)",
            color: "var(--text-on-accent)",
            padding: "6px 14px",
            borderRadius: 6,
            fontSize: 13,
          }}
        >
          <Hammer size={14} /> Build this exact recipe
        </button>
        <button
          onClick={onCancel}
          style={{ padding: "6px 14px", borderRadius: 6, fontSize: 13, border: "1px solid var(--border)", background: "var(--surface)" }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
