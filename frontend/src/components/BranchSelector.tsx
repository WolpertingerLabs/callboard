import { useState, useEffect, useCallback, useId, useMemo, type ReactNode } from "react";
import { GitBranch, GitFork } from "lucide-react";
import { getGitBranches, type BranchConfig, type CheckedOutBranch } from "../api";
import { worktreeDirName } from "shared/types/index.js";
import { getWorktreeByDefault, saveWorktreeByDefault } from "../utils/localStorage";
import { useIsMobile } from "../hooks/useIsMobile";

/**
 * Validate a git branch name according to git-check-ref-format rules.
 * Returns an error message string, or null if the name is valid.
 *
 * Kept in step with `validateGitRef` (`backend/src/utils/git.ts`), which is the
 * rule the request is actually judged against. Looser here means the box states
 * a confident fact about a branch the backend will refuse — "Will create branch
 * `-x`" for a name that never reaches git — and the user finds out through a
 * 500 rather than through the field they typed it in.
 *
 * One rule is deliberately *stricter* than `validateGitRef`: no path component
 * may start with `.`. Git refuses those (`git check-ref-format refs/heads/.x`
 * and `.../feat/.x` both fail) and the backend's validator does not, so that
 * one is a gap on both sides. Matching git is the point; a client-side
 * rejection is a better experience than the round trip either way.
 */
function validateBranchName(name: string): string | null {
  if (!name) return null; // empty is fine (field is optional)
  if (name.length > 255) return "Branch name must be 255 characters or fewer";
  if (/\s/.test(name)) return "Branch name cannot contain spaces";
  if (/\.\./.test(name)) return 'Branch name cannot contain ".."';
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f~^:?*[\\]/.test(name)) return "Branch name contains invalid characters";
  // Not cosmetic: every git command that would take this name as an argument
  // reads a leading "-" as an option instead.
  if (name.startsWith("-")) return 'Branch name cannot start with "-"';
  if (/(^|\/)\./.test(name)) return 'No part of a branch name can start with "."';
  if (name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) return 'Branch name cannot start/end with "/" or end with "."';
  if (name.includes("@{")) return 'Branch name cannot contain "@{"';
  if (name.includes("//")) return "Branch name cannot contain consecutive slashes";
  if (name.endsWith(".lock")) return 'Branch name cannot end with ".lock"';
  if (name === "@") return '"@" is not a valid branch name';
  return null;
}

/** Last path segment, ignoring trailing slashes — `path.basename` for the browser. */
function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const lastSlash = trimmed.lastIndexOf("/");
  return lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed;
}

/** A branch or directory name inside the summary sentence. */
function Name({ children }: { children: ReactNode }) {
  return <span style={{ fontFamily: "monospace", color: "var(--text)" }}>{children}</span>;
}

interface BranchSelectorProps {
  folder: string;
  currentBranch: string;
  /**
   * The config for the current selection, or `null` when the typed name is one
   * git would refuse.
   *
   * `null` rather than "don't call": the parent holds this until Send, and a
   * skipped call leaves it holding the *last valid* config — a name the user
   * typed on the way to the one they meant. Typing `feat/my thing` would have
   * started a chat on `feat/my`; with the toggle on, the first keystroke of
   * `my branch` emitted `newBranch: "m"` and Send made `repo.m`. Nothing about
   * that is visible from the parent, which is why the invalid state has to be
   * something it is *told*, not something it infers from silence.
   */
  onChange: (config: BranchConfig | null) => void;
}

