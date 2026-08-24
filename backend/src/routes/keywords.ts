import { Router } from "express";
import type { Request, Response } from "express";
import { keywordsService } from "../services/keywords-service.js";

export const keywordsRouter = Router();

// List all keywords.
//
// There is deliberately no `GET /:name` alongside this. Unlike a skill, a
// keyword has no lazily-fetched body — the list response already carries every
// field the editor and the composer need, so a per-row read would be a second
// round trip for data the client is holding.
keywordsRouter.get("/", (_req: Request, res: Response): void => {
  const keywords = keywordsService.listKeywords();
  res.json({ keywords });
});

// Create a new keyword
keywordsRouter.post("/", (req: Request, res: Response): void => {
  const { name, description, body } = req.body;

  if (!name || typeof name !== "string" || name.trim().length === 0) {
    res.status(400).json({ error: "Keyword name is required" });
    return;
  }
  // Description is optional — a keyword with no explanation is a legitimate
  // one. Only its type is checked.
  if (description !== undefined && typeof description !== "string") {
    res.status(400).json({ error: "Keyword description must be a string" });
    return;
  }
  if (!body || typeof body !== "string") {
    res.status(400).json({ error: "Keyword body is required" });
    return;
  }

  try {
    const keyword = keywordsService.createKeyword({ name, description, body });
    res.status(201).json({ keyword });
  } catch (err: any) {
    if (err.message.includes("already exists")) {
      res.status(409).json({ error: err.message });
    } else if (
      err.message.includes("required") ||
      err.message.includes("characters") ||
      err.message.includes("usable") ||
      err.message.includes("limit reached")
    ) {
      res.status(400).json({ error: err.message });
    } else {
      res.status(500).json({ error: "Failed to create keyword", details: err.message });
    }
  }
});

// Update an existing keyword (partial — only provided fields change)
keywordsRouter.put("/:name", (req: Request, res: Response): void => {
  const { name, description, body } = req.body;

  if (name !== undefined && (typeof name !== "string" || name.trim().length === 0)) {
    res.status(400).json({ error: "Keyword name must be a non-empty string" });
    return;
  }
  if (description !== undefined && typeof description !== "string") {
    res.status(400).json({ error: "Keyword description must be a string" });
    return;
  }
  if (body !== undefined && typeof body !== "string") {
    res.status(400).json({ error: "Keyword body must be a string" });
    return;
  }

  try {
    const keyword = keywordsService.updateKeyword(req.params.name, {
      ...(name !== undefined && { name }),
      ...(description !== undefined && { description }),
      ...(body !== undefined && { body }),
    });
    res.json({ keyword });
  } catch (err: any) {
    if (err.message.includes("not found")) {
      res.status(404).json({ error: err.message });
    } else if (err.message.includes("already exists")) {
      res.status(409).json({ error: err.message });
    } else if (err.message.includes("required") || err.message.includes("characters") || err.message.includes("usable")) {
      res.status(400).json({ error: err.message });
    } else {
      res.status(500).json({ error: "Failed to update keyword", details: err.message });
    }
  }
});

// Delete a keyword
keywordsRouter.delete("/:name", (req: Request, res: Response): void => {
  try {
    keywordsService.deleteKeyword(req.params.name);
    res.json({ ok: true });
  } catch (err: any) {
    if (err.message.includes("not found")) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(500).json({ error: "Failed to delete keyword", details: err.message });
    }
  }
});
