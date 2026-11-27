/**
 * Decides what the publish workflow (.github/workflows/publish.yml) does.
 *
 * Every package in this repo shares one version, the root package.json's
 * (scripts/versions.mjs). A release publishes both callboard and drawlatch
 * (packages/drawlatch) at that version `V`, from one commit, drawlatch first
 * because callboard pins it exactly, and tags that commit `v<V>`. This script
 * looks at the registry and the tag and prints, as step outputs, one action per
 * package and one tag target. The workflow's later steps only carry those out,
 * so every decision lives here and is unit-tested (release-plan.test.mjs).
 *
 * The rules:
 *
 * - Every package, pin and lockfile must agree on `V` (versionDriftErrors, the
 *   same check deps:check runs), checked here before `npm ci` so drift fails
 *   in seconds.
 * - Neither package on npm at `V`: publish both from HEAD and tag HEAD `v<V>`.
 *   A `v<V>` tag already at HEAD is fine (nothing to tag); one anywhere else
 *   fails the run.
 * - Either one on npm: find the commit it was published from, its "base":
 *   npm's `gitHead` if that is HEAD or an ancestor with packages/drawlatch in it
 *   (isPublishBase), or, when npm recorded no gitHead, the `v<V>` tag. Anything
 *   else was published outside this workflow (the standalone drawlatch repo,
 *   say) and fails the run. Both published from different bases, or a tag that
 *   disagrees with the base, fails too.
 *   - Base is HEAD (an earlier attempt of this commit got partway): publish
 *     whichever isn't on npm yet, and tag HEAD if the tag is missing. All
 *     published and tagged is a no-op success.
 *   - Base is an older commit:
 *     - both published, no tag: tag the base, publish nothing (and warn: to
 *       release HEAD, bump the version);
 *     - both published and tagged: fail, `V` is already released ("bump the
 *       version"); a dry run warns and only packs, so a rehearsal still works
 *       before the bump;
 *     - only one published (a partial release, and main has moved since):
 *       fail. Re-running the original run (GitHub allows that within 30
 *       days) finishes it, since a re-run keeps that run's commit: "Re-run
 *       failed jobs" with the tarballs it packed (kept 7 days), "Re-run all
 *       jobs" by re-planning on the base. Otherwise bump the version. A dry
 *       run warns and only packs.
 * - A package about to be published must not move the requested dist-tag
 *   backwards. `--tag latest`, which the workflow always passes, turns off
 *   npm's own check for that, so this one replaces it. Checked per package:
 *   the two can have different current dist-tags.
 *
 * These make a re-run of the same commit after any partial failure safe:
 * whatever was published is skipped, whatever was not is published, and a
 * missing tag is created on the commit that was actually published.
 *
 * `gitHead` is the commit npm records for a published version. The workflow
 * publishes packed tarballs, which carry no gitHead of their own, so it writes
 * one into each package.json before packing (`npm pkg set gitHead=<sha>`).
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SEMVER_RE, readVersionState, versionDriftErrors } from "./versions.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const DRAWLATCH = "@wolpertingerlabs/drawlatch";
export const CALLBOARD = "@wolpertingerlabs/callboard";
export const DRAWLATCH_DIR = "packages/drawlatch";

/** The one git tag a release gets. */
export const releaseTag = (version) => `v${version}`;

/**
 * Semver precedence, without a dependency: the plan runs before `npm ci`.
 * Returns <0, 0 or >0. Build metadata is ignored, as the spec says.
 */
