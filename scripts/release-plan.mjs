/**
 * Decides what the publish workflow (.github/workflows/publish.yml) does.
 *
 * Callboard and drawlatch (packages/drawlatch) are released from one commit of
 * this repo, drawlatch first because callboard pins it exactly. This script
 * looks at the registry and the tags and prints, as step outputs, one action
 * and one tag target per package. The workflow's later steps only carry those
 * out, so every decision lives here and is unit-tested
 * (release-plan.test.mjs).
 *
 * The rules, per package:
 *
 * drawlatch
 * - Not on npm: publish it from HEAD and tag HEAD `drawlatch-v<version>`.
 * - On npm: don't publish. Find the commit it was published from (its tag, or
 *   failing that the manifest's `gitHead`) and fail if anything that ships has
 *   changed under packages/drawlatch since then: the workspace is what
 *   callboard was built and tested against, and the registry copy is what
 *   callboard's users install. The fix is to bump drawlatch.
 *
 * callboard
 * - Not on npm: publish it from HEAD and tag HEAD `v<version>`.
 * - On npm from this very commit (a previous run published it and then failed
 *   before tagging): don't publish; just tag.
 * - On npm from another commit: fail ("bump callboard"). A dry run warns
 *   instead and only packs, so a rehearsal still works before the bump.
 *
 * These make a re-run after any partial failure safe: whatever was published
 * is skipped, whatever was not is published, and a missing tag is created on
 * the commit that was actually published. A tag that already points at the
 * right commit is left alone; one that points anywhere else fails the run.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const DRAWLATCH = "@wolpertingerlabs/drawlatch";
export const CALLBOARD = "@wolpertingerlabs/callboard";
export const DRAWLATCH_DIR = "packages/drawlatch";

export const drawlatchTag = (version) => `drawlatch-v${version}`;
export const callboardTag = (version) => `v${version}`;

/**
 * Paths under packages/drawlatch that cannot change drawlatch's npm tarball,
 * so changing them does not require a drawlatch bump. Everything else counts.
 *
 * What ships is drawlatch's `files` list plus package.json and LICENSE:
 * `dist` (tsc output of src/, minus tests, plus a copy of src/connections),
 * `frontend/dist` (Vite build of frontend/), `bin`, and three markdown docs.
 * Their inputs are src/, frontend/, bin/, package.json, tsconfig.json and those
 * docs. This is a deny list rather than an allow list on purpose: a new file
 * nobody classified counts as drift, so the guard errs towards an unneeded
 * bump, never towards callboard depending on a registry copy that differs
 * from the workspace it was tested with.
 *
 * Patterns use git's `glob` pathspec magic, relative to packages/drawlatch.
 */
export const DRAWLATCH_NON_SHIPPING = [
  // Tests: tsconfig.json excludes them from dist, and Vite only bundles what
  // frontend/src imports. Not `**/e2e/**`: src/remote/ingestors/e2e/setup.ts
  // is not a test file, so tsc emits it into dist and it ships.
  "**/*.test.ts",
  "**/*.test.tsx",
  // Test fixtures; only tests import them.
  "**/__fixtures__/**",
  // Test, lint and format config.
  "vitest.config.ts",
  "vitest.e2e.config.ts",
  "eslint.config.js",
  "tsconfig.eslint.json",
  ".prettierrc",
  ".prettierignore",
  // Contributor docs, design records and editor/agent config. .claude-plugin
  // is read from the GitHub repo by the Claude plugin marketplace, not npm.
  "CLAUDE.md",
  "plans/**",
  ".claude/**",
  ".claude-plugin/**",
  ".vscode/**",
  ".mcp.json",
  // Example config for people running drawlatch from a checkout.
  ".env.example",
  ".env.e2e.example",
  "*.example.json",
];

/** `git diff` pathspecs for "everything under packages/drawlatch that ships". */
export function drawlatchDriftPathspec() {
  return [DRAWLATCH_DIR, ...DRAWLATCH_NON_SHIPPING.map((p) => `:(glob,exclude)${DRAWLATCH_DIR}/${p}`)];
}

