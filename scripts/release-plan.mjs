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
 * Both
 * - A package about to be published must not move the requested dist-tag
 *   backwards. `--tag latest`, which the workflow always passes, turns off
 *   npm's own check for that, so this one replaces it.
 *
 * These make a re-run after any partial failure safe: whatever was published
 * is skipped, whatever was not is published, and a missing tag is created on
 * the commit that was actually published. A tag that already points at the
 * right commit is left alone. A tag that points anywhere else fails the run, and
 * so does a tag that disagrees with the commit npm recorded.
 *
 * `gitHead` is the commit npm records for a published version. The workflow
 * publishes packed tarballs, which carry no gitHead of their own, so it writes
 * one into each package.json before packing (`npm pkg set gitHead=<sha>`).
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
 *
 * Not seen at all: shipping changes that start outside packages/drawlatch.
 * The root package-lock.json decides which versions of drawlatch's frontend
 * dependencies (react, react-router-dom, lucide-react) and build toolchain
 * (vite, typescript) the build uses. A lockfile change can therefore change
 * drawlatch's `frontend/dist` or `dist` without touching this directory. The
 * lockfile also changes for callboard-only reasons, so counting it would flag
 * nearly every release. When a lockfile change affects drawlatch's frontend or
 * build toolchain, bump drawlatch's version by hand.
 */
export const DRAWLATCH_NON_SHIPPING = [
  // Tests: tsconfig.json excludes them from dist, and Vite only bundles what
  // frontend/src imports. Not `**/e2e/**`: src/remote/ingestors/e2e/setup.ts
  // is not a test file, so tsc emits it into dist and it ships.
  "**/*.test.ts",
  "**/*.test.tsx",
  // JSON test fixtures, which only tests import. Only JSON: a .ts file here
  // would still be emitted into dist.
  "**/__fixtures__/**/*.json",
  // Test, lint and format config.
  "vitest.config.ts",
  "vitest.e2e.config.ts",
  "eslint.config.js",
  "tsconfig.eslint.json",
  ".prettierrc",
  ".prettierignore",
  // With a `files` list, npm packs only what that list names; .gitignore
  // can't add files to the tarball.
  ".gitignore",
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

/**
 * Directories where every change counts, whatever DRAWLATCH_NON_SHIPPING says.
 * `build` copies src/connections into dist with `cp -r`, so a fixture or any
 * other file there ships. Test files there don't (`files` has
 * `!dist/**\/*.test.*`), but counting them too is deliberate: it can only cause
 * an unneeded bump, never a missed one.
 */
export const DRAWLATCH_ALWAYS_SHIPS = ["src/connections"];

/**
 * The `git diff` pathspec lists whose union is "everything under
 * packages/drawlatch that ships". It takes two lists because git can't
 * re-include a path once an exclude pattern has removed it.
 */
export function drawlatchDriftPathspecs() {
  return [
    [DRAWLATCH_DIR, ...DRAWLATCH_NON_SHIPPING.map((p) => `:(glob,exclude)${DRAWLATCH_DIR}/${p}`)],
    DRAWLATCH_ALWAYS_SHIPS.map((p) => `${DRAWLATCH_DIR}/${p}`),
  ];
}

/**
 * Semver precedence, without a dependency: the plan runs before `npm ci`.
 * Returns <0, 0 or >0. Build metadata is ignored, as the spec says.
 */
export function compareSemver(a, b) {
  const parse = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v).trim());
    if (!m) throw new Error(`not a semver version: ${v}`);
    return { core: m.slice(1, 4).map(Number), pre: m[4] ? m[4].split(".") : [] };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length; // a release outranks its prereleases
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1; // numeric identifiers sort before alphanumeric ones
    return p < q ? -1 : 1;
  }
  return 0;
}

/**
 * True if `range` is a valid semver range, as far as npm's dist-tag rule is
 * concerned: `npm publish --tag` rejects any tag that is one ("1.2.3", "^1",
 * "v1", "1.x", "*", "1 - 2", ">=1 <2", "1 || 2"), because `npm install
 * pkg@<tag>` couldn't tell them apart. Mirrors node-semver's grammar closely
 * enough for that; no dependency, since the plan runs before `npm ci`.
 */
