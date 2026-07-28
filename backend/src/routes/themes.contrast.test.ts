/**
 * The stored-theme audit, over the wire the settings page actually reads.
 *
 * The engine's own tests prove the numbers; this proves the part only the route
 * and the file service decide — that a theme's failures reach the client at all,
 * that a theme is measured as the browser would see it (a variable it never
 * defined still cascading from the stylesheet), and above all that reading a
 * stored theme leaves the file on disk byte for byte unchanged.
 *
 * Handlers are pulled off the router stack and driven with a fake req/res,
 * matching the no-supertest style in workspaces.create-rename.test.ts.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-themes-contrast-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;
const themesDir = join(tmpRoot, "themes");
mkdirSync(themesDir, { recursive: true });

const { themesRouter } = await import("./themes.js");

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

/**
 * A theme in the shape of the one theme that exists on the author's machine:
 * a partial override that names --status-triggered but not --status-green or
 * --info-bg, which is the asymmetry this branch closes.
 */
const PARTIAL_THEME = {
  name: "Sub AA",
  dark: {
    bg: "#1a1625",
    surface: "#221d30",
    text: "#f5e6d0",
    "text-muted": "#a896b8",
    accent: "#f0a030",
    warning: "#f09030",
    "warning-bg": "rgba(240,144,48,0.1)",
    "status-triggered": "#f0a030",
  },
  light: {
    bg: "#fff4ea",
    surface: "#fffaf4",
    text: "#3a1e0a",
    "text-muted": "#8a5830",
    accent: "#d96a10",
    // 3.25:1 on the sidebar warning strip — under AA, and nothing rewrites it.
    warning: "#c86010",
    "warning-bg": "rgba(200,96,16,0.09)",
    "status-triggered": "#d96a10",
  },
  createdAt: "2026-03-07T12:49:48.328Z",
  updatedAt: "2026-03-07T12:49:48.328Z",
};

const themeFile = join(themesDir, "Sub AA.json");
const onDisk = JSON.stringify(PARTIAL_THEME, null, 2);
writeFileSync(themeFile, onDisk, "utf8");

function handlerFor(path: string, method: "get" | "post") {
  return (themesRouter as any).stack.find((layer: any) => layer.route?.path === path && layer.route.methods[method]).route.stack[0].handle as (
    req: Request,
    res: Response,
  ) => void;
}

function invoke(handler: (req: Request, res: Response) => void, req: Partial<Request>): Promise<{ code: number; body: any }> {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ code: this.statusCode, body: payload });
        return this;
      },
    };
    handler({ params: {}, body: {}, query: {}, ...req } as unknown as Request, res as unknown as Response);
  });
}

const list = () => invoke(handlerFor("/", "get"), {});

describe("GET /api/themes — contrast report", () => {
  it("reports each stored theme's failing pairings", async () => {
    const res = await list();
    expect(res.code).toBe(200);
    const theme = res.body.themes.find((t: any) => t.name === "Sub AA");
    expect(theme.contrast.checked).toBeGreaterThan(0);
    expect(theme.contrast.failures.length).toBeGreaterThan(0);
  });

  it("names the sidebar warning strip at the ratio it actually paints", async () => {
    const res = await list();
    const failures = res.body.themes[0].contrast.failures;
    const strip = failures.find((f: any) => f.id === "warning-on-warning-bg-sidebar" && f.mode === "light");
    expect(strip).toBeDefined();
    expect(strip.ratio).toBeCloseTo(3.25, 2);
    expect(strip.required).toBe(4.5);
    // The report says where, not just what — the point is a human can act on it.
    expect(strip.where).toContain("FolderListItem");
  });

  it("sorts worst first, so the top of the list is the thing to fix", async () => {
    const res = await list();
    const ratios = res.body.themes[0].contrast.failures.map((f: any) => f.ratio ?? 0);
    expect([...ratios].sort((a: number, b: number) => a - b)).toEqual(ratios);
  });

  it("measures inherited variables through the stylesheet, as the browser would", async () => {
    // This theme never defines --status-green. It must still be measured — at
    // the stylesheet's value — rather than skipped as unmeasurable.
    const res = await list();
    const failures = res.body.themes[0].contrast.failures;
    expect(failures.some((f: any) => f.id === "status-green-dot")).toBe(false);
    expect(failures.every((f: any) => f.unmeasurable === undefined)).toBe(true);
  });

  it("does not rewrite the stored file — reporting is the whole intervention", async () => {
    const before = statSync(themeFile).mtimeMs;
    await list();
    await list();
    expect(readFileSync(themeFile, "utf8")).toBe(onDisk);
    expect(statSync(themeFile).mtimeMs).toBe(before);
  });

  it("carries the report on the single-theme route's payload shape too", async () => {
    const res = await invoke(handlerFor("/:name", "get"), { params: { name: "Sub AA" } as any });
    expect(res.code).toBe(200);
    // GET /:name returns the theme itself, unannotated — the audit rides on the
    // list, which is what the settings page renders. Assert that explicitly so
    // a future change to either shape is a deliberate one.
    expect(res.body.theme.name).toBe("Sub AA");
    expect(res.body.theme.contrast).toBeUndefined();
  });
});
