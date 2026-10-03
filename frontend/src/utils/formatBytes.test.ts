/**
 * Parity with the four copies this module replaced. Every expected string
 * below was produced by running the pre-refactor function verbatim, so a
 * difference here is a visible change in what a call site prints.
 */
import { describe, expect, it } from "vitest";
import { BYTES_ROUNDED_TO_TB, BYTES_UP_TO_GB, formatBytes } from "./formatBytes";
import { formatDiskUsage } from "./workspaceFormat";
import { formatBytes as storageFormatBytes } from "../pages/settings/StorageSettings";

type Table = Array<[number, string]>;

// GitDiffView.formatBytes and MediaRenderer.formatFileSize (identical bodies).
const UP_TO_MB: Table = [
  [0, "0 B"],
  [1, "1 B"],
  [1023, "1023 B"],
  [1024, "1.0 KB"],
  [1536, "1.5 KB"],
  [10240, "10.0 KB"],
  [1047552, "1023.0 KB"],
  [1048575, "1024.0 KB"],
  [1e6, "976.6 KB"],
  [2 ** 20, "1.0 MB"],
  [1e9, "953.7 MB"],
  [2 ** 30, "1024.0 MB"],
  [1.5 * 2 ** 30, "1536.0 MB"],
  [2 ** 30 * 1023.999, "1048575.0 MB"],
  [2 ** 40, "1048576.0 MB"],
  [1e13, "9536743.2 MB"],
  [2 ** 50, "1073741824.0 MB"],
];

// StorageSettings.formatBytes.
const UP_TO_GB: Table = [
  [0, "0 B"],
  [1, "1 B"],
  [1023, "1023 B"],
  [1024, "1.0 KB"],
  [1536, "1.5 KB"],
  [10240, "10.0 KB"],
  [1047552, "1023.0 KB"],
  [1048575, "1024.0 KB"],
  [1e6, "976.6 KB"],
  [2 ** 20, "1.0 MB"],
  [1e9, "953.7 MB"],
  [2 ** 30, "1.00 GB"],
  [1.5 * 2 ** 30, "1.50 GB"],
  [2 ** 30 * 1023.999, "1024.00 GB"],
  [2 ** 40, "1024.00 GB"],
  [1e13, "9313.23 GB"],
  [2 ** 50, "1048576.00 GB"],
];

// workspaceFormat.formatBytes (behind formatDiskUsage).
const ROUNDED_TO_TB: Table = [
  [0, "0 B"],
  [1, "1 B"],
  [1023, "1023 B"],
  [1024, "1.0 KB"],
  [1536, "1.5 KB"],
  [10240, "10 KB"],
  [1047552, "1023 KB"],
  [1048575, "1024 KB"],
  [1e6, "977 KB"],
  [2 ** 20, "1.0 MB"],
  [1e9, "954 MB"],
  [2 ** 30, "1.0 GB"],
  [1.5 * 2 ** 30, "1.5 GB"],
  [2 ** 30 * 1023.999, "1024 GB"],
  [2 ** 40, "1.0 TB"],
  [1e13, "9.1 TB"],
  [2 ** 50, "1024 TB"],
];

describe("formatBytes parity with the copies it replaced", () => {
  it.each(UP_TO_MB)("default (GitDiffView, MediaRenderer): %d → %s", (n, expected) => {
    expect(formatBytes(n)).toBe(expected);
  });

  it.each(UP_TO_GB)("BYTES_UP_TO_GB (StorageSettings): %d → %s", (n, expected) => {
    expect(formatBytes(n, BYTES_UP_TO_GB)).toBe(expected);
    expect(storageFormatBytes(n)).toBe(expected);
  });

  it.each(ROUNDED_TO_TB)("BYTES_ROUNDED_TO_TB (workspace disk usage): %d → %s", (n, expected) => {
    expect(formatBytes(n, BYTES_ROUNDED_TO_TB)).toBe(expected);
    expect(formatDiskUsage({ bytes: n } as Parameters<typeof formatDiskUsage>[0])).toBe(expected);
  });
});
