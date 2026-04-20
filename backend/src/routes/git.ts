import { Router } from "express";
import { basename } from "path";
import {
  deleteLocalBranch,
  detectMergeConflict,
  getBranchMeta,
  getBranchStatusFlags,
  getGitBranches,
  getGitDiffStructured,
  getGitFileDiff,
  getGitWorktrees,
  getOriginRemoteUrl,
  parseGithubRemote,
  readRepoFile,
  removeWorktree,
  resolveWorktreeToMainRepoCached,
  validateFilename,
  validateFolderPath,
} from "../utils/git.js";
import { generateBranchName } from "../services/quick-completion.js";
import { githubPrService } from "../services/github-pr.js";
import type { BranchOverviewFolder, BranchOverviewResponse, BranchRow, PrInfo } from "shared/types/index.js";

export const gitRouter = Router();

/**
 * List local branches for a git repository.
 * Returns branches sorted alphabetically with the current branch first.
 */
gitRouter.get("/branches", (req, res) => {
  // #swagger.tags = ['Git']
  // #swagger.summary = 'List git branches'
  // #swagger.description = 'Returns local branches for a git repository, sorted alphabetically with the current branch first.'
  /* #swagger.parameters['folder'] = { in: 'query', required: true, type: 'string', description: 'Absolute path to the git repository' } */
  /* #swagger.responses[200] = { description: "Array of branch objects" } */
  /* #swagger.responses[400] = { description: "Missing or invalid folder" } */
  const rawFolder = req.query.folder as string;
  if (!rawFolder) return res.status(400).json({ error: "folder query param is required" });

  let folder: string;
  try {
    folder = validateFolderPath(rawFolder);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }

  try {
    const branches = getGitBranches(folder);
    res.json({ branches });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to list branches", details: err.message });
  }
});

/**
 * List all git worktrees for a repository.
 */
gitRouter.get("/worktrees", (req, res) => {
  // #swagger.tags = ['Git']
  // #swagger.summary = 'List git worktrees'
  // #swagger.description = 'Returns all git worktrees for a repository.'
  /* #swagger.parameters['folder'] = { in: 'query', required: true, type: 'string', description: 'Absolute path to the git repository' } */
  /* #swagger.responses[200] = { description: "Array of worktree objects" } */
  /* #swagger.responses[400] = { description: "Missing or invalid folder" } */
  const rawFolder = req.query.folder as string;
  if (!rawFolder) return res.status(400).json({ error: "folder query param is required" });

  let folder: string;
  try {
    folder = validateFolderPath(rawFolder);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }

  try {
    const worktrees = getGitWorktrees(folder);
    res.json({ worktrees });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to list worktrees", details: err.message });
  }
});

/**
 * Remove a git worktree and prune stale references.
 */
gitRouter.delete("/worktrees", (req, res) => {
  // #swagger.tags = ['Git']
  // #swagger.summary = 'Remove a worktree'
  // #swagger.description = 'Remove a git worktree and prune stale references.'
  /* #swagger.requestBody = {
    required: true,
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["folder", "worktreePath"],
          properties: {
            folder: { type: "string", description: "Absolute path to the main git repository" },
            worktreePath: { type: "string", description: "Path to the worktree to remove" },
            force: { type: "boolean", description: "Force removal even with uncommitted changes" }
          }
        }
      }
    }
  } */
  /* #swagger.responses[200] = { description: "Worktree removed" } */
  /* #swagger.responses[400] = { description: "Missing required fields or invalid folder" } */
  const { folder: rawFolder, worktreePath, force } = req.body;
  if (!rawFolder) return res.status(400).json({ error: "folder is required" });
  if (!worktreePath) return res.status(400).json({ error: "worktreePath is required" });

  let folder: string;
  try {
    folder = validateFolderPath(rawFolder);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }

  try {
    removeWorktree(folder, worktreePath, !!force);
    // Bust caches so the overview reflects the removal immediately.
    try {
      const { mainRepoPath } = resolveWorktreeToMainRepoCached(folder);
      branchOverviewGitCache.delete(mainRepoPath);
      mergeConflictCache.delete(mainRepoPath);
    } catch {
      // non-fatal
    }
    res.json({ ok: true, removed: worktreePath });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to remove worktree", details: err.message });
  }
});

