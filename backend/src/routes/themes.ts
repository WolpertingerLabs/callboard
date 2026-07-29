import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { themeFileService } from "../services/theme-file-service.js";
import { generateThemeCSS } from "../services/quick-completion.js";
import { prepareThemeWrite, describeFailures } from "../services/theme-write.js";
import type { PreparedThemeWrite } from "../services/theme-write.js";
import type { CustomTheme } from "shared/types/index.js";

export const themesRouter = Router();

/**
 * The 422 a gated write returns when it cannot be brought up to AA.
 *
 * It names the pairings rather than the fact of failure: a client that can see
 * which colours clashed can fix the one that is wrong, and one that cannot is
 * reduced to guessing. `allowBelowAA` is offered back explicitly, because the
 * caller reaching this over HTTP may well be a person who meant it — see
 * theme-write.ts for why that opt-out exists here and nowhere else.
 */
function refuseSubAA(res: Response, prepared: PreparedThemeWrite): void {
  res.status(422).json({
    error: `Refusing to store a theme with ${prepared.unsatisfiable.length} pairing(s) below WCAG AA that no lightness adjustment fixes.`,
    unsatisfiable: prepared.unsatisfiable,
    details: describeFailures(prepared.unsatisfiable),
    hint: "Choose genuinely different colours for the variables involved, or resend with allowBelowAA: true to store them as written.",
  });
}

// List all themes
themesRouter.get("/", (_req: Request, res: Response): void => {
  const themes = themeFileService.listThemes();
  res.json({ themes });
});

// Get a single theme
themesRouter.get("/:name", (req: Request, res: Response): void => {
  const theme = themeFileService.getTheme(req.params.name);
  if (!theme) {
    res.status(404).json({ error: "Theme not found" });
    return;
  }
  res.json({ theme });
});

// Create a new theme (manual — client provides full theme data)
//
// The gate is awaited rather than called: correction yields to the event loop
// while it searches, so that a theme write does not stall every open SSE stream
// for the length of the search — see theme-contrast.ts. That makes the handler
// async, and an async handler's rejections are not Express 4's to catch, so the
// body is wrapped and handed to `next` to land where a synchronous throw
// used to.
themesRouter.post("/", async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { name, dark, light, allowBelowAA } = req.body;

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      res.status(400).json({ error: "Theme name is required" });
      return;
    }
    if (name.length > 64) {
      res.status(400).json({ error: "Theme name must be 64 characters or fewer" });
      return;
    }
    if (!dark || typeof dark !== "object") {
      res.status(400).json({ error: "Dark mode variables are required" });
      return;
    }
    if (!light || typeof light !== "object") {
      res.status(400).json({ error: "Light mode variables are required" });
      return;
    }

    const prepared = await prepareThemeWrite({ dark, light, allowBelowAA: allowBelowAA === true });
    if (prepared.unsatisfiable.length > 0) {
      refuseSubAA(res, prepared);
      return;
    }

    const now = new Date().toISOString();
    const theme: CustomTheme = {
      name: name.trim(),
      dark: prepared.dark,
      light: prepared.light,
      createdAt: now,
      updatedAt: now,
    };

    try {
      themeFileService.createTheme(theme);
      res.status(201).json({ theme, dropped: prepared.dropped, corrections: prepared.corrections, contrast: prepared.contrast });
    } catch (err: any) {
      if (err.message.includes("already exists")) {
        res.status(409).json({ error: err.message });
      } else {
        res.status(500).json({ error: "Failed to create theme", details: err.message });
      }
    }
  } catch (err) {
    next(err);
  }
});

// Generate a theme via AI
themesRouter.post("/generate", async (req: Request, res: Response): Promise<void> => {
  const { name, description } = req.body;

  if (!name || typeof name !== "string" || name.trim().length === 0) {
    res.status(400).json({ error: "Theme name is required" });
    return;
  }
  if (!description || typeof description !== "string") {
    res.status(400).json({ error: "A description of the desired theme is required" });
    return;
  }

  try {
    const result = await generateThemeCSS(name.trim(), description);
    if (!result.ok) {
      // Which pairings, not just that there were some — the settings page can
      // show them, and a caller that can see the clash can describe its way out
      // of it. See theme-write.ts / generateThemeCSS on why this is not a log line.
      res.status(result.reason === "contrast" ? 422 : 502).json({
        error:
          result.reason === "contrast"
            ? `The model chose colours that could not be brought up to WCAG AA after ${result.attempts} attempts. Nothing was saved.`
            : `The model did not return a theme after ${result.attempts} attempts. Nothing was saved.`,
        details: result.detail,
        ...(result.reason === "contrast" ? { unsatisfiable: result.unsatisfiable } : {}),
        hint: "Try describing more contrast between the accent and the background.",
      });
      return;
    }
    themeFileService.createTheme(result.theme);
    res.status(201).json({ theme: result.theme, corrections: result.corrections });
  } catch (err: any) {
    if (err.message.includes("already exists")) {
      res.status(409).json({ error: err.message });
    } else {
      res.status(500).json({ error: "Failed to generate theme", details: err.message });
    }
  }
});

// Update an existing theme (merges provided variables with existing ones)
themesRouter.put("/:name", async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { name, dark, light, allowBelowAA } = req.body;
    const originalName = req.params.name;

    if (dark && typeof dark !== "object") {
      res.status(400).json({ error: "Dark mode variables must be an object" });
      return;
    }
    if (light && typeof light !== "object") {
      res.status(400).json({ error: "Light mode variables must be an object" });
      return;
    }

    const existing = themeFileService.getTheme(originalName);
    if (!existing) {
      res.status(404).json({ error: "Theme not found" });
      return;
    }

    const prepared = await prepareThemeWrite({ dark, light, existing, allowBelowAA: allowBelowAA === true });
    if (prepared.unsatisfiable.length > 0) {
      refuseSubAA(res, prepared);
      return;
    }

    const theme: CustomTheme = {
      name: typeof name === "string" && name.trim().length > 0 ? name.trim() : existing.name,
      dark: prepared.dark,
      light: prepared.light,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };

    try {
      themeFileService.updateTheme(originalName, theme);
      res.json({ theme, dropped: prepared.dropped, corrections: prepared.corrections, contrast: prepared.contrast });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to update theme", details: err.message });
    }
  } catch (err) {
    next(err);
  }
});

// Delete a theme
themesRouter.delete("/:name", (req: Request, res: Response): void => {
  try {
    themeFileService.deleteTheme(req.params.name);
    res.json({ ok: true });
  } catch (err: any) {
    if (err.message.includes("not found")) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(500).json({ error: "Failed to delete theme", details: err.message });
    }
  }
});