export function isSemverRange(range) {
  const part = "(?:x|X|\\*|0|[1-9]\\d*)";
  const comparator = new RegExp(`^(?:<=|>=|<|>|=|~>?|\\^)?\\s*v?${part}(?:\\.${part}(?:\\.${part}(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?)?)?$`);
  const trimmed = String(range).trim();
  if (trimmed === "") return true; // node-semver reads "" as "*"
  return trimmed.split("||").every((set) => {
    const s = set.trim();
    if (s === "") return true;
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(s);
    if (hyphen) return comparator.test(hyphen[1]) && comparator.test(hyphen[2]);
    // node-semver allows a space between an operator and its version (">= 1").
    return s
      .replace(/(<=|>=|<|>|=|~>?|\^)\s+/g, "$1")
      .split(/\s+/)
      .every((c) => comparator.test(c));
  });
}

/** Why `distTag` can't be used with `npm publish --tag`, or null if it can. */
export function distTagError(distTag) {
  if (typeof distTag !== "string" || distTag.trim() === "") return "dist_tag is empty. Use latest, or another dist-tag name such as next or hotfix.";
  if (distTag !== distTag.trim() || /\s/.test(distTag)) return `dist_tag ${JSON.stringify(distTag)} contains whitespace.`;
  if (isSemverRange(distTag))
    return `dist_tag ${JSON.stringify(distTag)} is a valid semver range, which npm refuses as a dist-tag. Use a name such as next or hotfix.`;
  return null;
}

