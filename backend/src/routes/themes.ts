import { Router } from "express";
import type { Request, Response } from "express";
import { themeFileService } from "../services/theme-file-service.js";
import { generateThemeCSS } from "../services/quick-completion.js";
import type { CustomTheme } from "shared/types/index.js";

export const themesRouter = Router();

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
themesRouter.post("/", (req: Request, res: Response): void => {
  const { name, dark, light } = req.body;

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

  const now = new Date().toISOString();
  const theme: CustomTheme = {
    name: name.trim(),
    dark,
    light,
    createdAt: now,
    updatedAt: now,
  };

  try {
    themeFileService.createTheme(theme);
    res.status(201).json({ theme });
  } catch (err: any) {
    if (err.message.includes("already exists")) {
      res.status(409).json({ error: err.message });
    } else {
      res.status(500).json({ error: "Failed to create theme", details: err.message });
    }
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
    const theme = await generateThemeCSS(name.trim(), description);
    if (!theme) {
      res.status(500).json({ error: "Failed to generate theme — AI did not return valid CSS variables" });
      return;
    }
    themeFileService.createTheme(theme);
    res.status(201).json({ theme });
  } catch (err: any) {
    if (err.message.includes("already exists")) {
      res.status(409).json({ error: err.message });
    } else {
      res.status(500).json({ error: "Failed to generate theme", details: err.message });
    }
  }
});

// Update an existing theme
themesRouter.put("/:name", (req: Request, res: Response): void => {
  const { name, dark, light } = req.body;
  const originalName = req.params.name;

  if (!name || typeof name !== "string" || name.trim().length === 0) {
    res.status(400).json({ error: "Theme name is required" });
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

  const existing = themeFileService.getTheme(originalName);
  if (!existing) {
    res.status(404).json({ error: "Theme not found" });
    return;
  }

  const theme: CustomTheme = {
    name: name.trim(),
    dark,
    light,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };

  try {
    themeFileService.updateTheme(originalName, theme);
    res.json({ theme });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to update theme", details: err.message });
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
