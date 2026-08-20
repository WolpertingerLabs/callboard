import type { ModelAlias } from "shared/types/index.js";

/**
 * Row model for the Settings → Model Aliases editor, and the two conversions
 * between it and the stored `ModelAlias[]`.
 *
 * **There is no OpenRouter column, but `targets.openrouter` still round-trips.**
 * The harness was removed, so nothing resolves that target any more (no call
 * site passes `"openrouter"` to `resolveModelAlias`) and offering a picker for
 * it invited users to configure a model that could never run. The stored value
 * is still user data, though — carried on `AliasRow` and written back by
 * `toAliases()` untouched, because the editor rebuilds `targets` from row state
 * on every save, so a field the row forgets is a field the next save deletes.
 *
 * That deletion would be unrecoverable, which is what makes this worth the
 * carried field rather than a comment: saving from that page also retires the
 * legacy `openRouterModelAliases` map the values were migrated from
 * (`routes/agent-settings.ts`, the `modelAliases !== undefined` branch). Forget
 * the field and the first save of an unrelated column destroys the target and
 * its only backup in one write. See `HarnessProvider` in
 * shared/types/modelAlias.ts for why the key itself survives — dropping it from
 * `HARNESS_PROVIDERS` would make `validateModelAliases` reject the whole alias
 * and 400 the save, bricking the tab for anyone holding a legacy target.
 */
export interface AliasRow {
  name: string;
  description: string;
  claudeCode: string;
  openrouter: string;
  codex: string;
  acp: string;
  cline: string;
  pi: string;
}

export const emptyRow = (): AliasRow => ({ name: "", description: "", claudeCode: "", openrouter: "", codex: "", acp: "", cline: "", pi: "" });

export function toRows(aliases: ModelAlias[] | undefined): AliasRow[] {
  return (aliases ?? []).map((a) => ({
    name: a.name,
    description: a.description ?? "",
    claudeCode: a.targets["claude-code"] ?? "",
    openrouter: a.targets.openrouter ?? "",
    codex: a.targets.codex ?? "",
    acp: a.targets.acp ?? "",
    cline: a.targets.cline ?? "",
    pi: a.targets.pi ?? "",
  }));
}

/** Build the ModelAlias[] a row set represents (blank fields dropped). */
export function toAliases(rows: AliasRow[]): ModelAlias[] {
  return rows
    .map((r) => {
      const targets: ModelAlias["targets"] = {};
      if (r.claudeCode.trim()) targets["claude-code"] = r.claudeCode.trim();
      // Has no column — carried straight through from toRows(). Dropping this
      // line deletes the slug on the next save of any unrelated column; only the
      // note's "Clear it" button, an explicit user action, blanks it.
      if (r.openrouter.trim()) targets.openrouter = r.openrouter.trim();
      if (r.codex.trim()) targets.codex = r.codex.trim();
      if (r.acp.trim()) targets.acp = r.acp.trim();
      if (r.cline.trim()) targets.cline = r.cline.trim();
      if (r.pi.trim()) targets.pi = r.pi.trim();
      const alias: ModelAlias = { name: r.name.trim(), targets };
      if (r.description.trim()) alias.description = r.description.trim();
      return alias;
    })
    .filter((a) => a.name !== "" && Object.keys(a.targets).length > 0);
}

/** True when any column the page still renders has a target. */
export function hasEditableTarget(r: AliasRow): boolean {
  return Boolean(r.claudeCode.trim() || r.codex.trim() || r.acp.trim() || r.cline.trim() || r.pi.trim());
}

/** True when the retained OpenRouter slug is the row's *only* target. */
export function onlyOpenRouterTarget(r: AliasRow): boolean {
  return Boolean(r.openrouter.trim()) && !hasEditableTarget(r);
}
