/**
 * Turn the result of a tool-backed admin mutation into success or failure.
 *
 * The admin routes that run a tool (`runTool` in src/remote/admin-mutations.ts)
 * send the tool's own failures as HTTP 200, so `mutate()` reports them as
 * `ok: true`. The body says what happened:
 * - one result: `{ success: false, error }` (control_listener,
 *   set_listener_params, delete_listener_instance, resolve_listener_options);
 * - several: an array of `{ success, instanceId?, error? }`, one per instance
 *   (control_listener on a multi-instance listener without `instance_id`).
 *
 * `toolResult` folds those into the same `{ ok: false, error }` as a transport
 * failure, so a failed tool is never shown as a success. A partly failed list
 * says how many failed and why: "1 of 3 instances failed: b (socket hung up)".
 */
import type { MutationResult } from "../api";

export type ToolOutcome<T> = { ok: true; data: T } | { ok: false; error: string };

interface ToolItem {
  success?: unknown;
  error?: unknown;
  instanceId?: unknown;
  instance_id?: unknown;
}

function isItem(v: unknown): v is ToolItem {
  return typeof v === "object" && v !== null;
}

function errorText(item: ToolItem): string {
  return typeof item.error === "string" && item.error !== "" ? item.error : "failed";
}

function itemName(item: ToolItem): string | undefined {
  const id = item.instanceId ?? item.instance_id;
  return typeof id === "string" && id !== "" ? id : undefined;
}

/** How many to name before "and N more". */
const LISTED = 3;

export function toolResult<T>(res: MutationResult<T>): ToolOutcome<T> {
  if (!res.ok) return { ok: false, error: res.error };
  const data: unknown = res.data;

  if (Array.isArray(data)) {
    const failed = data.filter((d): d is ToolItem => isItem(d) && d.success === false);
    if (failed.length === 0) return { ok: true, data: res.data };
    const named = failed.slice(0, LISTED).map((f) => {
      const name = itemName(f);
      return name ? `${name} (${errorText(f)})` : errorText(f);
    });
    const more = failed.length > LISTED ? `, and ${failed.length - LISTED} more` : "";
    const head =
      failed.length === data.length
        ? data.length === 1
          ? "Failed"
          : `All ${data.length} instances failed`
        : `${failed.length} of ${data.length} instances failed`;
    return { ok: false, error: `${head}: ${named.join("; ")}${more}` };
  }

  if (isItem(data) && data.success === false) {
    return {
      ok: false,
      error: errorText(data) === "failed" ? "The request failed." : errorText(data),
    };
  }
  return { ok: true, data: res.data };
}