export function compareSemver(a, b) {
  const parse = (v) => {
    const m = SEMVER_RE.exec(String(v).trim().replace(/^v/, "")); // a registry or user "v1.2.3" still compares
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
 * The pure decision. `drawlatch` and `callboard` are `{ published, gitHead,
 * distTags }` for the shared `version`: `published` is whether that version is
 * on npm, `gitHead` the commit npm recorded for it (null if unpublished or not
 * recorded) and `distTags` the package's current dist-tags (`{ latest: "1.0.0" }`).
 * `tagCommit` is the commit `v<version>` points at, or null. `versionErrors`
 * is versionDriftErrors' output for the checkout.
 *
 * `git.isPublishBase(sha)`: sha is HEAD or an ancestor of it and has
 * packages/drawlatch in it, so it is a monorepo commit, not one of the
 * standalone repo's imported ones.
 *
 * Returns `{ errors, warnings, drawlatch: { action }, callboard: { action },
 * tag: { name, commit } }`. An action is "publish", "pack" (dry run only: the
 * run would fail, so it only packs) or "skip". A `tag.commit` of null means
 * there is nothing to tag. When `errors` is non-empty the run must stop before
 * publishing anything.
 */
export function planRelease({ dryRun, head, distTag, version, versionErrors = [], drawlatch, callboard, tagCommit, git }) {
  const errors = [...versionErrors];
  const warnings = [];
  const tagProblem = distTagError(distTag);
  if (tagProblem) errors.push(tagProblem);

  const tag = { name: releaseTag(version), commit: null };
  const dl = { action: "skip" };
  const cb = { action: "skip" };
  const packages = [
    [DRAWLATCH, drawlatch, dl],
    [CALLBOARD, callboard, cb],
  ];
  const result = () => ({ errors, warnings, drawlatch: dl, callboard: cb, tag });
  const published = packages.filter(([, pkg]) => pkg.published);

  if (published.length === 0) {
    dl.action = cb.action = "publish";
    if (!tagCommit) tag.commit = head;
    else if (tagCommit !== head)
      errors.push(
        `Tag ${tag.name} already exists at ${tagCommit}, but ${version} is not on npm. Bump the version, or delete the tag if nothing was published from it.`,
      );
  } else {
    // The commit each published package came from.
    const bases = [];
    for (const [name, pkg] of published) {
      if (pkg.gitHead && git.isPublishBase(pkg.gitHead)) bases.push([name, pkg.gitHead]);
      else if (!pkg.gitHead && tagCommit) bases.push([name, tagCommit]);
      else
        errors.push(
          `${name}@${version} is on npm, but npm records it as published from ${pkg.gitHead ?? "no commit"}, which isn't a commit of this branch with ${DRAWLATCH_DIR} in it, so it was published outside this workflow (from the standalone drawlatch repo, say). Bump the version.`,
        );
    }
    if (bases.length < published.length) return result();
    if (bases.length === 2 && bases[0][1] !== bases[1][1]) {
      errors.push(`${bases[0][0]}@${version} was published from ${bases[0][1]} and ${bases[1][0]}@${version} from ${bases[1][1]}. Bump the version.`);
      return result();
    }
    const base = bases[0][1];
    if (tagCommit && tagCommit !== base) {
      // This workflow tags the commit it published from, so it never leaves
      // this state behind: someone moved the tag, or published by hand.
      errors.push(
        `npm records ${version} as published from ${base}, but ${tag.name} points at ${tagCommit}. Move the tag to the published commit, or bump the version.`,
      );
      return result();
    }

    if (base === head) {
      // A previous attempt of this commit got partway: finish it.
      for (const [, pkg, plan] of packages) if (!pkg.published) plan.action = "publish";
      if (!tagCommit) tag.commit = head;
      if (published.length === 2 && !tagCommit) warnings.push(`${version} was already published from this commit. Only tagging it ${tag.name}.`);
      if (callboard.published && !drawlatch.published)
        warnings.push(`${CALLBOARD}@${version} is on npm but ${DRAWLATCH}@${version} isn't, so it couldn't be installed until now. Publishing drawlatch.`);
    } else if (published.length === 2 && !tagCommit) {
      tag.commit = base;
      warnings.push(`${version} was already released from ${base}; tagging it ${tag.name}. Nothing was published. To release HEAD, bump the version.`);
    } else {
      const problem =
        published.length === 2
          ? `${version} is already on npm (released from ${base}). Bump the version.`
          : `${version} was partly released from ${base} (${published[0][0]} is on npm, ${packages.find(([, pkg]) => !pkg.published)[0]} is not), and main is now at ${head}. Finish it by re-running the original run within 30 days of it ("Re-run failed jobs" reuses its tarballs, packed from ${base}, for 7 days; "Re-run all jobs" re-plans on ${base}), or bump the version.`;
      if (dryRun) {
        dl.action = cb.action = "pack";
        warnings.push(`${problem} This dry run only packs; a real run would fail.`);
      } else errors.push(problem);
    }
  }

  // Never move a dist-tag backwards (e.g. a hotfix for an older line under
  // `latest`). npm would refuse that for an implicit `latest`, but the
  // workflow always passes --tag, which turns npm's check off.
  if (!tagProblem)
    for (const [name, pkg, plan] of packages) {
      const current = pkg.distTags?.[distTag];
      if (plan.action === "publish" && current && compareSemver(version, current) < 0)
        errors.push(
          `${name}@${version} is lower than ${current}, which the "${distTag}" dist-tag already points at. Publishing would move "${distTag}" backwards; run with another dist_tag (e.g. a hotfix tag).`,
        );
    }

  return result();
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
  };
}

function packageState(name, version, run) {
  const published = publishedVersions(name, run).includes(version);
  return { published, gitHead: published ? gitHeadOf(name, version, run) : null, distTags: distTagsOf(name, run) };
}

function main() {
  const dryRun = process.env.DRY_RUN !== "false";
  const distTag = process.env.DIST_TAG ?? "latest"; // not ||: an emptied input must fail, not become latest
  const run = runIn(ROOT);
  const git = repoGit(ROOT);
  let state;
  try {
    state = readVersionState(ROOT);
  } catch (err) {
    console.log(`::error::${err.message}`); // a missing or broken manifest, named
    process.exit(1);
  }
  const { version } = state;
  const head = run("git", ["rev-parse", "HEAD"]);
  const tag = releaseTag(version);

  const plan = planRelease({
    dryRun,
    head,
    distTag,
    version,
    versionErrors: versionDriftErrors(state),
    drawlatch: packageState(DRAWLATCH, version, run),
    callboard: packageState(CALLBOARD, version, run),
    tagCommit: git.tagCommit(tag),
    git,
  });

  for (const w of plan.warnings) console.log(`::warning::${w}`);
  for (const e of plan.errors) console.log(`::error::${e}`);

  const outputs = {
    head,
    version,
    tag,
    tag_commit: plan.tag.commit ?? "",
    drawlatch_action: plan.drawlatch.action,
    callboard_action: plan.callboard.action,
  };
  const lines = Object.entries(outputs).map(([k, v]) => `${k}=${v}`);
  console.log(lines.join("\n"));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines.join("\n") + "\n");

  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = [
      `## Release plan${dryRun ? " (dry run)" : ""}: ${version}, dist-tag \`${distTag}\``,
      "",
      "| Package | Version | Action |",
      "| --- | --- | --- |",
      `| ${DRAWLATCH} | ${version} | ${plan.drawlatch.action} |`,
      `| ${CALLBOARD} | ${version} | ${plan.callboard.action} |`,
      "",
      `Tag: ${plan.tag.commit ? `\`${tag}\` → \`${plan.tag.commit.slice(0, 12)}\`` : "—"}`,
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
