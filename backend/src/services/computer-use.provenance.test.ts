import { afterAll, afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionProvider } from "../agents/ports/SessionProvider.js";
import { ComputerUseService, type Driver } from "@wolpertingerlabs/computer-use";

const dir = mkdtempSync(join(tmpdir(), "computer-provenance-"));
process.env.CALLBOARD_DATA_DIR = dir;
const { chatFileService } = await import("./chat-file-service.js");
const { setSessionProvidersForTesting } = await import("../agents/factory.js");
const { ComputerUseHost, loadComputerUsePolicy } = await import("./computer-use.js");
const permissions = { computerControl: "allow", webAccess: "allow", codeExecution: "allow", fileRead: "allow", fileWrite: "allow" };
afterEach(() => setSessionProvidersForTesting(null));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fixture(native = false) {
  const id = randomUUID(),
    path = join(dir, id + ".jsonl");
  function log(isNative: boolean) {
    writeFileSync(
      path,
      JSON.stringify({
        type: "session_meta",
        payload: {
          id,
          cwd: dir,
          source: isNative ? { subagent: { thread_spawn: { parent_thread_id: "parent" } } } : "exec",
          ...(isNative ? { thread_source: "subagent", parent_thread_id: "parent", subagent_history_start_ordinal: 1 } : {}),
        },
      }) + "\n",
    );
  }
  log(native);
  const resolver = (kind: string) =>
    ({ kind, resolveSession: (sid: string) => (sid === id ? { logPath: path, folder: dir, displayFolder: dir } : null) }) as SessionProvider;
  setSessionProvidersForTesting([resolver("codex")]);
  chatFileService.upsertChat(id, dir, id, { metadata: JSON.stringify({ defaultPermissions: permissions }) });
  return { id, path, log, resolver };
}

it("denies independently enabling a discovered or persisted native child despite all permissions allow", () => {
  const f = fixture(true);
  expect(() => loadComputerUsePolicy(f.id)).toThrow(/parent-owned/);
  chatFileService.updateChatMetadata(f.id, { provider: "codex", nativeAgent: { parentThreadId: "parent" } });
  rmSync(f.path);
  expect(() => loadComputerUsePolicy(f.id)).toThrow(/parent-owned/);
});

it("uses inferred provenance, rejects ambiguous evidence, and invalidates grants on identity/context changes", () => {
  const f = fixture();
  const initial = loadComputerUsePolicy(f.id).signature;
  chatFileService.updateChatMetadata(f.id, { title: "unrelated" });
  expect(loadComputerUsePolicy(f.id).signature).toBe(initial);
  setSessionProvidersForTesting([f.resolver("pi")]);
  const rerouted = loadComputerUsePolicy(f.id).signature;
  expect(rerouted).not.toBe(initial);
  chatFileService.updateChat(f.id, { folder: dir + "/moved" });
  expect(loadComputerUsePolicy(f.id).signature).not.toBe(rerouted);
  setSessionProvidersForTesting([f.resolver("pi"), f.resolver("claude-code")]);
  expect(() => loadComputerUsePolicy(f.id)).toThrow(/provenance/);
});

it("blocks capture when a previously root-owned chat gains current native-child evidence, but still permits safety stop", async () => {
  const f = fixture();
  const observe = vi.fn(async () => ({ data: "AA==", mimeType: "image/png" as const, width: 10, height: 10, capturedAt: Date.now() }));
  const driver: Driver = {
    kind: "browser",
    probe: async () => ({ kind: "browser", available: true, capabilities: ["screenshot"] }),
    open: async () => ({ observe, act: async () => {}, close: async () => {}, releaseInput: async () => {} }),
  };
  const service = new ComputerUseService({ targets: [{ id: "managed-browser", enabled: true, driver }], authorize: (request) => host.authorize(request) });
  const host: InstanceType<typeof ComputerUseHost> = new ComputerUseHost(service, { browser: driver, desktop: { ...driver, kind: "native-desktop" } });
  try {
    const opened = await host.open(f.id, "browser");
    f.log(true);
    await expect(host.observe(f.id, opened.id)).rejects.toMatchObject({ code: "denied" });
    expect(observe).not.toHaveBeenCalled();
    expect((await host.stop(f.id, opened.id)).state).toBe("stopped");
  } finally {
    await host.dispose();
  }
});
