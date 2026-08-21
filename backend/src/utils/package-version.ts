/**
 * Read an installed npm package's version from its manifest on disk.
 *
 * ## Why this is not `require("<pkg>/package.json").version`
 *
 * Because that does not work, and its not working is silent. Every engine
 * package except `@openai/codex` ships an `exports` map with no
 * `"./package.json"` entry, so the require throws
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` before it can read anything — verified against
 * the installed tree for `@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`,
 * `@cline/sdk` and `@earendil-works/pi-coding-agent`.
 *
 * That is not a hypothetical. `CodexSessionProvider.checkSdkVersionOnce` used
 * exactly that pattern inside a bare `catch {}`, which meant the
 * `EXPECTED_CODEX_CLI_VERSION` drift warning — the one thing standing between a
 * rollout-format change and chats silently losing messages on resume — had never
 * fired on any machine and could not. It threw on every boot instead.
 *
 * `require.resolve.paths()` gives the `node_modules` directories Node itself
 * would search, walking up from the caller. That covers a workspace checkout
 * (hoisted to the repo root) and a global install (hoisted to the npm prefix)
 * alike, and it depends on nothing the package author controls.
 *
 * Lives in `utils/` rather than in `services/engine-status.ts` — where it was
 * written — so the Codex adapter can use it too. An adapter importing a service
 * that imports adapters is a cycle; this has no imports at all beyond `node:`.
 *
 * @see plans/engine-availability-and-install.md — Phase 1 (versions), Phase 4 (the drift check)
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);

/**
 * The installed version of `pkg`, or `undefined` when it is not installed, not
 * resolvable from here, or its manifest is unreadable.
 *
 * Never throws: every caller is reporting a fact about the install tree, and a
 * settings page that 500s because a manifest is malformed is worse than one that
 * says "unknown".
 */
export function bundledPackageVersion(pkg: string): string | undefined {
  try {
    for (const dir of require.resolve.paths(pkg) ?? []) {
      const manifest = join(dir, ...pkg.split("/"), "package.json");
      if (!existsSync(manifest)) continue;
      const version = JSON.parse(readFileSync(manifest, "utf-8"))?.version;
      if (typeof version === "string" && version) return version;
    }
  } catch {
    // A manifest that is not JSON, a permission error mid-walk — the answer is
    // "could not read a version", which is what `undefined` says.
  }
  return undefined;
}