export default function BranchSelector({ folder, currentBranch, onChange }: BranchSelectorProps) {
  const [branches, setBranches] = useState<string[]>([]);
  const [checkedOut, setCheckedOut] = useState<CheckedOutBranch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [baseBranch, setBaseBranch] = useState(currentBranch);
  const [newBranch, setNewBranch] = useState("");
  const [useWorktree, setUseWorktree] = useState(() => getWorktreeByDefault());

  // Fetch branches on mount
  useEffect(() => {
    setLoading(true);
    setError(null);
    getGitBranches(folder)
      .then((data) => {
        setBranches(data.branches);
        // Absent on a daemon older than this bundle, which reads as "no branch
        // is known to be checked out elsewhere" — the summary then says the
        // switch will happen here, which is what it said before this existed.
        setCheckedOut(data.checkedOut ?? []);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [folder]);

  // Reset base branch when currentBranch changes
  useEffect(() => {
    setBaseBranch(currentBranch);
  }, [currentBranch]);

  /**
   * The whole control, as three inputs mapped onto a `BranchConfig`.
   *
   * `autoCreateBranch` is set explicitly rather than left for the backend to
   * infer from `useWorktree && !newBranch`: that pair already means "check out
   * this existing branch in a worktree", which is what `start_chat_session`
   * sends, and overloading it would change what every existing caller asks for.
   */
  const propagateChange = useCallback(
    (base: string, newBr: string, worktree: boolean) => {
      const config: BranchConfig = {};
      const named = newBr.trim();

      if (worktree) {
        config.useWorktree = true;
        // Always sent with a worktree so the backend knows what to branch from.
        config.baseBranch = base;
        if (named) config.newBranch = named;
        else config.autoCreateBranch = true;
      } else if (named) {
        config.baseBranch = base;
        config.newBranch = named;
      } else if (base !== currentBranch) {
        config.baseBranch = base;
      }

      onChange(config);
    },
    [currentBranch, onChange],
  );

  // Validate new branch name
  const branchError = useMemo(() => validateBranchName(newBranch.trim()), [newBranch]);

  // Propagate on state changes. An invalid name replaces the config outright
  // rather than leaving the previous one standing — see `onChange`.
  useEffect(() => {
    if (branchError) {
      onChange(null);
      return;
    }
    propagateChange(baseBranch, newBranch, useWorktree);
  }, [baseBranch, newBranch, useWorktree, propagateChange, branchError, onChange]);

  // Persist worktree preference — the toggle is the only sticky control here.
  const handleWorktreeChange = useCallback((checked: boolean) => {
    setUseWorktree(checked);
    saveWorktreeByDefault(checked);
  }, []);

  const isMobile = useIsMobile();

  // The error owns an id because the name field points at it: a rejected name
  // has to be *associated* with the field it was typed in, not merely rendered
  // near it. Generated rather than hard-coded — the box is not guaranteed to be
  // the only one on a page.
  const errorId = useId();

  const trimmedName = newBranch.trim();

  // The directory `ensureWorktreeDetailed` derives for a branch, and where it
  // would sit: `worktreePathForBranch` joins the same name onto the *parent* of
  // the folder we are in. Only the name is shown, because the parent is the
  // directory the user is already standing beside.
  //
  // `worktreeDirName` is imported rather than re-derived: a picker predicting
  // `repo.feat-a-b` for a directory git will make at `repo.feat-a/b` has told
  // the user something false, and the only thing that keeps the two in step is
  // being one function. See its doc comment in `shared/types/git.ts`.
  const here = folder.replace(/\/+$/, "");
  const parentDir = here.slice(0, here.lastIndexOf("/") + 1);
  const repoName = basename(folder) || "repo";
  const derivedDir = (branch: string) => worktreeDirName(repoName, branch);
  const derivedPath = (branch: string) => parentDir + derivedDir(branch);

  /**
   * The three questions the backend asks about a branch before it does
   * anything, asked of the same data: is the directory it would use already
   * taken, does a worktree hold the branch, and does the branch exist at all.
   *
   * The asymmetry between the two worktree lookups is not an oversight — it
   * mirrors one in the code they describe. `ensureWorktreeDetailed` matches
   * *any* worktree on the branch, including the directory you are standing in,
   * and hands that path back. `switchBranch` excludes it (`wt.path !==
   * directory`), because checking out the branch you are already on is not a
   * redirect. Collapsing them would make the sentence wrong on one side or the
   * other.
   *
   * `worktreeAtDerivedDir` is the resolver's *first* rung, and the reason it can
   * be asked at all is that `checkedOut` carries paths: a worktree someone ran
   * `git switch` inside is still listed, now under a different branch, at the
   * directory this branch's worktree would have used. `existsSync` reuses it
   * whatever is in it, so the chat runs on that other branch.
   *
   * `branches` is `git branch --list`, local refs only — the same question
   * `localBranchExists` answers before deciding whether to pass `-b`.
   */
  const worktreeAtDerivedDir = (branch: string) => checkedOut.find((wt) => wt.path.replace(/\/+$/, "") === derivedPath(branch)) ?? null;
  const worktreeOn = (branch: string) => checkedOut.find((wt) => wt.branch === branch) ?? null;
  const worktreeElsewhereOn = (branch: string) => checkedOut.find((wt) => wt.branch === branch && wt.path.replace(/\/+$/, "") !== here) ?? null;
  const branchExists = (branch: string) => branches.includes(branch);

  /**
   * What `existsSync(derivedPath)` might find that the listing cannot show.
   *
   * A directory that is not a worktree of this repository is invisible from
   * here — a leftover from a removed worktree, an unrelated clone, a plain
   * folder — and so is a worktree of this repo sitting on a detached HEAD,
   * which `GET /git/branches` drops because it has no branch name to match on.
   * The resolver reuses any of them, in place of the `git worktree add` these
   * sentences promise, and the chat then runs in whatever state that directory
   * is in.
   *
   * Answering properly needs an endpoint that stats the path, and one is not
   * worth adding for this. So the sentence hedges instead of overstating: the
   * common case first, the reuse named, and no claim that the box has checked.
   */
  const unlessItExists = <> If that directory already exists, the chat runs in it as it is.</>;

  /**
   * The branch that already lives somewhere else, and where. Said twice, with
   * the reassurance only where it is worth saying: with the toggle on, this
   * checkout was never going to be touched, so claiming credit for that would
   * be noise. With it off, not switching is precisely the surprise.
   */
  const runsThereInstead = (branch: string, path: string, reassure: boolean) => (
    <>
      <Name>{branch}</Name> is checked out at <Name>{basename(path)}</Name> — the chat will run there.
      {reassure ? " This checkout is untouched." : ""}
    </>
  );

  /**
   * What the current selection will do, in a sentence. Always rendered, because
   * every one of these states was previously silent — including the ones where
   * picking a branch that lives in another worktree sends the chat to that
   * directory and leaves this checkout alone.
   *
   * The subject is always the *target* branch — the typed name if there is one,
   * the base branch otherwise — because that is what the backend keys all of
   * its decisions on. The rungs are walked in the resolver's own order, which
   * is load-bearing rather than tidy: the directory check comes first there, so
   * an occupied directory beats the branch you are standing on, and saying
   * otherwise would describe the wrong outcome for exactly the state that is
   * hardest to spot.
   */
  const summary: ReactNode = (() => {
    if (useWorktree) {
      if (!trimmedName) {
        return (
          <>
            Will create a new worktree off <Name>{baseBranch}</Name>, on a branch named from your first message.
          </>
        );
      }
      /**
       * `ensureWorktreeDetailed`'s first rung, and the one the box used to skip:
       * `existsSync(derivedPath)` reuses whatever sits at that path before it
       * asks a single question about the branch. A worktree made for `feat/y`
       * that someone then ran `git switch other` inside is still sitting at
       * `repo.feat-y`, so asking for a worktree on `feat/y` runs the chat there,
       * on `other` — while the box said it would check `feat/y` out somewhere
       * new.
       *
       * Only reported when the branches differ. When they match, the next rung
       * names the same directory and says the same thing about it, and two
       * sentences for one outcome is one too many.
       */
      const atDerived = worktreeAtDerivedDir(trimmedName);
      if (atDerived && atDerived.branch !== trimmedName) {
        return (
          <>
            <Name>{derivedDir(trimmedName)}</Name> already exists and is on <Name>{atDerived.branch}</Name> — the chat will run there, on{" "}
            <Name>{atDerived.branch}</Name> rather than <Name>{trimmedName}</Name>.
          </>
        );
      }
      /**
       * The branch you are already on is the one case where the redirect
       * wording would bury the news. `ensureWorktreeDetailed` matches the
       * worktree you are standing in and hands back this directory, so the
       * outcome is not "we are sending you elsewhere" — it is "your worktree
       * request was dropped", which is the Phase 1.2 failure surviving on the
       * typed path. Keyed on `currentBranch` rather than on a `checkedOut`
       * entry pointing here: git's own listing always contains the current
       * worktree, so this holds even when the endpoint sent no listing at all.
       */
      if (trimmedName === currentBranch) {
        return (
          <>
            <Name>{currentBranch}</Name> is already checked out here — the chat will run here, with no worktree.
          </>
        );
      }
      const occupied = worktreeOn(trimmedName);
      if (occupied) return runsThereInstead(trimmedName, occupied.path, false);
      if (branchExists(trimmedName)) {
        return (
          <>
            <Name>{trimmedName}</Name> already exists — will check it out in a new worktree at <Name>{derivedDir(trimmedName)}</Name>.
            {unlessItExists}
          </>
        );
      }
      return (
        <>
          Will create <Name>{derivedDir(trimmedName)}</Name> on new branch <Name>{trimmedName}</Name>, off <Name>{baseBranch}</Name>.
          {unlessItExists}
        </>
      );
    }

    // A typed name matching the current branch falls through to the no-change
    // sentence below: `switchBranch` checks out the branch already checked out
    // here, which git completes and which changes nothing. "Will switch this
    // checkout to it" would be a generous verb for a no-op, and this box is
    // supposed to state facts.
    if (trimmedName && trimmedName !== currentBranch) {
      const occupied = worktreeElsewhereOn(trimmedName);
      if (occupied) return runsThereInstead(trimmedName, occupied.path, true);
      if (branchExists(trimmedName)) {
        return (
          <>
            <Name>{trimmedName}</Name> already exists — will switch this checkout to it.
          </>
        );
      }
      return (
        <>
          Will create branch <Name>{trimmedName}</Name> off <Name>{baseBranch}</Name> in this checkout.
        </>
      );
    }

    // Nothing typed, or a name naming the branch we are already on. The base
    // branch is irrelevant in the second case: `newBranch` wins in
    // `resolveBranch`, so the base is never consulted.
    if (trimmedName === currentBranch || baseBranch === currentBranch) {
      return (
        <>
          Runs here on <Name>{currentBranch}</Name>. No branch or worktree change.
        </>
      );
    }
    const occupied = worktreeElsewhereOn(baseBranch);
    if (occupied) return runsThereInstead(baseBranch, occupied.path, true);
    return (
      <>
        Will switch this checkout to <Name>{baseBranch}</Name>.
      </>
    );
  })();

  const hasChanges = baseBranch !== currentBranch || !!trimmedName || useWorktree;

  // Shared sub-components
  const baseBranchSelect = (
    <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flex: isMobile ? 1 : undefined }}>
      <GitBranch size={13} style={{ color: "var(--accent-text)", flexShrink: 0 }} />
      {loading ? (
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Loading...</span>
      ) : error ? (
        <span style={{ fontSize: 12, color: "var(--danger)" }}>{error}</span>
      ) : (
        <select
          value={baseBranch}
          onChange={(e) => setBaseBranch(e.target.value)}
          aria-label="Base branch"
          style={{
            background: "var(--bg)",
            color: "var(--text)",
            border: "1px solid var(--border)",
            borderRadius: 5,
            padding: "4px 8px",
            fontSize: 12,
            fontFamily: "monospace",
            cursor: "pointer",
            outline: "none",
            ...(isMobile ? { flex: 1, minWidth: 0 } : { maxWidth: 180 }),
          }}
        >
          {branches.map((branch) => (
            <option key={branch} value={branch}>
              {branch}
              {branch === currentBranch ? " (current)" : ""}
            </option>
          ))}
        </select>
      )}
    </div>
  );

  const newBranchInput = (
    <div style={{ display: "flex", alignItems: "center", gap: 4, flex: 1, minWidth: isMobile ? 0 : 120 }}>
      <input
        type="text"
        value={newBranch}
        onChange={(e) => setNewBranch(e.target.value)}
        aria-label="New branch name"
        aria-invalid={branchError ? true : undefined}
        aria-describedby={branchError ? errorId : undefined}
        /* The placeholder tracks the toggle because empty means two different
           things: a generated name with a worktree, no new branch without one. */
        placeholder={useWorktree ? "auto" : "new-branch (optional)"}
        style={{
          flex: 1,
          background: "var(--bg)",
          color: "var(--text)",
          border: branchError ? "1px solid var(--danger)" : "1px solid var(--border)",
          borderRadius: 5,
          padding: "4px 8px",
          fontSize: 12,
          fontFamily: "monospace",
          outline: "none",
          minWidth: 0,
          boxSizing: "border-box",
        }}
      />
    </div>
  );

  const worktreeToggle = (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 5,
        cursor: "pointer",
        fontSize: 12,
        color: useWorktree ? "var(--accent)" : "var(--text-muted)",
        flexShrink: 0,
        userSelect: "none",
        fontWeight: useWorktree ? 500 : 400,
        transition: "color 0.15s ease",
      }}
    >
      <input
        type="checkbox"
        checked={useWorktree}
        onChange={(e) => handleWorktreeChange(e.target.checked)}
        style={{ cursor: "pointer", margin: 0 }}
      />
      <GitFork size={12} style={{ flexShrink: 0 }} />
      New worktree
    </label>
  );

  return (
    <div
      style={{
        background: "var(--bg-secondary)",
        borderRadius: 10,
        padding: "10px 14px",
        marginBottom: 8,
        border: hasChanges ? "1px solid var(--accent)" : "1px solid transparent",
        transition: "border-color 0.2s ease",
      }}
    >
      {isMobile ? (
        /* Mobile: multi-row layout */
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {/* Row 1: Base branch selector (full width) */}
          {baseBranchSelect}
          {/* Row 2: New branch input */}
          {newBranchInput}
          {/* Row 3: Worktree toggle */}
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>{worktreeToggle}</div>
        </div>
      ) : (
        /* Desktop: single-row inline layout */
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          {baseBranchSelect}
          <span style={{ color: "var(--border)", fontSize: 14, userSelect: "none" }}>/</span>
          {newBranchInput}
          {worktreeToggle}
        </div>
      )}

      {/* An invalid name leaves the parent holding no config at all, so no
          sentence about it would be true — the error takes the summary's place,
          and says why Send is doing nothing, until the name is fixable.

          Both halves are announced, because both are the whole point of this
          box: a plain <div> that silently rewrites itself as you toggle the
          checkbox tells a screen reader nothing at all, and the Send button
          going grey is not a signal anyone can hear. `alert` for the rejection
          (it interrupts — the user cannot send until they act on it) and
          `status` for the sentence (polite — it is describing a choice being
          made, not demanding one). */}
      {branchError ? (
        <div
          id={errorId}
          role="alert"
          style={{
            marginTop: 6,
            fontSize: 11,
            color: "var(--danger)",
            fontWeight: 500,
            paddingLeft: 19,
          }}
        >
          {branchError} — nothing will send until this is fixed.
        </div>
      ) : (
        <div
          data-testid="branch-summary"
          role="status"
          style={{
            marginTop: 6,
            fontSize: 11,
            color: "var(--text-muted)",
            paddingLeft: 19,
            lineHeight: 1.5,
          }}
        >
          {summary}
        </div>
      )}
    </div>
  );
}
