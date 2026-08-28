/**
 * Which contact channels the default drawlatch caller can actually deliver on.
 *
 * Settings → General lets the user enter a Discord/Telegram/email handle and
 * switch it on for `notify_user`. That only means anything if the matching
 * drawlatch connection (`discord-bot`, `telegram`, `agentmail`) exists on the
 * caller regular sessions borrow — the default caller. This module answers
 * that question so the settings page can offer only the channels that work.
 *
 * The default caller, not an agent's caller, is deliberate: contact info is a
 * single user-level record used by whichever session calls `notify_user`, and
 * regular sessions have no agent to grant them a caller.
 *
 * Failure is reported, never guessed. A missing default caller or an
 * unreachable daemon yields `configured: false` / `error`, which callers must
 * read as "unknown", not "no channels" — see `UserContactAvailability`.
 */
import { CONTACT_CHANNEL_CONNECTIONS } from "shared";
import type { NotifiableChannel, UserContactAvailability } from "shared";
import { resolveDefaultCaller } from "./agent-settings.js";
import { fetchProxyRoutes, invalidateRouteCache } from "./proxy-singleton.js";

const CHANNELS = Object.keys(CONTACT_CHANNEL_CONNECTIONS) as NotifiableChannel[];

/** Build the channels map with every channel at a fixed availability. */
function channelsWith(available: (connection: string) => boolean): UserContactAvailability["channels"] {
  return Object.fromEntries(
    CHANNELS.map((channel) => {
      const connection = CONTACT_CHANNEL_CONNECTIONS[channel];
      return [channel, { connection, available: available(connection) }];
    }),
  ) as UserContactAvailability["channels"];
}

/**
 * The connection identifiers present in a drawlatch `list_routes` listing.
 *
 * A route carries both an alias (`discord-bot`) and a display name (`Discord
 * Bot API`); the alias is what identifies the connection, but older listings
 * only carry `name`, so both are accepted — see `buildProxyConnectionsPrompt`
 * in claude.ts, which resolves route identity the same way.
 */
function routeConnectionIds(routes: unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const route of routes) {
    if (!route || typeof route !== "object") continue;
    const r = route as { alias?: unknown; name?: unknown };
    for (const id of [r.alias, r.name]) {
      if (typeof id === "string" && id.trim()) ids.add(id.trim().toLowerCase());
    }
  }
  return ids;
}

/**
 * Resolve per-channel availability from the default caller's route listing.
 *
 * `refresh` drops the cached listing first, so a connection just added in
 * drawlatch shows up without waiting out the five-minute route-cache TTL. It
 * exists for an explicit user gesture only — the settings page's refresh
 * button — because every call is a live hit on the daemon's rate limiter.
 */
export async function getUserContactAvailability(opts?: { refresh?: boolean }): Promise<UserContactAvailability> {
  const callerAlias = resolveDefaultCaller();
  if (!callerAlias) {
    return { configured: false, channels: channelsWith(() => false) };
  }

  if (opts?.refresh) invalidateRouteCache(callerAlias);

  const { routes, configured, stale, error } = await fetchProxyRoutes(callerAlias);
  if (!configured) {
    return { configured: false, callerAlias, channels: channelsWith(() => false) };
  }

  // A failed fetch with no cached listing means we don't know what is
  // connected. Report the error and no availability; the UI fails open on it.
  if (error && routes.length === 0) {
    return { configured: true, callerAlias, error, channels: channelsWith(() => false) };
  }

  const present = routeConnectionIds(routes);
  return {
    configured: true,
    callerAlias,
    ...(stale && { stale: true }),
    channels: channelsWith((connection) => present.has(connection.toLowerCase())),
  };
}
