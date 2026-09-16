import { z } from "zod";
import type { ChatViewSnapshot } from "shared/types/chat-filters.js";
import { getSession } from "./sessions.js";
const viewIdSchema = z
  .string()
  .min(8)
  .max(80)
  .regex(/^[A-Za-z0-9_-]+$/);
const field = z.object({ active: z.boolean(), value: z.string().max(1000) }).strict();
export const chatViewSchema = z
  .object({
    viewId: viewIdSchema,
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    filters: z.object({ directoryInclude: field, directoryExclude: field, dateMin: field, dateMax: field }).strict(),
    options: z.object({ bookmarked: z.boolean(), showTriggered: z.boolean(), showArchived: z.boolean() }).strict(),
    submittedSearch: z.string().max(2000),
  })
  .strict()
  .superRefine((view, ctx) => {
    for (const key of ["dateMin", "dateMax"] as const) {
      const f = view.filters[key];
      if (f.active && f.value && (!/(Z|[+-]\d\d:\d\d)$/.test(f.value) || !Number.isFinite(Date.parse(f.value))))
        ctx.addIssue({ code: "custom", path: ["filters", key], message: "Active dates must be valid timezone-qualified instants" });
    }
  });
export type ChatViewBinding = { owner: string; viewId: string };
export const VIEW_TTL = 90_000;
export class ChatViewError extends Error {}
export class ChatViewRegistry {
  private entries = new Map<string, { snapshot: ChatViewSnapshot; updatedAt: string; seenAt: number }>();
  private expiredRevisions = new Map<string, number>();
  constructor(
    private validOwner: (owner: string) => boolean,
    private now = Date.now,
  ) {}
  private key(binding: ChatViewBinding) {
    return JSON.stringify([binding.owner, binding.viewId]);
  }
  cleanup() {
    for (const [key, entry] of this.entries) {
      const [owner] = JSON.parse(key) as [string, string];
      if (!this.validOwner(owner)) this.entries.delete(key);
      else if (this.now() - entry.seenAt > VIEW_TTL) {
        this.expiredRevisions.set(key, entry.snapshot.revision);
        this.entries.delete(key);
      }
    }
    for (const key of this.expiredRevisions.keys()) {
      const [owner] = JSON.parse(key) as [string, string];
      if (!this.validOwner(owner)) this.expiredRevisions.delete(key);
    }
  }
  deactivate(owner: string | undefined, input: unknown) {
    if (!owner || !this.validOwner(owner)) throw new ChatViewError("Browser session required for chat view");
    const ref = z
      .object({ viewId: viewIdSchema, revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })
      .strict()
      .parse(input);
    const key = this.key({ owner, viewId: ref.viewId });
    const current = this.entries.get(key)?.snapshot.revision ?? this.expiredRevisions.get(key);
    // An unmount racing a newer remount cannot close the new view.
    if (current === undefined || ref.revision < current) return;
    this.entries.delete(key);
    this.expiredRevisions.set(key, ref.revision);
  }
  publish(owner: string | undefined, input: unknown): ChatViewBinding {
    if (!owner || !this.validOwner(owner)) throw new ChatViewError("Browser session required for chat view");
    const parsed = chatViewSchema.safeParse(input);
    if (!parsed.success) throw new ChatViewError(parsed.error.message);
    const snapshot = parsed.data;
    const binding = { owner, viewId: snapshot.viewId };
    const key = this.key(binding);
    this.cleanup();
    if (snapshot.revision <= (this.expiredRevisions.get(key) ?? -1)) return binding;
    const prior = this.entries.get(key);
    if (prior && snapshot.revision < prior.snapshot.revision) return binding;
    if (prior && snapshot.revision === prior.snapshot.revision && JSON.stringify(snapshot) !== JSON.stringify(prior.snapshot))
      throw new ChatViewError("Conflicting chat view revision");
    if (!this.entries.has(key) && !this.expiredRevisions.has(key) && this.entries.size + this.expiredRevisions.size >= 4096)
      throw new ChatViewError("Chat view registry capacity reached");
    this.expiredRevisions.delete(key);
    this.entries.set(key, {
      snapshot,
      seenAt: this.now(),
      updatedAt:
        prior &&
        JSON.stringify([prior.snapshot.filters, prior.snapshot.options, prior.snapshot.submittedSearch]) ===
          JSON.stringify([snapshot.filters, snapshot.options, snapshot.submittedSearch])
          ? prior.updatedAt
          : new Date(this.now()).toISOString(),
    });
    return binding;
  }
  read(binding?: ChatViewBinding) {
    if (!binding) return { available: false as const, reason: "No originating browser tab" };
    this.cleanup();
    const key = this.key(binding);
    const entry = this.entries.get(key);
    if (!this.validOwner(binding.owner) || !entry || this.now() - entry.seenAt > VIEW_TTL) {
      this.entries.delete(key);
      return { available: false as const, reason: "Originating browser view expired or session ended" };
    }
    return {
      available: true as const,
      source: "originating_browser_tab",
      ...structuredClone(entry.snapshot),
      updatedAt: entry.updatedAt,
      lastSeenAt: new Date(entry.seenAt).toISOString(),
      expiresAt: new Date(entry.seenAt + VIEW_TTL).toISOString(),
    };
  }
}
export const chatViews = new ChatViewRegistry((owner) => {
  const session = getSession(owner);
  return !!session && session.expires_at > Date.now();
});
export function bindChatView(owner: string | undefined, input: unknown) {
  return input === undefined ? undefined : chatViews.publish(owner, input);
}

const cleanupTimer = setInterval(() => chatViews.cleanup(), 30_000);
cleanupTimer.unref();
