import { Router } from 'express';
import { folderService } from '../services/folder-service.js';

export const foldersRouter = Router();

// Browse directories and files in a given path
foldersRouter.get('/browse', async (req, res) => {
  try {
    const path = req.query.path as string;
    const showHidden = req.query.showHidden === 'true';
    const limit = parseInt(req.query.limit as string) || 500;

    if (!path) {
      return res.status(400).json({ error: 'path query parameter is required' });
    }

    const result = await folderService.browseDirectory(path, showHidden, limit);
    res.json(result);
  } catch (err: any) {
    console.error('Error browsing directory:', err);
    res.status(500).json({ error: 'Failed to browse directory', details: err.message });
  }
});

// Validate if a path exists and is accessible
foldersRouter.get('/validate', async (req, res) => {
  try {
    const path = req.query.path as string;

    if (!path) {
      return res.status(400).json({ error: 'path query parameter is required' });
    }

    const result = await folderService.validatePath(path);
    res.json(result);
  } catch (err: any) {
    console.error('Error validating path:', err);
    res.status(500).json({ error: 'Failed to validate path', details: err.message });
  }
});

// Get suggested directories for quick access
foldersRouter.get('/suggestions', async (req, res) => {
  try {
    const suggestions = folderService.getSuggestions();
    res.json({ suggestions });
  } catch (err: any) {
    console.error('Error getting suggestions:', err);
    res.status(500).json({ error: 'Failed to get suggestions', details: err.message });
  }
});

// Clear cache (useful for development/testing)
foldersRouter.post('/clear-cache', (req, res) => {
  try {
    folderService.clearCache();
    res.json({ ok: true, message: 'Cache cleared' });
  } catch (err: any) {
    console.error('Error clearing cache:', err);
    res.status(500).json({ error: 'Failed to clear cache', details: err.message });
  }
});