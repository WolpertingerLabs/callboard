/**
 * Safe lookups in config maps keyed by caller-supplied strings.
 *
 * Caller config maps (`listenerInstances`, `ingestorOverrides`, …) are plain
 * objects parsed from JSON, so a bracket lookup with an agent-supplied key of
 * `__proto__` returns Object.prototype, and writing through it pollutes every
 * object in the daemon: `listenerInstances.reddit.__proto__.params = {…}`
 * would hand one caller's listener params to every other caller's listener
 * that has no params of its own.
 *
 * Two layers: reject reserved and malformed keys at the tool boundary
 * (assertSafeInstanceId / assertSafeConnectionKey), and read maps by own
 * property only (ownEntry), so a key that slips through still finds nothing.
 */

/** Instance IDs, as documented on CallerConfig.listenerInstances. */
export const INSTANCE_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

/** Names that reach Object.prototype (or a constructor) through a lookup. */
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** True for `__proto__`, `constructor`, and `prototype`. */
export function isReservedKey(key: string): boolean {
  return RESERVED_KEYS.has(key);
}

/** `map[key]` if `map` has `key` as an own property, else undefined. */
export function ownEntry<T>(map: Record<string, T> | null | undefined, key: string): T | undefined {
  // null too: a hand-edited config can hold `"listenerInstances": null`.
  if (map === undefined || map === null) return undefined;
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

/** Throws unless `id` is a string matching INSTANCE_ID_REGEX and not reserved. */
export function assertSafeInstanceId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !INSTANCE_ID_REGEX.test(id) || RESERVED_KEYS.has(id)) {
    throw new Error(
      `Invalid instance_id ${JSON.stringify(id)}: must match ${String(INSTANCE_ID_REGEX)} ` +
        'and not be __proto__, constructor, or prototype.',
    );
  }
}

/** Throws unless `connection` is a non-empty string that isn't reserved. Connection
 *  aliases aren't otherwise constrained (custom connectors name their own), so
 *  existence is checked separately against the caller's routes. */
export function assertSafeConnectionKey(connection: unknown): asserts connection is string {
  if (typeof connection !== 'string' || connection === '' || RESERVED_KEYS.has(connection)) {
    throw new Error(`Invalid connection ${JSON.stringify(connection)}.`);
  }
}