/**
 * Delete a local git branch. Safety: refuses to delete the current branch or a
 * branch still checked out in any worktree. Uses `-D` when `force` is true.
 */
gitRouter.delete("/branches", (req, res) => {
  // #swagger.tags = ['Git']
  // #swagger.summary = 'Delete a local branch'
  // #swagger.description = 'Deletes a local git branch. Refuses to delete the current branch or one checked out in any worktree. Use `force` to delete unmerged branches.'
  /* #swagger.requestBody = {
    required: true,
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["folder", "branch"],
          properties: {
            folder: { type: "string", description: "Absolute path to the git repository" },
            branch: { type: "string", description: "Branch name to delete" },
            force: { type: "boolean", description: "Force delete unmerged branches (-D)" }
          }
        }
      }
    }
  } */
  /* #swagger.responses[200] = { description: "Branch deleted" } */
  /* #swagger.responses[400] = { description: "Missing fields / invalid branch / branch in use" } */
  const { folder: rawFolder, branch, force } = req.body;
  if (!rawFolder) return res.status(400).json({ error: "folder is required" });
  if (!branch) return res.status(400).json({ error: "branch is required" });

  let folder: string;
  try {
    folder = validateFolderPath(rawFolder);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }

  try {
    const { mainRepoPath } = resolveWorktreeToMainRepoCached(folder);
    deleteLocalBranch(mainRepoPath, branch, !!force);
    // Bust caches so the overview reflects the deletion immediately.
    branchOverviewGitCache.delete(mainRepoPath);
    mergeConflictCache.delete(mainRepoPath);
    res.json({ ok: true, deleted: branch });
  } catch (err: any) {
    res.status(400).json({ error: "Failed to delete branch", details: err.message });
  }
});

/**
 * Get structured git diff with file metadata, untracked files, and large file gating.
 */
gitRouter.get("/diff", (req, res) => {
  // #swagger.tags = ['Git']
  // #swagger.summary = 'Get structured git diff'
  // #swagger.description = 'Returns per-file diff data including untracked files, with large file gating.'
  /* #swagger.parameters['folder'] = { in: 'query', required: true, type: 'string', description: 'Absolute path to the git repository' } */
  /* #swagger.responses[200] = { description: "Structured diff response with files array" } */
  /* #swagger.responses[400] = { description: "Missing or invalid folder" } */
  const rawFolder = req.query.folder as string;
  if (!rawFolder) return res.status(400).json({ error: "folder query param is required" });

  let folder: string;
  try {
    folder = validateFolderPath(rawFolder);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }

  try {
    const files = getGitDiffStructured(folder);
    res.json({ files });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to get diff", details: err.message });
  }
});

/**
 * Get the diff for a single file on demand (for large files).
 */
gitRouter.get("/diff/file", (req, res) => {
  // #swagger.tags = ['Git']
  // #swagger.summary = 'Get single file diff'
  // #swagger.description = 'Returns the diff for a single file, used for on-demand loading of large files.'
  /* #swagger.parameters['folder'] = { in: 'query', required: true, type: 'string' } */
  /* #swagger.parameters['filename'] = { in: 'query', required: true, type: 'string' } */
  const rawFolder = req.query.folder as string;
  const filename = req.query.filename as string;

  if (!rawFolder) return res.status(400).json({ error: "folder query param is required" });
  if (!filename) return res.status(400).json({ error: "filename query param is required" });

  let folder: string;
  try {
    folder = validateFolderPath(rawFolder);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }

  try {
    validateFilename(filename);
    const result = getGitFileDiff(folder, filename);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to get file diff", details: err.message });
  }
});

/**
 * Serve raw file content for media previews (images, videos).
 */
gitRouter.get("/diff/file/raw", (req, res) => {
  // #swagger.tags = ['Git']
  // #swagger.summary = 'Get raw file content'
  // #swagger.description = 'Serves raw file bytes for media previews in the diff view.'
  /* #swagger.parameters['folder'] = { in: 'query', required: true, type: 'string' } */
  /* #swagger.parameters['filename'] = { in: 'query', required: true, type: 'string' } */
  const rawFolder = req.query.folder as string;
  const filename = req.query.filename as string;

  if (!rawFolder) return res.status(400).json({ error: "folder query param is required" });
  if (!filename) return res.status(400).json({ error: "filename query param is required" });

  let folder: string;
  try {
    folder = validateFolderPath(rawFolder);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }

  try {
    validateFilename(filename);
    const { buffer, contentType } = readRepoFile(folder, filename);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", buffer.length);
    res.setHeader("Cache-Control", "no-cache");
    res.end(buffer);
  } catch (err: any) {
    if (err.message === "File not found") {
      return res.status(404).json({ error: "File not found" });
    }
    res.status(500).json({ error: "Failed to read file", details: err.message });
  }
});

