/**
 * Which `@earendil-works/pi-ai` a test's bare import actually reached, and
 * which one the pinned `pi-coding-agent` depends on.
 *
 * Tests import pi-ai through its package exports (`@earendil-works/pi-ai/models`,
 * `…/api/*`) rather than a hand-built `dist/` path. pi-ai is a transitive
 * dependency, so that bare import resolves to whatever npm hoisted, which is
 * the right copy today and not guaranteed to stay that way. Asserting the two
 * versions agree turns a layout change into an obvious failure rather than a
 * test silently exercising some other pi-ai.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function packageJsonNear(entryUrl: string): Record<string, unknown> {
  // Every entry this is used with sits at `<pkg>/dist/<file>.js`.
  return JSON.parse(readFileSync(join(dirname(fileURLToPath(entryUrl)), "..", "package.json"), "utf-8")) as Record<string, unknown>;
}

export function piAiVersions(): { resolved: string; expected: string } {
  const resolved = packageJsonNear(import.meta.resolve("@earendil-works/pi-ai/models")).version as string;
  const codingAgent = packageJsonNear(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const expected = (codingAgent.dependencies as Record<string, string>)["@earendil-works/pi-ai"];
  return { resolved, expected };
}
