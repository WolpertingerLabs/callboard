/**
 * Which contact channels any drawlatch caller on this instance can deliver on.
 *
 * Settings → General lets the user enter a Discord/Telegram/email handle and
 * switch it on for `notify_user`. That only means anything if the matching
 * drawlatch connection (`discord-bot`, `telegram`, `agentmail`) exists on a
 * caller some session can actually use. This module answers that question so
 * the settings page can offer only the channels that work.
 *
 * ## Why more than the default caller
 *
 * Sessions get their caller from one of two places (`claude.ts`, search
 * `proxyKeyAlias`): a regular session borrows the configured DEFAULT caller,
 * while an agent session uses only the agent's own `mcpKeyAlias` and never
 * falls back to the default. Gating on the default alone therefore locks the
 * user out of a channel their agents can deliver on today — and on an install
 * that deliberately sets no default (`defaultCallerLocal: ""`, a supported
 * configuration) it would grey out the entire section while every agent
 * notifies fine. So availability is the union over the default caller and
 * every caller an agent is bound to, and each channel records which callers
 * provide it, so the UI can say "your default can't, but agent X can".
 *
 * ## Failure is reported, never guessed
 *
 * `configured: false` means there is no usable caller at all — determinate.
 * Anything else that goes wrong (daemon unreachable, a caller whose client
 * won't build) sets `error` and is INDETERMINATE: consumers fail open, because
 * "not connected" and "couldn't ask" are not the same answer and only one of
 * them justifies taking the user's controls away.
 */
import { CONTACT_CHANNEL_CONNECTIONS } from "shared";
import type { NotifiableChannel, UserContactAvailability } from "shared";
import { resolveDefaultCaller, listEnrolledCallers } from "./agent-settings.js";
import { fetchProxyRoutes } from "./proxy-singleton.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("contact-availability");

const CHANNELS = Object.keys(CONTACT_CHANNEL_CONNECTIONS) as NotifiableChannel[];

/** Build the channels map from a per-connection lookup of providing callers. */
function buildChannels(providers: (connection: string) => string[]): UserContactAvailability["channels"] {
  return Object.fromEntries(
    CHANNELS.map((channel) => {
      const connection = CONTACT_CHANNEL_CONNECTIONS[channel];
      const providedBy = providers(connection);
      return [channel, { connection, available: providedBy.length > 0, ...(providedBy.length > 0 && { providedBy }) }];
    }),
  ) as UserContactAvailability["channels"];
}

/**
 * The connection identifiers present in a drawlatch `list_routes` listing.
 *
 * `alias ?? name` matches `buildProxyConnectionsPrompt` in claude.ts exactly.
 * Accepting `name` as well as (rather than instead of) the alias would mark a
 * custom connector called "Telegram" as satisfying the `telegram` connection
 * that `notify_user` then tells the agent to reach for, which that caller does
 * not have — a false positive in the one direction that matters.
 */
function routeConnectionIds(routes: unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const route of routes) {
    if (!route || typeof route !== "object") continue;
    const r = route as { alias?: unknown; name?: unknown };
    const id = typeof r.alias === "string" && r.alias.trim() ? r.alias : r.name;
    if (typeof id === "string" && id.trim()) ids.add(id.trim().toLowerCase());
  }
  return ids;
}

/** Callers a session on this instance could be given, default one first. */
function candidateCallers(): { alias: string; isDefault: boolean }[] {
  const defaultAlias = resolveDefaultCaller();
  const callers = defaultAlias ? [{ alias: defaultAlias, isDefault: true }] : [];

  try {
    // Agent sessions use only their own caller, so a caller with an agent bound
    // to it is reachable even when it is not the default.
    for (const caller of listEnrolledCallers()) {
      if (caller.alias === defaultAlias || caller.agents.length === 0) continue;
      callers.push({ alias: caller.alias, isDefault: false });
    }
  } catch (err: unknown) {
    // Enumeration is best-effort: losing it narrows the answer to the default
    // caller rather than failing the whole check.
    log.warn(`Could not enumerate enrolled callers: ${err instanceof Error ? err.message : String(err)}`);
  }

  return callers;
}

/**
 * Resolve per-channel availability across every usable caller.
 *
 * `refresh` asks the daemon live instead of reading the short-TTL route cache,
 * so a connection just added in drawlatch shows up without waiting the cache
 * out. It exists for an explicit user gesture only — the settings page's
 * refresh button — and `fetchProxyRoutes` throttles it per caller.
 */
export async function getUserContactAvailability(opts?: { refresh?: boolean }): Promise<UserContactAvailability> {
  const callers = candidateCallers();
  const defaultCaller = callers.find((c) => c.isDefault);

  if (callers.length === 0) {
    return { configured: false, channelsKnown: true, channels: buildChannels(() => []) };
  }

  const listings = await Promise.all(
    callers.map(async (caller) => ({
      caller,
      ...(await fetchProxyRoutes(caller.alias, { force: opts?.refresh })),
    })),
  );

  // A caller whose client won't build reports `configured: false` from
  // fetchProxyRoutes — that is "couldn't ask this caller", not "this caller
  // has nothing", so it joins the error bucket rather than the answer.
  const errors = listings.filter((l) => !l.configured || (l.error && l.routes.length === 0));
  const usable = listings.filter((l) => l.configured && !(l.error && l.routes.length === 0));

  if (usable.length === 0) {
    const error = errors.map((e) => e.error).find(Boolean) || `No usable drawlatch caller (${errors.map((e) => e.caller.alias).join(", ")})`;
    return {
      configured: true,
      channelsKnown: false,
      ...(defaultCaller && { callerAlias: defaultCaller.alias }),
      error,
      channels: buildChannels(() => []),
    };
  }

  const present = usable.map((l) => ({ alias: l.caller.alias, ids: routeConnectionIds(l.routes) }));

  return {
    configured: true,
    channelsKnown: true,
    ...(defaultCaller && { callerAlias: defaultCaller.alias }),
    // Stale or partly-failed answers still gate, but say so: a listing served
    // from cache after a failed refresh must not look like a fresh one.
    ...(usable.some((l) => l.stale) && { stale: true }),
    ...(errors.length > 0 && { error: errors.map((e) => e.error).find(Boolean) || `Could not read ${errors.map((e) => e.caller.alias).join(", ")}` }),
    channels: buildChannels((connection) => present.filter((p) => p.ids.has(connection.toLowerCase())).map((p) => p.alias)),
  };
}
