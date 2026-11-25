import express, { type Express } from "express";

/**
 * Serve the built frontend from `dir`, with every other GET answered by its
 * `index.html` so client-side routes load on a refresh or a deep link.
 *
 * `/{*splat}` is path-to-regexp v8's spelling of Express 4's `*`: the braces
 * make the wildcard optional, so it matches `/` too. Shared by index.ts and
 * the hardening wire test so the two cannot drift apart.
 *
 * `index.html` is sent relative to `root`, not as an absolute path: send 1.x
 * applies `dotfiles: "ignore"` to every segment of an absolute path, so an
 * install under a dot-directory (`~/.nvm`, `~/.npm-global`, `~/.volta`,
 * `~/.local`) would answer every deep link with 404. Only the path below
 * `root` is checked.
 */
export function serveSpa(app: Express, dir: string): void {
  app.use(express.static(dir));
  app.get("/{*splat}", (_req, res) => res.sendFile("index.html", { root: dir }));
}