/**
 * The pure decision. `drawlatch` and `callboard` are
 * `{ version, published, tagCommit, gitHead }`: `published` is whether that
 * version is on npm, `tagCommit` the commit its tag points at (null if there is
 * no tag) and `gitHead` the commit npm recorded for the published version (null
 * if unpublished or not recorded).
 *
 * `git` supplies the two repository questions: `isPublishBase(sha)` (sha is
 * HEAD or an ancestor of it and has packages/drawlatch in it, so it is a
 * monorepo commit, not one of the standalone repo's imported ones) and
 * `driftFiles(sha)` (the shipping drawlatch paths that differ between sha and
 * HEAD).
 *
 * Returns `{ errors, warnings, drawlatch: { action, tagCommit, driftBase },
 * callboard: { action, tagCommit } }`. drawlatch's action is "publish" or
 * "skip"; callboard's is "publish", "pack" (dry run only: the version is
 * already on npm, so `npm publish --dry-run` would refuse it) or "skip". A
 * `tagCommit` of null means there is nothing to tag. When `errors` is non-empty
 * the run must stop before publishing anything.
 */
export function planRelease({ dryRun, head, pins, drawlatch, callboard, git }) {
  const errors = [];
  const warnings = [];

  // Lockstep: callboard's published dependency must be the workspace version.
  // deps:check enforces this too, but it runs later, inside the gate.
  for (const [where, pin] of Object.entries(pins)) {
    if (pin !== drawlatch.version) {
      errors.push(
        `${where} pins ${DRAWLATCH} to ${JSON.stringify(pin)}, but ${DRAWLATCH_DIR} is ${drawlatch.version}. The pin must be exactly the workspace version.`,
      );
    }
  }

  // A tag only ever names the commit a version was published from. `tagCommit`
  // below is the commit to tag, or null when there is nothing to tag.
  const dl = { action: "skip", tagCommit: null, driftBase: null };
  const dlTag = drawlatchTag(drawlatch.version);
  if (!drawlatch.published) {
    dl.action = "publish";
    if (!drawlatch.tagCommit) dl.tagCommit = head;
    else if (drawlatch.tagCommit !== head) errors.push(strayTag(dlTag, drawlatch.tagCommit, DRAWLATCH, drawlatch.version, "drawlatch"));
  } else {
    let base = null;
    if (drawlatch.tagCommit) {
      base = drawlatch.tagCommit;
      if (drawlatch.gitHead && drawlatch.gitHead !== base) {
        warnings.push(
          `npm records ${DRAWLATCH}@${drawlatch.version} as published from ${drawlatch.gitHead}, but ${dlTag} points at ${base}. Checking drift against the tag.`,
        );
      }
    } else if (drawlatch.gitHead && git.isPublishBase(drawlatch.gitHead)) {
      base = drawlatch.gitHead;
      dl.tagCommit = base;
      warnings.push(`${DRAWLATCH}@${drawlatch.version} is on npm but ${dlTag} is missing. Tagging ${base}, the commit npm recorded for it.`);
    } else {
      errors.push(
        `${DRAWLATCH}@${drawlatch.version} is on npm, but there is no ${dlTag} tag and the commit npm records for it is not a commit of this branch with ${DRAWLATCH_DIR} in it, so it was published from outside this workflow (e.g. from the standalone drawlatch repo). Bump drawlatch.`,
      );
    }
    if (base) {
      dl.driftBase = base;
      const changed = git.driftFiles(base);
      if (changed.length > 0) {
        const shown = changed.slice(0, 20).join(", ") + (changed.length > 20 ? `, and ${changed.length - 20} more` : "");
        errors.push(
          `${DRAWLATCH_DIR} changed since ${DRAWLATCH}@${drawlatch.version} was published (${base}), but its version was not bumped. Bump drawlatch (see README → Releasing). Changed: ${shown}`,
        );
      }
    }
  }

  const cb = { action: "skip", tagCommit: null };
  const cbTag = callboardTag(callboard.version);
  const tagElsewhere = callboard.tagCommit !== null && callboard.tagCommit !== head;
  if (!callboard.published) {
    cb.action = "publish";
    if (!callboard.tagCommit) cb.tagCommit = head;
    else if (tagElsewhere) errors.push(strayTag(cbTag, callboard.tagCommit, CALLBOARD, callboard.version, "callboard"));
  } else if (!tagElsewhere && (callboard.tagCommit === head || callboard.gitHead === head)) {
    // Published from this very commit: a previous run got as far as publishing.
    if (!callboard.tagCommit) {
      cb.tagCommit = head;
      warnings.push(`${CALLBOARD}@${callboard.version} was already published from this commit. Only tagging it ${cbTag}.`);
    }
  } else if (dryRun) {
    cb.action = "pack";
    warnings.push(`${CALLBOARD}@${callboard.version} is already on npm. This dry run only packs it; a real run would fail. Bump callboard.`);
  } else {
    errors.push(`${CALLBOARD}@${callboard.version} is already on npm. Bump callboard.`);
  }

  return { errors, warnings, drawlatch: dl, callboard: cb };
}

