import { z } from "zod";
export const coordinate = z.number().int().min(0).max(16383);
export const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("click"), x: coordinate, y: coordinate, button: z.enum(["left", "middle", "right"]).optional() }).strict(),
  z.object({ type: z.literal("move"), x: coordinate, y: coordinate }).strict(),
  z
    .object({
      type: z.literal("drag"),
      x: coordinate,
      y: coordinate,
      toX: coordinate,
      toY: coordinate,
      durationMs: z.number().int().min(1).max(2000).optional(),
    })
    .strict(),
  z.object({ type: z.literal("scroll"), deltaX: z.number().int().min(-2000).max(2000), deltaY: z.number().int().min(-2000).max(2000) }).strict(),
  z.object({ type: z.literal("type"), text: z.string().max(4096) }).strict(),
  z
    .object({
      type: z.literal("key"),
      key: z
        .string()
        .regex(
          /^(?:(?:Control|Alt|Shift|Meta)\+){0,4}(?:[a-zA-Z0-9]|Enter|Tab|Escape|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Space|F(?:[1-9]|1[0-2]))$/,
        ),
    })
    .strict(),
  z
    .object({
      type: z.literal("navigate"),
      url: z
        .string()
        .url()
        .max(4096)
        // The try is not decoration. Zod runs every check on a string even
        // after an earlier one fails, so a value `.url()` has already rejected
        // still reaches this refinement — and `new URL()` throws on it, which
        // escapes `parse`/`safeParse` as a raw TypeError instead of arriving as
        // a validation error the service maps to `invalid_request`.
        .refine((s) => {
          try {
            return ["http:", "https:"].includes(new URL(s).protocol);
          } catch {
            return false;
          }
        }),
    })
    .strict(),
  z.object({ type: z.literal("wait"), durationMs: z.number().int().min(0).max(2000) }).strict(),
]);
export const refShape = { sessionId: z.string().uuid(), generation: z.number().int().positive() };
export const leaseShape = { ...refShape, leaseId: z.string().uuid() };

export const frameShape = { frameId: z.string().uuid() };
