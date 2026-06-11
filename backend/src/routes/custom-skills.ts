import { Router } from "express";
import type { Request, Response } from "express";
import { customSkillsService } from "../services/custom-skills-service.js";

export const customSkillsRouter = Router();

// List all custom skills
customSkillsRouter.get("/", (_req: Request, res: Response): void => {
  const skills = customSkillsService.listSkills();
  res.json({ skills });
});

// Get a single custom skill (full content)
customSkillsRouter.get("/:name", (req: Request, res: Response): void => {
  const skill = customSkillsService.getSkill(req.params.name);
  if (!skill) {
    res.status(404).json({ error: "Skill not found" });
    return;
  }
  res.json({ skill });
});

// Create a new custom skill
customSkillsRouter.post("/", (req: Request, res: Response): void => {
  const { name, description, content } = req.body;

  if (!name || typeof name !== "string" || name.trim().length === 0) {
    res.status(400).json({ error: "Skill name is required" });
    return;
  }
  if (!description || typeof description !== "string") {
    res.status(400).json({ error: "Skill description is required" });
    return;
  }
  if (!content || typeof content !== "string") {
    res.status(400).json({ error: "Skill content is required" });
    return;
  }

  try {
    const skill = customSkillsService.createSkill({ name, description, content });
    res.status(201).json({ skill });
  } catch (err: any) {
    if (err.message.includes("already exists")) {
      res.status(409).json({ error: err.message });
    } else if (err.message.includes("required") || err.message.includes("characters") || err.message.includes("usable")) {
      res.status(400).json({ error: err.message });
    } else {
      res.status(500).json({ error: "Failed to create skill", details: err.message });
    }
  }
});

// Update an existing custom skill (partial — only provided fields change)
customSkillsRouter.put("/:name", (req: Request, res: Response): void => {
  const { name, description, content } = req.body;

  if (name !== undefined && (typeof name !== "string" || name.trim().length === 0)) {
    res.status(400).json({ error: "Skill name must be a non-empty string" });
    return;
  }
  if (description !== undefined && typeof description !== "string") {
    res.status(400).json({ error: "Skill description must be a string" });
    return;
  }
  if (content !== undefined && typeof content !== "string") {
    res.status(400).json({ error: "Skill content must be a string" });
    return;
  }

  try {
    const skill = customSkillsService.updateSkill(req.params.name, {
      ...(name !== undefined && { name }),
      ...(description !== undefined && { description }),
      ...(content !== undefined && { content }),
    });
    res.json({ skill });
  } catch (err: any) {
    if (err.message.includes("not found")) {
      res.status(404).json({ error: err.message });
    } else if (err.message.includes("already exists")) {
      res.status(409).json({ error: err.message });
    } else if (err.message.includes("required") || err.message.includes("characters") || err.message.includes("usable")) {
      res.status(400).json({ error: err.message });
    } else {
      res.status(500).json({ error: "Failed to update skill", details: err.message });
    }
  }
});

// Delete a custom skill
customSkillsRouter.delete("/:name", (req: Request, res: Response): void => {
  try {
    customSkillsService.deleteSkill(req.params.name);
    res.json({ ok: true });
  } catch (err: any) {
    if (err.message.includes("not found")) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(500).json({ error: "Failed to delete skill", details: err.message });
    }
  }
});
