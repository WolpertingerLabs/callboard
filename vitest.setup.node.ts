/**
 * Node-project test setup: no test may write to the developer's real
 * `~/.callboard`.
 *
 * `CALLBOARD_DATA_DIR` is the single switch that moves every callboard-owned
 * path — chats, workspaces, cards, ACP transcripts. Tests that know they write
 * set it themselves; the failure mode is a test that writes *incidentally*.
 * `toolAdapter.test.ts` was one: it drives a real `AcpAdapter.query()` to prove
 * `anyOf` schemas survive registration, and the adapter — correctly — records a
 * transcript for the session it opened. With no override in that file, the
 * transcript landed in the real data dir and the fake agent's session showed up
 * in the developer's sidebar as a chat.
 *
 * The convention (each writing test declares its own scratch dir) stays; this is
 * the floor under it, so the next incidental writer leaks into a temp dir
 * instead of the user's home. It only fills in a default, so any test that
 * assigns `CALLBOARD_DATA_DIR` at module scope still wins.
 *
 * One dir per worker process, not per test file: files that opt out of their own
 * sandbox already shared a data dir before this existed (the real one), so
 * sharing a scratch dir is strictly an improvement and keeps the temp tree from
 * growing an entry per test file.
 */
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.CALLBOARD_DATA_DIR?.trim()) {
  const scratch = join(tmpdir(), `callboard-vitest-data-${process.pid}`);
  mkdirSync(scratch, { recursive: true });
  process.env.CALLBOARD_DATA_DIR = scratch;
}
