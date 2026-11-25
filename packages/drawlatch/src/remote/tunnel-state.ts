/**
 * Process-wide tunnel state (item C).
 *
 * The self-managed cloudflared tunnel is brought up in `main()` after the
 * server is listening but before ingestors start. Its public URL is recorded
 * here so the admin API (`/api/admin/meta`), the Overview page, and
 * `drawlatch status` can surface it without re-parsing cloudflared output.
 *
 * Mirrors `process.env.DRAWLATCH_TUNNEL_URL` (which secret resolution reads),
 * but as typed module state the dashboard can query.
 */

let tunnelUrl: string | null = null;

export function setTunnelUrl(url: string | null): void {
  tunnelUrl = url;
}

export function getTunnelUrl(): string | null {
  // Fall back to the env var so out-of-process resolution stays consistent.
  return tunnelUrl ?? process.env.DRAWLATCH_TUNNEL_URL ?? null;
}
