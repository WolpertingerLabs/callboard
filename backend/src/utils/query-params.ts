/**
 * An integer query parameter, with its default and bounds applied.
 *
 * Missing, non-numeric (`NaN`) or below `min` → `default`; above `max` →
 * `max`. Parsed with `parseInt(…, 10)`, so `"20abc"` is 20, as every call site
 * read it before this existed. `min` is per call site on purpose: some routes
 * have always treated `0` as "use the default" and others as a real value.
 */
export function parseIntParam(value: unknown, opts: { default: number; min?: number; max?: number }): number {
  if (value === undefined || value === null || value === "") return opts.default;
  const n = parseInt(String(value), 10);
  if (!Number.isFinite(n) || (opts.min !== undefined && n < opts.min)) return opts.default;
  return opts.max !== undefined && n > opts.max ? opts.max : n;
}
