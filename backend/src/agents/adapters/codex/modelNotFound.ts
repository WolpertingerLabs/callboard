/**
 * Recognise OpenAI's "this model is not in your catalog" rejection and turn it
 * into a message a person can act on.
 *
 * OpenAI serves Codex a **per-client-version** model catalog. A model newer than
 * the `codex` CLI asking for it, or one the account's plan doesn't include, is
 * refused with a 400 before the turn does anything:
 *
 * ```json
 * {"type":"error","status":400,"error":{"type":"invalid_request_error",
 *  "message":"The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.",
 *  "code":"model_not_found","subreason":"model_not_in_accessible_catalog"}}
 * ```
 *
 * The CLI forwards that body verbatim as the `message` of its `error` and
 * `turn.failed` events. Before this module, the JSON reached the chat as-is. A
 * chat with no model set is the worst case: Codex then falls back to the
 * `model` in `$CODEX_HOME/config.toml` (default `~/.codex`), so one stale default kills every
 * model-less Codex session (cron jobs included) and the error never names where
 * the model came from.
 *
 * Pure: no I/O. The adapter supplies the context it knows (the chat's model, the
 * client version, whether a binary override is in use).
 */

/** What we could read out of a model-not-found rejection. */
export interface CodexModelNotFound {
  /** The model OpenAI refused, when its message names one. */
  model?: string;
  /** OpenAI's own human-readable message (the inner `error.message`), or the raw text when it had none. */
  openaiMessage: string;
  /** `error.code`, when present. */
  code?: string;
  /** `error.subreason`, when present. */
  subreason?: string;
}

/** Context the adapter knows about the run that failed. */
export interface CodexModelNotFoundContext {
  /** The model callboard asked for. `undefined` ⇒ none set, so Codex used config.toml's `model`. */
  requestedModel?: string;
  /** Version of the `codex` CLI that ran, when cheaply known (the bundled package). */
  codexVersion?: string;
  /** The `codexPathOverride` in effect, if any — the bundled version doesn't apply then. */
  binaryOverride?: string;
}

const MODEL_NOT_FOUND_CODE = "model_not_found";
const NOT_IN_CATALOG_SUBREASON = "model_not_in_accessible_catalog";

/** Marker the formatted message starts with — lets later layers recognise an already-formatted message. */
export const CODEX_MODEL_NOT_FOUND_HEADLINE = "Codex model not available";

/**
 * Detect a model-not-found rejection in an error string. Tolerates the JSON
 * being the whole string, embedded in surrounding text (the "Codex Exec exited
 * with code 1: …" stderr), or stringified inside another JSON value.
 * Returns `null` for anything else.
 */
export function detectCodexModelNotFound(text: string | undefined | null): CodexModelNotFound | null {
  if (!text || typeof text !== "string") return null;
  if (!text.includes(MODEL_NOT_FOUND_CODE) && !text.includes(NOT_IN_CATALOG_SUBREASON)) return null;
  // Already turned into our message once — don't wrap it a second time.
  if (text.startsWith(CODEX_MODEL_NOT_FOUND_HEADLINE)) return null;

  const errorObject = findErrorObject(text, 0);
  const openaiMessage = (typeof errorObject?.message === "string" && errorObject.message) || text.trim();
  const model = extractModel(openaiMessage) ?? extractModel(text);
  return {
    ...(model && { model }),
    openaiMessage,
    ...(typeof errorObject?.code === "string" && { code: errorObject.code }),
    ...(typeof errorObject?.subreason === "string" && { subreason: errorObject.subreason }),
  };
}

/** Where Codex's `model` default lives. `$CODEX_HOME` is what the CLI reads; profile/project layers can also set it. */
const CODEX_CONFIG = "$CODEX_HOME/config.toml";

/**
 * The actionable, multi-line message shown in the chat and recorded on job runs.
 *
 * Two shapes, keyed on the subreason:
 * - `model_not_in_accessible_catalog`: the model is real, but not in the
 *   per-client-version catalog this Codex client is served (ChatGPT plan /
 *   too-old CLI). Remedies: pick a listed model, update Callboard, or point at
 *   a newer `codex` binary.
 * - bare `model_not_found`: what API-key auth returns for a mistyped or
 *   inaccessible model. Remedies: check the name and the account's access; a
 *   newer client would not help, so it isn't suggested.
 */
