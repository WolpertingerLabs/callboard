/**
 * Whether two activity payloads say the same thing.
 *
 * `GET /chats/:id/activity` is polled on a timer while a run is live — a
 * background-task hold opens and closes at turn boundaries, which emit no
 * stream frame, so there is no push signal to hang the dock's refresh on (see
 * the poll in `Chat.tsx`). Every response is a freshly-parsed object, so
 * storing it unconditionally makes every tick a new reference and re-renders
 * the whole chat page once a interval whether or not anything moved.
 *
 * Comparing by serialisation rather than field by field is deliberate. The
 * payload is small (a chat blocks on one thing at a time), it arrives as JSON
 * from a single server code path so key order is stable in practice, and the
 * failure mode of a mismatch is a redundant re-render — exactly what the
 * unconditional store did on every tick. A false negative therefore costs what
 * today costs, while a hand-written comparison that forgot a field would cost a
 * dock that stops updating, which is the failure worth designing against.
 */
import type { ChatActivityResponse } from "../api";

export function sameActivityPayload(a: ChatActivityResponse, b: ChatActivityResponse): boolean {
  if (a === b) return true;
  if (a.awaitingChildren !== b.awaitingChildren) return false;
  if (a.activities.length !== b.activities.length) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
