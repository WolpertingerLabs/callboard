/**
 * Pure helpers for the Google services editor (GoogleSelectionEditor and
 * ConfigureConnectionModal): no React, so src/remote/google-dashboard-helpers.test.ts
 * can test them from the root suite. Everything is derived from the catalog
 * payload (GET /api/admin/google/catalog).
 */
import type {
  AdminGoogleAuthMode,
  AdminGoogleCatalog,
  AdminGoogleSelectionConfig,
} from "drawlatch-admin-types";
import { isValidOAuth2Subject } from "./oauth2Subject";

export interface GoogleDraft {
  auth: AdminGoogleAuthMode;
  /** service id → level id; a missing service is Off. */
  services: Record<string, string>;
  /** Kept while switching modes; only sent in service-account mode. */
  subject: string;
}

export type Level = AdminGoogleCatalog["services"][number]["levels"][number];


export function draftFrom(sel: AdminGoogleSelectionConfig | null): GoogleDraft {
  return {
    auth: sel?.auth ?? "user",
    services: { ...(sel?.services ?? {}) },
    subject: sel?.subject ?? "",
  };
}

/** The PUT body: services in catalog order, subject only in SA mode. */
export function selectionFrom(
  catalog: AdminGoogleCatalog,
  d: GoogleDraft,
): AdminGoogleSelectionConfig {
  const services: Record<string, string> = {};
  for (const svc of catalog.services) {
    if (Object.hasOwn(d.services, svc.id)) services[svc.id] = d.services[svc.id];
  }
  const subject = d.subject.trim();
  return {
    auth: d.auth,
    services,
    ...(d.auth === "service-account" && subject !== "" && { subject }),
  };
}

export function sameSelection(
  a: AdminGoogleSelectionConfig | null,
  b: AdminGoogleSelectionConfig | null,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Each selected level, in catalog order. */
export function pickedLevels(
  catalog: AdminGoogleCatalog,
  sel: AdminGoogleSelectionConfig,
): { service: string; name: string; level: Level }[] {
  const out: { service: string; name: string; level: Level }[] = [];
  for (const svc of catalog.services) {
    const levelId = Object.hasOwn(sel.services, svc.id) ? sel.services[svc.id] : undefined;
    const level = svc.levels.find((l) => l.id === levelId);
    if (level) out.push({ service: svc.id, name: svc.name, level });
  }
  return out;
}

/** The sorted union of the selected levels' scopes (googleConsentScopes). */
export function consentScopesOf(
  catalog: AdminGoogleCatalog,
  sel: AdminGoogleSelectionConfig,
): string[] {
  return [
    ...new Set(pickedLevels(catalog, sel).flatMap((p) => p.level.scopes)),
  ].sort();
}

/** What would stop the daemon accepting the draft, or null. */
export function draftProblem(
  catalog: AdminGoogleCatalog,
  d: GoogleDraft,
): string | null {
  const sel = selectionFrom(catalog, d);
  if (Object.keys(sel.services).length === 0) {
    return "Choose a level for at least one service.";
  }
  if (d.auth === "service-account") {
    const subject = d.subject.trim();
    // The daemon's rule exactly (isValidOAuth2Subject), never stricter.
    if (subject !== "" && !isValidOAuth2Subject(subject)) {
      return "The subject must be an email address.";
    }
    const needs = pickedLevels(catalog, sel).filter((p) => p.level.subjectRequired);
    if (subject === "" && needs.length > 0) {
      return `${needs.map((p) => p.name).join(", ")} needs a subject with a service account: it has no mailbox, so it must act as a Workspace user.`;
    }
  }
  return null;
}

/**
 * Why saving `next` over `saved` could let the agent reach more, one line
 * each, or [] when it can't. Any of these counts: a level that brings a scope
 * the saved selection lacks (every level, for a first selection), a change of
 * auth mode (user OAuth reaches the whole consenting account; a service
 * account reaches what is shared with it, or a delegated user's data), and a
 * subject that is set or changed.
 */
export function wideningReasons(
  catalog: AdminGoogleCatalog,
  saved: AdminGoogleSelectionConfig | null,
  next: AdminGoogleSelectionConfig,
): string[] {
  const lines: string[] = [];
  if (saved && saved.auth !== next.auth) {
    lines.push(
      next.auth === "user"
        ? "Auth mode: service account → user OAuth. The agent reaches everything the consenting Google account can, not only what is shared with the service account or its delegated user."
        : "Auth mode: user OAuth → service account. The agent acts as the service account" +
            (next.subject ? `, and as ${next.subject} through delegation,` : "") +
            " instead of the consenting account.",
    );
  }
  const before = saved ? consentScopesOf(catalog, saved) : [];
  const added = consentScopesOf(catalog, next).filter((s) => !before.includes(s));
  for (const p of pickedLevels(catalog, next)) {
    if (p.level.scopes.some((s) => added.includes(s))) {
      lines.push(`${p.service} · ${p.level.id}: ${p.level.summary}`);
    }
  }
  if (next.subject !== undefined && next.subject !== saved?.subject) {
    lines.push(`Acts as ${next.subject} for every selected service.`);
  }
  return lines;
}

/** The scopes `next` adds to `saved`: what must be (re-)consented. */
export function addedScopes(
  catalog: AdminGoogleCatalog,
  saved: AdminGoogleSelectionConfig | null,
  next: AdminGoogleSelectionConfig,
): string[] {
  const before = saved ? consentScopesOf(catalog, saved) : [];
  return consentScopesOf(catalog, next).filter((s) => !before.includes(s));
}

/** The catalog notes whose `when` the selection contains. */
export function notesFor(
  catalog: AdminGoogleCatalog,
  sel: AdminGoogleSelectionConfig,
): string[] {
  return catalog.crossScopeNotes
    .filter((n) =>
      Object.entries(n.when).every(
        ([svc, level]) => Object.hasOwn(sel.services, svc) && sel.services[svc] === level,
      ),
    )
    .map((n) => n.text);
}