export function formatCodexModelNotFound(found: CodexModelNotFound, ctx: CodexModelNotFoundContext): string {
  const catalog = found.subreason === NOT_IN_CATALOG_SUBREASON;
  const problem = catalog ? `is not in the model catalog this Codex client (${describeClient(ctx)}) can access` : "was not found, or this account can't use it";
  const lines: string[] = [];
  if (ctx.requestedModel) {
    lines.push(`${CODEX_MODEL_NOT_FOUND_HEADLINE}: \`${ctx.requestedModel}\` ${problem}.`);
  } else {
    const which = found.model ? ` (\`${found.model}\`)` : "";
    lines.push(
      `${CODEX_MODEL_NOT_FOUND_HEADLINE}: no model set — Codex used the \`model\` from its config (${CODEX_CONFIG}, default ~/.codex)${which}, ` +
        `and it ${problem}.`,
    );
  }
  lines.push("");
  lines.push("To fix it, any one of:");
  if (!catalog) lines.push("• Check the model name for typos, and that this account or API key has access to this model.");
  lines.push("• Pick a model from the Codex model list (the model picker, or the list_codex_models tool) and set it on this chat or job.");
  if (!ctx.requestedModel) lines.push(`• Or change \`model\` in ${CODEX_CONFIG} (or the profile/project config that sets it) to one in that list.`);
  if (catalog) {
    lines.push("• Update Callboard — its bundled Codex CLI may be too old to know this model.");
    lines.push("• Or point Settings → API → Codex Binary at a newer `codex` install.");
  }
  lines.push("");
  const tags = [found.code, found.subreason].filter(Boolean).join(" / ");
  lines.push(`OpenAI said: ${found.openaiMessage}${tags ? ` (${tags})` : ""}`);
  return lines.join("\n");
}

/** Detect + format in one step; returns `null` when `text` isn't a model-not-found rejection. */
export function codexModelNotFoundMessage(text: string | undefined | null, ctx: CodexModelNotFoundContext): string | null {
  const found = detectCodexModelNotFound(text);
  return found ? formatCodexModelNotFound(found, ctx) : null;
}

function describeClient(ctx: CodexModelNotFoundContext): string {
  if (ctx.binaryOverride) return `override binary ${ctx.binaryOverride}`;
  if (ctx.codexVersion) return `codex-cli ${ctx.codexVersion}, bundled with Callboard`;
  return "the Codex CLI bundled with Callboard";
}

type ErrorObject = { message?: unknown; code?: unknown; subreason?: unknown };

/**
 * Walk a value (string → JSON, object → its fields) looking for the object that
 * carries the model-not-found code/subreason. Depth-capped: the payload nests
 * two or three levels at most, and a pathological string shouldn't recurse.
 */
function findErrorObject(value: unknown, depth: number): ErrorObject | null {
  if (depth > 6) return null;
  if (typeof value === "string") {
    for (const candidate of jsonCandidates(value)) {
      const hit = findErrorObject(candidate, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (obj.code === MODEL_NOT_FOUND_CODE || obj.subreason === NOT_IN_CATALOG_SUBREASON) {
    // The inner message may itself be stringified JSON — prefer its own error.
    if (typeof obj.message === "string") {
      const inner = findErrorObject(obj.message, depth + 1);
      if (inner) return inner;
    }
    return obj as ErrorObject;
  }
  for (const child of Object.values(obj)) {
    const hit = findErrorObject(child, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** JSON values parseable out of `text`: the whole string, else its outermost `{…}` span. */
function jsonCandidates(text: string): unknown[] {
  const out: unknown[] = [];
  const tryParse = (s: string) => {
    try {
      out.push(JSON.parse(s));
      return true;
    } catch {
      return false;
    }
  };
  const trimmed = text.trim();
  if (tryParse(trimmed)) return out;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) tryParse(trimmed.slice(start, end + 1));
  return out;
}

function extractModel(message: string): string | undefined {
  const quoted = /\bThe ['"`]([^'"`\s]+)['"`] model\b/i.exec(message) ?? /\bmodel ['"`]([^'"`\s]+)['"`]/i.exec(message);
  return quoted?.[1];
}
