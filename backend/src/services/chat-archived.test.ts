/**
 * `isChatArchived` reads the archive where the archive is actually written —
 * the lineage root's card or `treeArchived` flag, a child's `childArchived` —
 * and computer control refuses an archived chat through it. There is no
 * `metadata.archived` flag; checking that one (as computer control used to)
 * never fired.
 */
import { afterAll, afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const dataDir = mkdtempSync(join(tmpdir(), "callboard-chat-archived-data-"));
process.env.CALLBOARD_DATA_DIR = dataDir;
const workDir = mkdtempSync(join(tmpdir(), "callboard-chat-archived-work-"));

const { chatFileService } = await import("./chat-file-service.js");
const { isChatArchived } = await import("./chat-archived.js");
const { loadComputerUsePolicy, setChatArchivedCheck } = await import("./computer-use.js");

let n = 0;
const make = (meta: Record<string, unknown>) => chatFileService.createChat(workDir, `archived-test-${++n}`, JSON.stringify(meta));

afterEach(() => setChatArchivedCheck(() => false));
afterAll(() => {
  for (const dir of [dataDir, workDir]) rmSync(dir, { recursive: true, force: true });
});

it("a closed (or hidden) card archives the whole tree", () => {
  const root = make({ card: { lifecycle: "closed" } });
  const child = make({ parentChatId: root.id });
  const grandchild = make({ parentChatId: child.id });
  expect(isChatArchived(root.id)).toBe(true);
  expect(isChatArchived(grandchild.id)).toBe(true);
  expect(isChatArchived(make({ card: { lifecycle: "open", hidden: true } }).id)).toBe(true);
  expect(isChatArchived(make({ card: { lifecycle: "open" } }).id)).toBe(false);
});

it("a card-less root is archived by its treeArchived flag", () => {
  const root = make({ triggered: true, treeArchived: true });
  expect(isChatArchived(make({ parentChatId: root.id }).id)).toBe(true);
  expect(isChatArchived(make({ triggered: true }).id)).toBe(false);
});

it("a child archived on its own archives it and everything under it, not its parent", () => {
  const root = make({});
  const child = make({ parentChatId: root.id, childArchived: true });
  const under = make({ parentChatId: child.id });
  expect(isChatArchived(child.id)).toBe(true);
  expect(isChatArchived(under.id)).toBe(true);
  expect(isChatArchived(root.id)).toBe(false);
});

it("a native Codex root is never a card: judged by treeArchived, as the sidebar does", () => {
  const native = (meta: Record<string, unknown>) => make({ provider: "codex", nativeAgent: { parentThreadId: "t" }, ...meta });
  // A stray card object on a native root does not archive it…
  expect(isChatArchived(native({ card: { lifecycle: "closed" } }).id)).toBe(false);
  // …its own flag does.
  expect(isChatArchived(native({ treeArchived: true }).id)).toBe(true);
});

it("the legacy `archived` spelling is not the archive, and a missing chat is not archived", () => {
  expect(isChatArchived(make({}).id)).toBe(false);
  expect(isChatArchived("no-such-chat")).toBe(false);
});

it("computer control refuses an archived chat once the check is installed", () => {
  const chat = make({ card: { lifecycle: "closed" }, defaultPermissions: { computerControl: "ask", webAccess: "allow" } });
  setChatArchivedCheck(isChatArchived);
  expect(() => loadComputerUsePolicy(chat.id)).toThrow(expect.objectContaining({ code: "denied", message: "Chat is archived" }));
});
