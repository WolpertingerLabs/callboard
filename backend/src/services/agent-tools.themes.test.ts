/**
 * The two theme-writing tools an agent can actually reach.
 *
 * `generate_theme` was the only guarded write on this branch, and `update_theme`
 * sat directly beside it in the same tool list with no correction, no audit and
 * no name filter. That is the wrong one to leave open: "make the warning colour
 * a bit more orange" is a request an agent answers with `update_theme`, not by
 * regenerating, and when `generate_theme` refused a theme the natural recovery
 * was to hand-author the same colours through here. The gate has to be on the
 * tool, which is what these drive.
 *
 * The tools are pulled off the spec `buildAgentToolsSpec` returns and called
 * directly, so nothing here needs a live agent.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-agent-themes-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;
const themesDir = join(tmpRoot, "themes");
mkdirSync(themesDir, { recursive: true });

const { buildAgentToolsSpec } = await import("./agent-tools.js");
const { BUILTIN_PALETTE } = await import("./theme-contrast-palette.js");
const { THEME_VARIABLE_NAMES } = await import("./theme-variables.js");
const { measureMode } = await import("./theme-contrast.js");
const { prepareThemeWrite } = await import("./theme-write.js");

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

const spec = buildAgentToolsSpec("test-agent");
function tool(name: string) {
  const found = spec.tools.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
}

/** Call a tool and hand back the text it returned. */
async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const result = await tool(name).handler(args as never);
  return (result.content as Array<{ text: string }>).map((c) => c.text).join("");
}

const THEME_FILE = join(themesDir, "Editable.json");
const surface = (palette: Record<string, string>) => Object.fromEntries(THEME_VARIABLE_NAMES.map((n) => [n, palette[n]]));

/**
 * A theme that is already clean — which is what a stored theme now is, since
 * every path that writes one runs the gate. Seeding the fixture with the raw
 * built-in palette instead would mean every edit reported corrections to
 * unrelated variables, which is the palette's own 24 failures showing through
 * rather than anything the edit did.
 */
const CLEAN = prepareThemeWrite({ dark: surface(BUILTIN_PALETTE.dark), light: surface(BUILTIN_PALETTE.light) });

beforeEach(() => {
  writeFileSync(
    THEME_FILE,
    JSON.stringify(
      {
        name: "Editable",
        dark: CLEAN.dark,
        light: CLEAN.light,
        createdAt: "2026-07-28T00:00:00.000Z",
        updatedAt: "2026-07-28T00:00:00.000Z",
      },
      null,
      2,
    ),
    "utf8",
  );
});

const stored = () => JSON.parse(readFileSync(THEME_FILE, "utf8"));

describe("update_theme — the gate an agent actually reaches", () => {
  it("corrects a value a lightness move can rescue, and says which it moved", async () => {
    // amber-500 as the triggered badge: 1.71:1 as text on a 15% tint of itself.
    // The unguarded version wrote it to disk exactly as asked.
    const text = await call("update_theme", { name: "Editable", light: { "status-triggered": "#f59e0b" } });

    expect(text).toContain("correctedForContrast");
    expect(stored().light["status-triggered"]).not.toBe("#f59e0b");
    const measured = measureMode(stored().light, "light").find((m) => m.pairing.id === "chatlist-badge-triggered");
    expect(measured!.ratio).toBeGreaterThanOrEqual(4.5);
  });

  it("refuses a write nothing legal fixes, and names the pairings", async () => {
    // A near-white hover fill whose ink is aliased to --bg: the fill is an
    // identity colour and --bg is a surface, so correction has no lever left.
    const text = await call("update_theme", { name: "Editable", light: { "accent-hover": "#fdfdfd", "text-on-accent": "var(--bg)" } });

    expect(text).toContain("NOT updated");
    // The specific clash — not "see the server log", which is the one place a
    // model reading this cannot look.
    expect(text).toContain("var(--accent-hover)");
    expect(text).toContain("primary buttons, hovered");
    // And nothing was written.
    expect(stored().light["accent-hover"]).toBe(CLEAN.light["accent-hover"]);
  });

  it("drops a derived variable rather than severing the cascade it carries", async () => {
    // The other half of what `keep()` does on the generate path: an agent asked
    // to change the triggered badge might reasonably name the badge's own
    // background, which is a color-mix of --status-triggered.
    const text = await call("update_theme", { name: "Editable", dark: { "chatlist-badge-triggered-bg": "#ff00ff" } });

    expect(text).toContain("droppedNotThemeVariables");
    // The name never lands in the file, so the badge keeps inheriting the
    // stylesheet's color-mix of the theme's own --status-triggered.
    expect(stored().dark).not.toHaveProperty("chatlist-badge-triggered-bg");
  });

  it("still does the ordinary thing for an ordinary edit", async () => {
    // A value with real headroom, stored verbatim. The gate is not a filter that
    // rewrites everything it sees — #8a5a00, a hair under on its own tint, would
    // come back as #895900, and that is the gate working, not this case.
    const text = await call("update_theme", { name: "Editable", light: { warning: "#7a4f00" } });
    expect(text).toContain("updated successfully");
    expect(text).not.toContain("correctedForContrast");
    expect(stored().light.warning).toBe("#7a4f00");
  });

  it("leaves a theme it refused untouched on disk, including its timestamp", async () => {
    const before = readFileSync(THEME_FILE, "utf8");
    await call("update_theme", { name: "Editable", dark: { text: "#0d1117" } });
    expect(readFileSync(THEME_FILE, "utf8")).toBe(before);
  });

  it("reports a missing theme without touching the gate", async () => {
    expect(await call("update_theme", { name: "Nope", light: { warning: "#8a5a00" } })).toContain("not found");
    expect(existsSync(join(themesDir, "Nope.json"))).toBe(false);
  });
});