/**
 * Generate a git-safe branch name from a natural language prompt.
 * Uses AI to produce a <type>/<kebab-case-description> format branch name.
 */
gitRouter.post("/generate-branch-name", async (req, res) => {
  // #swagger.tags = ['Git']
  // #swagger.summary = 'Generate a branch name from a prompt'
  // #swagger.description = 'Uses AI to generate a git-safe branch name from a natural language request.'
  /* #swagger.requestBody = {
    required: true,
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["prompt"],
          properties: {
            prompt: { type: "string", description: "Natural language description to generate a branch name from" }
          }
        }
      }
    }
  } */
  /* #swagger.responses[200] = { description: "Generated branch name" } */
  /* #swagger.responses[400] = { description: "Missing prompt" } */
  /* #swagger.responses[500] = { description: "Failed to generate branch name" } */
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "prompt is required" });

  try {
    const branchName = await generateBranchName(prompt);
    if (!branchName) {
      return res.status(500).json({ error: "Failed to generate branch name" });
    }
    res.json({ branchName });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to generate branch name", details: err.message });
  }
});

// ── Branch overview ──────────────────────────────────────────────────
// Per-repo cache for the git-only portion (branches + worktrees + meta).
// PR data has its own cache in github-pr service.
interface BranchOverviewCacheEntry {
  folders: BranchOverviewFolder[];
  fetchedAt: number;
}
const branchOverviewGitCache = new Map<string, BranchOverviewCacheEntry>();
const BRANCH_OVERVIEW_GIT_TTL = 30 * 1000; // 30 seconds

interface MergeConflictCacheEntry {
  map: Map<string, { hasConflict: boolean; baseRef: string }>;
  fetchedAt: number;
}
const mergeConflictCache = new Map<string, MergeConflictCacheEntry>();
const MERGE_CONFLICT_TTL = 60 * 1000; // 1 minute

function buildRowsForFolder(folder: string): BranchOverviewFolder {
  // Always resolve to main repo — worktrees share branches with their parent.
  const { mainRepoPath } = resolveWorktreeToMainRepoCached(folder);
  const repoDir = mainRepoPath;
  const displayName = basename(repoDir);

  const meta = getBranchMeta(repoDir);
  const worktrees = getGitWorktrees(repoDir);
  const worktreeByBranch = new Map<string, string>();
  for (const wt of worktrees) {
    if (wt.branch) worktreeByBranch.set(wt.branch, wt.path);
  }

  const rows: BranchRow[] = meta.map((m) => {
    const worktreePath = worktreeByBranch.get(m.branch) || null;
    const flags = getBranchStatusFlags(repoDir, m.branch, worktreePath);
    return {
      branch: m.branch,
      isCurrent: m.isCurrent,
      worktreePath,
      upstream: m.upstream,
      ahead: m.ahead,
      behind: m.behind,
      lastCommit: m.lastCommit,
      prs: [],
      hasMergeConflict: null,
      mergeConflictBase: null,
      hasUncommittedChanges: flags.hasUncommittedChanges,
      hasUnpushedCommits: flags.hasUnpushedCommits,
      unpushedCount: flags.unpushedCount,
      hasLocalSession: false,
      lastActivityAt: null,
    };
  });

  // Current branch first, then alphabetical.
  rows.sort((a, b) => {
    if (a.isCurrent && !b.isCurrent) return -1;
    if (!a.isCurrent && b.isCurrent) return 1;
    return a.branch.localeCompare(b.branch);
  });

  return {
    folder: repoDir,
    displayName,
    branches: rows,
    prsEnriched: false,
  };
}

