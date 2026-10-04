/**
 * One byte-size formatter for the whole UI, with presets for the ladders the
 * call sites already showed. The presets differ on purpose — a diff's binary
 * file and a storage item live at different scales — so each keeps its own
 * wording rather than being normalised to one.
 *
 * Every preset prints `N B` below 1 KiB and divides by 1024 per step.
 */
export interface ByteFormat {
  /** The ladder above bytes. The last unit absorbs everything larger. */
  units: readonly string[];
  /** Renders the scaled value; `unit` is an index into `units`. */
  format: (value: number, unit: number) => string;
}

/** `1.5 KB`, `953.7 MB` — one decimal, stops at MB. The default. */
export const BYTES_UP_TO_MB: ByteFormat = {
  units: ["KB", "MB"],
  format: (value) => value.toFixed(1),
};

/** `953.7 MB`, `1.50 GB` — one decimal, two once it reaches GB. */
export const BYTES_UP_TO_GB: ByteFormat = {
  units: ["KB", "MB", "GB"],
  format: (value, unit) => value.toFixed(unit === 2 ? 2 : 1),
};

export function formatBytes(bytes: number, { units, format }: ByteFormat = BYTES_UP_TO_MB): string {
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${format(value, unit)} ${units[unit]}`;
}