function strayTag(tag, commit, name, version, bump) {
  return `Tag ${tag} already exists at ${commit}, but ${name}@${version} is not on npm. Bump ${bump}, or delete the tag if nothing was published from it.`;
}

// ── I/O ─────────────────────────────────────────────────────────────────────

const run = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** Every published version of `name`; [] if the package doesn't exist. Throws on any other registry error. */
function publishedVersions(name) {
  try {
    const out = run("npm", ["view", name, "versions", "--json"]);
    return out ? [].concat(JSON.parse(out)) : [];
  } catch (err) {
    if (/\bE404\b/.test(String(err.stderr ?? "")) || /\bE404\b/.test(String(err.stdout ?? ""))) return [];
    throw new Error(`npm view ${name} failed:\n${err.stderr || err.message}`);
  }
}

function gitHeadOf(name, version) {
  const out = run("npm", ["view", `${name}@${version}`, "gitHead"]);
  return /^[0-9a-f]{40}$/.test(out) ? out : null;
}

function tagCommit(tag) {
  try {
    return run("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}^{commit}`]);
  } catch {
    return null;
  }
}

function packageState(name, version, tag) {
  const published = publishedVersions(name).includes(version);
  return { version, published, tagCommit: tagCommit(tag), gitHead: published ? gitHeadOf(name, version) : null };
}

const repoGit = {
  isPublishBase(sha) {
    try {
      run("git", ["merge-base", "--is-ancestor", sha, "HEAD"]);
      run("git", ["cat-file", "-e", `${sha}:${DRAWLATCH_DIR}/package.json`]);
      return true;
    } catch {
      return false;
    }
  },
  driftFiles(sha) {
    const out = run("git", ["diff", "--name-only", sha, "HEAD", "--", ...drawlatchDriftPathspec()]);
    return out ? out.split("\n") : [];
  },
};

const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));

function main() {
  const dryRun = process.env.DRY_RUN !== "false";
  const rootPkg = readJson("package.json");
  const backendPkg = readJson("backend/package.json");
  const dlPkg = readJson(`${DRAWLATCH_DIR}/package.json`);
  const head = run("git", ["rev-parse", "HEAD"]);

  const plan = planRelease({
    dryRun,
    head,
    pins: {
      "package.json": rootPkg.dependencies?.[DRAWLATCH],
      "backend/package.json": backendPkg.dependencies?.[DRAWLATCH],
    },
    drawlatch: packageState(DRAWLATCH, dlPkg.version, drawlatchTag(dlPkg.version)),
    callboard: packageState(CALLBOARD, rootPkg.version, callboardTag(rootPkg.version)),
    git: repoGit,
  });

  for (const w of plan.warnings) console.log(`::warning::${w}`);
  for (const e of plan.errors) console.log(`::error::${e}`);

  const outputs = {
    drawlatch_version: dlPkg.version,
    drawlatch_action: plan.drawlatch.action,
    drawlatch_tag: drawlatchTag(dlPkg.version),
    drawlatch_tag_commit: plan.drawlatch.tagCommit ?? "",
    callboard_version: rootPkg.version,
    callboard_action: plan.callboard.action,
    callboard_tag: callboardTag(rootPkg.version),
    callboard_tag_commit: plan.callboard.tagCommit ?? "",
  };
  const lines = Object.entries(outputs).map(([k, v]) => `${k}=${v}`);
  console.log(lines.join("\n"));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines.join("\n") + "\n");

  if (process.env.GITHUB_STEP_SUMMARY) {
    const tagCell = (tag, commit) => (commit ? `\`${tag}\` → \`${commit.slice(0, 12)}\`` : "—");
    const md = [
      `## Release plan${dryRun ? " (dry run)" : ""}`,
      "",
      "| Package | Version | Action | Tag |",
      "| --- | --- | --- | --- |",
      `| ${DRAWLATCH} | ${dlPkg.version} | ${plan.drawlatch.action} | ${tagCell(outputs.drawlatch_tag, outputs.drawlatch_tag_commit)} |`,
      `| ${CALLBOARD} | ${rootPkg.version} | ${plan.callboard.action} | ${tagCell(outputs.callboard_tag, outputs.callboard_tag_commit)} |`,
      "",
      ...plan.warnings.map((w) => `> [!WARNING]\n> ${w}\n`),
      ...plan.errors.map((e) => `> [!CAUTION]\n> ${e}\n`),
      "",
    ].join("\n");
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  }

  if (plan.errors.length > 0) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