gitRouter.get("/branch-overview", async (req, res) => {
  // #swagger.tags = ['Git']
  // #swagger.summary = 'Get branch overview with PR metadata'
  // #swagger.description = 'Returns a table-ready overview of all local branches: worktree location, ahead/behind, last commit, and associated GitHub PRs (approval, unresolved comments, checks).'
  /* #swagger.parameters['folder'] = { in: 'query', required: true, type: 'string', description: 'Absolute path to the git repository' } */
  /* #swagger.parameters['refresh'] = { in: 'query', required: false, type: 'string', description: 'Set to 1 to bust the cache and fetch fresh data' } */
  /* #swagger.responses[200] = { description: "Branch overview payload" } */
  /* #swagger.responses[400] = { description: "Missing or invalid folder" } */
  const rawFolder = req.query.folder as string | undefined;
  if (!rawFolder) return res.status(400).json({ error: "folder query param is required" });

  let folder: string;
  try {
    folder = validateFolderPath(rawFolder);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }

  const force = req.query.refresh === "1";

  try {
    const { mainRepoPath } = resolveWorktreeToMainRepoCached(folder);
    const repoDir = mainRepoPath;

    // Git-only data (30s TTL)
    let gitEntry = branchOverviewGitCache.get(repoDir);
    const now = Date.now();
    if (force || !gitEntry || now - gitEntry.fetchedAt >= BRANCH_OVERVIEW_GIT_TTL) {
      const folderData = buildRowsForFolder(repoDir);
      gitEntry = { folders: [folderData], fetchedAt: now };
      branchOverviewGitCache.set(repoDir, gitEntry);
    }

    // Clone so we don't mutate the cached objects when merging PRs below.
    const folders: BranchOverviewFolder[] = gitEntry.folders.map((f) => ({
      ...f,
      branches: f.branches.map((b) => ({ ...b, prs: [], hasMergeConflict: null, mergeConflictBase: null })),
      prsEnriched: false,
    }));

    // PR enrichment (stale-while-revalidate, keyed by repo remote).
    let prFetchedAt: string | null = null;
    const originUrl = getOriginRemoteUrl(repoDir);
    const ghRemote = originUrl ? parseGithubRemote(originUrl) : null;
    if (ghRemote && (await githubPrService.isAvailable())) {
      if (force) githubPrService.invalidate(repoDir);
      const { map: prMap, fetchedAt } = await githubPrService.getPrsForRepo(repoDir);
      prFetchedAt = fetchedAt ? new Date(fetchedAt).toISOString() : null;
      for (const folderData of folders) {
        folderData.prsEnriched = true;
        for (const row of folderData.branches) {
          const list = prMap.get(row.branch);
          if (list && list.length > 0) {
            row.prs = list as PrInfo[];
          }
        }

        // Merge-conflict detection: check each branch with an open PR against its base ref.
        // Cached per-repo with a short TTL to amortize the git merge-tree cost across polls.
        const checks = folderData.branches
          .map((row) => {
            const open = row.prs.find((p) => p.state === "open");
            if (!open) return null;
            return { row, base: open.baseRef };
          })
          .filter((x): x is { row: BranchRow; base: string } => x !== null);

        const mcEntry = mergeConflictCache.get(folderData.folder);
        const mcFresh = !!mcEntry && !force && Date.now() - mcEntry.fetchedAt < MERGE_CONFLICT_TTL;
        const mcMap = mcFresh && mcEntry ? mcEntry.map : new Map<string, { hasConflict: boolean; baseRef: string }>();

        if (!mcFresh) {
          const results = await Promise.all(
            checks.map(({ row, base }) =>
              Promise.resolve().then(() => {
                try {
                  return detectMergeConflict(folderData.folder, row.branch, base);
                } catch {
                  return null;
                }
              }),
            ),
          );
          checks.forEach(({ row }, i) => {
            const result = results[i];
            if (result) mcMap.set(row.branch, result);
          });
          mergeConflictCache.set(folderData.folder, { map: mcMap, fetchedAt: Date.now() });
        }

        for (const { row } of checks) {
          const cached = mcMap.get(row.branch);
          if (cached) {
            row.hasMergeConflict = cached.hasConflict;
            row.mergeConflictBase = cached.baseRef;
          }
        }
      }
    }

    const response: BranchOverviewResponse = {
      folders,
      fetchedAt: new Date().toISOString(),
      prFetchedAt,
    };
    res.json(response);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to build branch overview", details: err.message });
  }
});