/**
 * The pure decision. `drawlatch` and `callboard` are
 * `{ version, published, tagCommit, gitHead, distTags }`: `published` is
 * whether that version is on npm, `tagCommit` the commit its tag points at
 * (null if there is no tag), `gitHead` the commit npm recorded for the
 * published version (null if unpublished or not recorded) and `distTags` the
 * package's current dist-tags (`{ latest: "1.0.0" }`).
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
export function planRelease({ dryRun, head, distTag, pins, drawlatch, callboard, git }) {
  const errors = [];
  const warnings = [];

  const tagProblem = distTagError(distTag);
  if (tagProblem) errors.push(tagProblem);

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
    const gitHeadIsBase = Boolean(drawlatch.gitHead) && git.isPublishBase(drawlatch.gitHead);
    if (drawlatch.tagCommit) {
      if (gitHeadIsBase && drawlatch.gitHead !== drawlatch.tagCommit) {
        // This workflow tags the commit it published from, so it never leaves
        // this state behind: someone moved the tag, or published by hand.
        errors.push(
          `npm records ${DRAWLATCH}@${drawlatch.version} as published from ${drawlatch.gitHead}, but ${dlTag} points at ${drawlatch.tagCommit}. Move the tag to the published commit, or bump drawlatch.`,
        );
      } else {
        base = drawlatch.tagCommit;
      }
    } else if (gitHeadIsBase) {
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
  if (callboard.published && callboard.tagCommit && callboard.gitHead && callboard.gitHead !== callboard.tagCommit) {
    // As for drawlatch: this workflow tags the commit it published from.
    errors.push(
      `npm records ${CALLBOARD}@${callboard.version} as published from ${callboard.gitHead}, but ${cbTag} points at ${callboard.tagCommit}. Move the tag to the published commit, or bump callboard.`,
    );
  } else if (!callboard.published) {
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

  // Never move a dist-tag backwards (e.g. a hotfix for an older line under
  // `latest`). npm would refuse that for an implicit `latest`, but the
  // workflow always passes --tag, which turns npm's check off.
  for (const [name, pkg, action] of [
    [DRAWLATCH, drawlatch, dl.action],
    [CALLBOARD, callboard, cb.action],
  ]) {
    const current = pkg.distTags?.[distTag];
    if (!tagProblem && action === "publish" && current && compareSemver(pkg.version, current) < 0) {
      errors.push(
        `${name}@${pkg.version} is lower than ${current}, which the "${distTag}" dist-tag already points at. Publishing would move "${distTag}" backwards; run with another dist_tag (e.g. a hotfix tag).`,
      );
    }
  }

  return { errors, warnings, drawlatch: dl, callboard: cb };
}

function strayTag(tag, commit, name, version, bump) {
  return `Tag ${tag} already exists at ${commit}, but ${name}@${version} is not on npm. Bump ${bump}, or delete the tag if nothing was published from it.`;
}

// ── I/O ─────────────────────────────────────────────────────────────────────

/** Runs a command and returns trimmed stdout; throws (with `.stderr`) on a non-zero exit. */
export function runIn(cwd) {
  return (cmd, args) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const isE404 = (err) => /\bE404\b/.test(`${err?.stderr ?? ""}\n${err?.stdout ?? ""}`);

/** Every published version of `name`; [] if the package doesn't exist. Throws on any other registry error. */
export function publishedVersions(name, run) {
  try {
    const out = run("npm", ["view", name, "versions", "--json"]);
    return out ? [].concat(JSON.parse(out)) : [];
  } catch (err) {
    if (isE404(err)) return [];
    throw new Error(`npm view ${name} versions failed:\n${err.stderr || err.message}`);
  }
}

/** The package's dist-tags; {} if the package doesn't exist. Throws on any other registry error. */
export function distTagsOf(name, run) {
  try {
    const out = run("npm", ["view", name, "dist-tags", "--json"]);
    return out ? JSON.parse(out) : {};
  } catch (err) {
    if (isE404(err)) return {};
    throw new Error(`npm view ${name} dist-tags failed:\n${err.stderr || err.message}`);
  }
}

function gitHeadOf(name, version, run) {
  const out = run("npm", ["view", `${name}@${version}`, "gitHead"]);
  return /^[0-9a-f]{40}$/.test(out) ? out : null;
}

/** The repository questions planRelease asks, answered by git in `cwd`. */
export function repoGit(cwd) {
  const run = runIn(cwd);
  const ok = (args) => {
    try {
      run("git", args);
      return true;
    } catch {
      return false;
    }
  };
  return {
    tagCommit(tag) {
      try {
        return run("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}^{commit}`]);
      } catch {
        return null;
      }
    },
    isPublishBase(sha) {
      return ok(["merge-base", "--is-ancestor", sha, "HEAD"]) && ok(["cat-file", "-e", `${sha}:${DRAWLATCH_DIR}/package.json`]);
    },
    driftFiles(sha) {
      const files = new Set();
      for (const pathspec of drawlatchDriftPathspecs()) {
        const out = run("git", ["diff", "--name-only", sha, "HEAD", "--", ...pathspec]);
        if (out) for (const f of out.split("\n")) files.add(f);
      }
      return [...files].sort();
    },
  };
}

function packageState(name, version, tag, run, git) {
  const published = publishedVersions(name, run).includes(version);
  return {
    version,
    published,
    tagCommit: git.tagCommit(tag),
    gitHead: published ? gitHeadOf(name, version, run) : null,
    distTags: distTagsOf(name, run),
  };
}

const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));

function main() {
  const dryRun = process.env.DRY_RUN !== "false";
  const distTag = process.env.DIST_TAG ?? "latest"; // not ||: an emptied input must fail, not become latest
  const run = runIn(ROOT);
  const git = repoGit(ROOT);
  const rootPkg = readJson("package.json");
  const backendPkg = readJson("backend/package.json");
  const dlPkg = readJson(`${DRAWLATCH_DIR}/package.json`);
  const head = run("git", ["rev-parse", "HEAD"]);

  const plan = planRelease({
    dryRun,
    head,
    distTag,
    pins: {
      "package.json": rootPkg.dependencies?.[DRAWLATCH],
      "backend/package.json": backendPkg.dependencies?.[DRAWLATCH],
    },
    drawlatch: packageState(DRAWLATCH, dlPkg.version, drawlatchTag(dlPkg.version), run, git),
    callboard: packageState(CALLBOARD, rootPkg.version, callboardTag(rootPkg.version), run, git),
    git,
  });

  for (const w of plan.warnings) console.log(`::warning::${w}`);
  for (const e of plan.errors) console.log(`::error::${e}`);

  const outputs = {
    head,
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
      `## Release plan${dryRun ? " (dry run)" : ""}, dist-tag \`${distTag}\``,
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
