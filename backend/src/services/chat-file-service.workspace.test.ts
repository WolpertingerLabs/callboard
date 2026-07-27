/**
 * Workspace linkage on chat records (plans/workspace-object.md).
 *
 * `workspaceId` is a top-level Chat field, not part of the metadata blob, so
 * it has its own propagation rules: createChat takes it explicitly (the fork
 * route inherits the parent's), and upsertChat writes it only when it is
 * creating the record. The write-once rule is what the SendMessageOptions doc
 * promises — an existing chat keeps whatever linkage its record already has,
 * because re-pointing a live chat at another workspace would move it out of
 * the set Phase 2's archive cascade interrupts while its session keeps running
 * in the old directory.
 *
 * DATA_DIR is read when utils/paths.js first loads, so the env var is set
 * before the service is imported.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-chat-workspace-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const { chatFileService } = await import("./chat-file-service.js");

const chatsDir = join(tmpRoot, "chats");

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  for (const file of readdirSync(chatsDir)) rmSync(join(chatsDir, file), { force: true, recursive: true });
});

describe("createChat workspace linkage", () => {
  it("stamps the workspace it is given", () => {
    const chat = chatFileService.createChat("/repo.feat-x", randomUUID(), "{}", "ws-abc123");
    expect(chat.workspaceId).toBe("ws-abc123");
    expect(chatFileService.getChat(chat.id)?.workspaceId).toBe("ws-abc123");
  });

  it("omits the key entirely when there is no workspace", () => {
    const sessionId = randomUUID();
    const chat = chatFileService.createChat("/repo", sessionId, "{}");
    expect(chat).not.toHaveProperty("workspaceId");
    // Most chats have no workspace — the field must not appear as an explicit
    // null/undefined that later reads have to normalize away. (Records are
    // filed under session_id.)
    const raw = JSON.parse(readFileSync(join(chatsDir, `${sessionId}.json`), "utf8"));
    expect(raw).not.toHaveProperty("workspaceId");
  });
});

describe("upsertChat workspace linkage", () => {
  it("stamps the workspace when it creates the record", () => {
    const id = randomUUID();
    const chat = chatFileService.upsertChat(id, "/repo.feat-x", id, { metadata: "{}", workspaceId: "ws-abc123" });
    expect(chat.workspaceId).toBe("ws-abc123");
  });

  it("leaves an existing chat's linkage alone", () => {
    const id = randomUUID();
    chatFileService.upsertChat(id, "/repo.feat-x", id, { metadata: "{}", workspaceId: "ws-original" });

    const updated = chatFileService.upsertChat(id, "/repo.feat-x", id, { metadata: '{"title":"later"}', workspaceId: "ws-different" });
    expect(updated.workspaceId).toBe("ws-original");
    expect(chatFileService.getChat(id)?.workspaceId).toBe("ws-original");
    // The rest of the update still lands — only the linkage is pinned.
    expect(JSON.parse(updated.metadata).title).toBe("later");
  });

  it("does not back-fill a workspace onto an existing unlinked chat", () => {
    const id = randomUUID();
    chatFileService.upsertChat(id, "/repo", id, { metadata: "{}" });
    const updated = chatFileService.upsertChat(id, "/repo", id, { metadata: "{}", workspaceId: "ws-late" });
    expect(updated).not.toHaveProperty("workspaceId");
    expect(chatFileService.getChat(id)).not.toHaveProperty("workspaceId");
  });
});
