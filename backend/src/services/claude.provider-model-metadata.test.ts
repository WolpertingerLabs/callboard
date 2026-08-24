/**
 * What `sendMessage` pins into a new chat's metadata for provider/model.
 *
 * The write guard and the read are ~500 lines apart in claude.ts, and nothing
 * connected them: each provider's config block resolves `initialMetadata.model`,
 * while chat creation decided separately, from a hand-listed set of kinds,
 * whether to write it. `"codex"` was in the reading half and missing from the
 * writing half, so `{ provider: "codex", model: "gpt-5.5" }` resolved correctly
 * through every layer above and then evaporated at creation — the chat ran on
 * the global default model and said nothing about it.
 *
 * A round-trip is the only shape of test that catches that class of bug, so
 * every routable kind gets one here rather than just the one that was broken.
 * Driven end-to-end through `sendMessage` with a scripted provider, in the style
 * of claude.auto-card.test.ts, and asserted against the chat record on disk.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type { AgentEvent } from "../agents/ports/events.js";
import type { StreamEvent } from "shared/types/index.js";

// Isolate all chat writes into a throwaway data dir. Must be set before the
// dynamic imports below — DATA_DIR is resolved at module load.
const dataDir = mkdtempSync(join(tmpdir(), "callboard-provider-model-data-"));
process.env.CALLBOARD_DATA_DIR = dataDir;
const workDir = mkdtempSync(join(tmpdir(), "callboard-provider-model-work-"));

// Non-triggered chats fire LLM title generation. Fire-and-forget and already
// error-swallowing, but stubbing it keeps the run offline and deterministic.
vi.mock("./quick-completion.js", () => ({
  generateChatTitle: async () => null,
  generateBranchName: async () => null,
  quickCompletion: async () => ({ text: "" }),
}));

const { sendMessage } = await import("./claude.js");
const { setAgentProviderForTesting } = await import("../agents/factory.js");
const { MockAgentProvider } = await import("../agents/adapters/mock/MockAgentProvider.js");
const { chatFileService } = await import("./chat-file-service.js");

const HEALTHY = (sessionId: string): AgentEvent[] => [
  { type: "session_started", sessionId },
  { type: "text", content: "ok" },
  { type: "result", status: "success" },
];

let sessionCounter = 0;

/**
 * Run one `sendMessage` to completion and hand back the metadata it persisted.
 *
 * The mock is injected under the kind being tested, not the default slot:
 * production looks the adapter up by kind, so injecting under "claude-code"
 * would let a codex chat construct the real Codex adapter.
 */
async function metadataFor(opts: { provider?: string; acpProviderId?: string; model?: string }): Promise<Record<string, unknown>> {
  const sessionId = `provider-model-sess-${++sessionCounter}`;
  setAgentProviderForTesting(new MockAgentProvider({ events: HEALTHY(sessionId) }), (opts.provider ?? "claude-code") as never, opts.acpProviderId as never);
  const emitter = await sendMessage({ prompt: "build the thing", folder: workDir, ...opts } as never);
  const chatId = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("session did not finish within 10s")), 10_000);
    let seen: string | undefined;
    emitter.on("event", (e: StreamEvent & { chatId?: string }) => {
      if (e.type === "chat_created" && e.chatId) seen = e.chatId;
      if (e.type === "done" || e.type === "error") {
        clearTimeout(timer);
        if (seen) resolve(seen);
        else reject(new Error("no chat_created event"));
      }
    });
  });
  const chat = chatFileService.getChat(chatId);
  expect(chat, `chat ${chatId} was never written`).not.toBeNull();
  return JSON.parse(chat!.metadata || "{}");
}

afterEach(() => {
  setAgentProviderForTesting(null);
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

describe("sendMessage pins provider and model into new-chat metadata", () => {
  it("writes the per-chat model for codex", async () => {
    // The regression. The Codex config block resolves this value; before the
    // fix nothing ever wrote it, so the chat silently ran the global default.
    const meta = await metadataFor({ provider: "codex", model: "gpt-5.5" });
    expect(meta.provider).toBe("codex");
    expect(meta.model).toBe("gpt-5.5");
  });

  it("writes the per-chat model for every other kind that reads one back", async () => {
    // claude-code, cline and pi were already correct — they are here as the
    // controls that make the codex case above mean something, and so that the
    // next kind to land cannot quietly regress in the same direction.
    expect(await metadataFor({ provider: "claude-code", model: "opus" })).toMatchObject({ model: "opus" });
    expect(await metadataFor({ provider: "cline", model: "some-cline-model" })).toMatchObject({ provider: "cline", model: "some-cline-model" });
    expect(await metadataFor({ provider: "pi", model: "some-pi-model" })).toMatchObject({ provider: "pi", model: "some-pi-model" });
    expect(await metadataFor({ provider: "acp", acpProviderId: "opencode", model: "some-acp-model" })).toMatchObject({
      provider: "acp",
      acpProviderId: "opencode",
      model: "some-acp-model",
    });
  });

  it("omits model entirely when the caller passes none", async () => {
    // The inheritance rule depends on this: a spawned child that inherited only
    // its parent's provider must fall through to the target's configured
    // default, which means no key at all rather than an empty one.
    const meta = await metadataFor({ provider: "codex" });
    expect(meta.provider).toBe("codex");
    expect(meta).not.toHaveProperty("model");
  });

  it("does not write claude-code as an explicit provider", async () => {
    // It is the routing default, so writing it is redundant — asserted because
    // the model guard now shares its `?? "claude-code"` normalization.
    const meta = await metadataFor({ provider: "claude-code", model: "opus" });
    expect(meta).not.toHaveProperty("provider");
    expect(meta.model).toBe("opus");
  });
});
