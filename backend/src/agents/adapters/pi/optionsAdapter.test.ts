import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  buildPiServicesOptions,
  buildPiSessionOptions,
  createPiSettingsManager,
  translateThinkingLevel,
  resolvePiAgentDir,
  DEFAULT_PI_PROVIDER_ID,
  PI_CACHE_WARMING_MODE,
} from "./optionsAdapter.js";
import type { EffortLevel } from "shared/types/index.js";

describe("translateThinkingLevel", () => {
  it.each(["xhigh", "high", "medium", "low", "minimal"] as const)("passes %s through verbatim", (effort) => {
    expect(translateThinkingLevel(effort)).toEqual({ thinkingLevel: effort });
  });

  it("maps callboard's 'none' onto pi's 'off'", () => {
    expect(translateThinkingLevel("none")).toEqual({ thinkingLevel: "off" });
  });

  /**
   * Not a stylistic choice. The spike hit a hard 400 from
   * `google/gemini-3.6-flash`: "Reasoning is mandatory for this endpoint and
   * cannot be disabled." Defaulting an effort-less chat to "off" would break
   * that whole class of models for every user who never touched the control.
   */
  it("sends nothing at all when no effort is recorded, rather than defaulting to off", () => {
    expect(translateThinkingLevel(undefined)).toEqual({});
    expect(translateThinkingLevel(undefined)).not.toHaveProperty("thinkingLevel");
  });

  it("covers every EffortLevel the shared type declares", () => {
    const all: EffortLevel[] = ["xhigh", "high", "medium", "low", "minimal", "none"];
    for (const effort of all) {
      expect(translateThinkingLevel(effort).thinkingLevel).toBeTruthy();
    }
  });
});

describe("resolvePiAgentDir", () => {
  it("is callboard's own directory, never the user's ~/.pi/agent", () => {
    const dir = resolvePiAgentDir();
    expect(dir).toContain("pi-agent");
    expect(dir).not.toMatch(/[/\\]\.pi[/\\]agent$/);
  });

  it("is a function so a per-test CALLBOARD_DATA_DIR is honoured", () => {
    expect(typeof resolvePiAgentDir).toBe("function");
  });
});

describe("buildPiSessionOptions", () => {
  const base = { pi: {}, customTools: [], filters: {} };

  it("omits every optional key when nothing is configured", () => {
    const options = buildPiSessionOptions(base);
    expect(options).toEqual({});
  });

  it("passes the resolved model through", () => {
    const model = { id: "google/gemini-3.6-flash", provider: "openrouter" } as never;
    expect(buildPiSessionOptions({ ...base, model }).model).toBe(model);
  });

  it("carries the thinking level from the effort axis", () => {
    expect(buildPiSessionOptions({ ...base, model: { reasoning: true } as never, pi: { effort: "high" } }).thinkingLevel).toBe("high");
  });

  it("includes customTools only when there are some", () => {
    expect(buildPiSessionOptions(base)).not.toHaveProperty("customTools");
    const tools = [{ name: "t" }] as never[];
    expect(buildPiSessionOptions({ ...base, customTools: tools }).customTools).toBe(tools);
  });

  it("passes the tool filters straight through", () => {
    const options = buildPiSessionOptions({ ...base, filters: { tools: ["read", "set_chat_title"], excludeTools: ["bash"] } });
    expect(options.tools).toEqual(["read", "set_chat_title"]);
    expect(options.excludeTools).toEqual(["bash"]);
  });

  it("omits filters entirely when no axis narrows anything", () => {
    const options = buildPiSessionOptions(base);
    expect(options).not.toHaveProperty("tools");
    expect(options).not.toHaveProperty("excludeTools");
  });

  it("never sets a tool allowlist without being asked to", () => {
    // An accidental empty allowlist would leave the model with no tools at all.
    expect(buildPiSessionOptions({ ...base, model: { reasoning: true } as never, pi: { effort: "low" } }).tools).toBeUndefined();
  });
});

describe("DEFAULT_PI_PROVIDER_ID", () => {
  it("is openrouter — the provider pi is native to", () => {
    expect(DEFAULT_PI_PROVIDER_ID).toBe("openrouter");
  });
});

describe("SDK thinking clamp defense", () => {
  const base = { pi: {}, customTools: [], filters: {} };
  it("rejects an explicit effort when no model resolves", () => {
    expect(() => buildPiSessionOptions({ ...base, pi: { effort: "high" } })).toThrow("no model resolved");
  });
  it("rejects xhigh on a reasoning model without an SDK map instead of clamping to high", () => {
    expect(() => buildPiSessionOptions({ ...base, model: { reasoning: true } as never, pi: { effort: "xhigh" } })).toThrow("xhigh");
  });
  it("accepts xhigh only with an explicit SDK mapping", () => {
    expect(
      buildPiSessionOptions({ ...base, model: { reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } } as never, pi: { effort: "xhigh" } }).thinkingLevel,
    ).toBe("xhigh");
  });
  it("rejects explicit null mappings", () => {
    expect(() => buildPiSessionOptions({ ...base, model: { reasoning: true, thinkingLevelMap: { high: null } } as never, pi: { effort: "high" } })).toThrow(
      "high",
    );
  });
});

/**
 * Cache warming must be off no matter what pi's global settings say. pi 1.x
 * defaults it to "idle", and every warm is a billed request callboard never
 * accounts for. The getter is what pi's warmer consults, so the getter is what
 * these tests pin — including against the two ways the obvious fix
 * (`applyOverrides`) silently fails.
 */
describe("cache warming", () => {
  let agentDir: string;
  let cwd: string;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "callboard-pi-warm-agent-"));
    cwd = mkdtempSync(join(tmpdir(), "callboard-pi-warm-cwd-"));
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: "idle" }));
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("is really asked for by the global settings file in these tests (control)", () => {
    // Without this the "off" assertions below could pass on pi's default alone.
    expect(SettingsManager.create(cwd, agentDir, { projectTrusted: false }).getCacheWarmingMode()).toBe("idle");
  });

  it("is not switched off by applyOverrides — which is why the getter is pinned instead", () => {
    // Pins the pi behaviour the design rests on. If pi ever makes overrides
    // reach the getter, this fails and the pin can become an override.
    const stock = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
    stock.applyOverrides({ cacheWarming: "off" });
    expect(stock.getCacheWarmingMode()).toBe("idle");
  });

  it("is off on the services' settings manager even when the global settings say idle", () => {
    const options = buildPiServicesOptions({ cwd, agentDir, extension: () => {}, skillPaths: [] });
    expect(options.settingsManager?.getCacheWarmingMode()).toBe("off");
    expect(PI_CACHE_WARMING_MODE).toBe("off");
  });

  it("stays off across settingsManager.reload()", async () => {
    const settingsManager = createPiSettingsManager(cwd, agentDir);
    // Re-written between create and reload, so reload has something new to read.
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: "streaming" }));
    await settingsManager.reload();
    expect(settingsManager.getGlobalSettings().cacheWarming).toBe("streaming");
    expect(settingsManager.getCacheWarmingMode()).toBe("off");
  });

  it("stays off after something calls setCacheWarmingMode", async () => {
    const settingsManager = createPiSettingsManager(cwd, agentDir);
    settingsManager.setCacheWarmingMode("idle");
    await settingsManager.flush();
    expect(settingsManager.getCacheWarmingMode()).toBe("off");
  });

  /**
   * The getter pin, end to end on a real pi session: real services, a real
   * `createAgentSessionFromServices`, and pi's own `CacheWarmer` reporting its
   * mode. Never prompted and offline, so nothing leaves the process. The
   * control builds the same session on pi's stock settings manager, so the
   * "disabled" answer cannot come from anything but the pin.
   */
  async function realSession(settingsManager?: SettingsManager) {
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false });
    const base = buildPiServicesOptions({ cwd, agentDir, extension: () => {}, skillPaths: [] });
    const services = await createAgentSessionServices({ ...base, ...(settingsManager && { settingsManager }), modelRuntime });
    const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(cwd) });
    return session;
  }

  it("reports itself disabled on a real pi session built from these options", async () => {
    const session = await realSession();
    try {
      expect(session.cacheWarmingStatus).toEqual({ state: "inactive", reason: "cache warming disabled" });
    } finally {
      session.dispose();
    }
  });

  it("is armed on the same real session without the pin (control)", async () => {
    const session = await realSession(SettingsManager.create(cwd, agentDir, { projectTrusted: false }));
    try {
      expect(session.cacheWarmingStatus).toMatchObject({ state: "inactive" });
      expect(session.cacheWarmingStatus?.reason).not.toBe("cache warming disabled");
    } finally {
      session.dispose();
    }
  });

  it("appends appendSystemPrompt after pi's own prompt and its discovered append, on a real session", async () => {
    // pi's own discovered append (the global APPEND_SYSTEM.md) must survive:
    // the option adds to it rather than replacing it.
    writeFileSync(join(agentDir, "APPEND_SYSTEM.md"), "DISCOVERED APPEND");
    try {
      const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false });
      const plain = buildPiServicesOptions({ cwd, agentDir, extension: () => {}, skillPaths: [] });
      const base = await createAgentSessionFromServices({ services: await createAgentSessionServices({ ...plain, modelRuntime }), sessionManager: SessionManager.inMemory(cwd) });
      const opts = buildPiServicesOptions({ cwd, agentDir, extension: () => {}, skillPaths: [], appendSystemPrompt: ["ASIDE INSTRUCTION"] });
      const extended = await createAgentSessionFromServices({ services: await createAgentSessionServices({ ...opts, modelRuntime }), sessionManager: SessionManager.inMemory(cwd) });
      try {
        const before = base.session.systemPrompt;
        const after = extended.session.systemPrompt;
        expect(before).toContain("DISCOVERED APPEND");
        expect(before).not.toContain("ASIDE INSTRUCTION");
        expect(after).toContain("DISCOVERED APPEND");
        expect(after).toContain("ASIDE INSTRUCTION");
        // pi's base prompt is kept whole: the extended prompt starts the same way.
        expect(after.startsWith(before.slice(0, 200))).toBe(true);
      } finally {
        base.session.dispose();
        extended.session.dispose();
      }
    } finally {
      rmSync(join(agentDir, "APPEND_SYSTEM.md"), { force: true });
    }
  });

  it("appends it again on a RESUMED session: pi rebuilds the system prompt from the loader, not from the file", async () => {
    // Persist a real two-message session, then reopen the file as PiAgentQuery
    // does on resume (SessionManager.open) with the addition configured.
    const sessionDir = join(agentDir, "sessions-resume");
    const writer = SessionManager.create(cwd, sessionDir, { id: "resume-check" });
    writer.appendMessage({ role: "user", content: "q", timestamp: Date.now() } as never);
    writer.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "a" }],
      api: "openai-completions",
      provider: "openrouter",
      model: "m",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    } as never);
    const file = writer.getSessionFile()!;
    expect(readFileSync(file, "utf-8")).toContain('"q"');

    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false });
    const opts = buildPiServicesOptions({ cwd, agentDir, extension: () => {}, skillPaths: [], appendSystemPrompt: ["ASIDE INSTRUCTION"] });
    const { session } = await createAgentSessionFromServices({
      services: await createAgentSessionServices({ ...opts, modelRuntime }),
      sessionManager: SessionManager.open(file, sessionDir, cwd),
    });
    try {
      expect(session.messages.length).toBe(2); // the history really was resumed
      expect(session.systemPrompt).toContain("ASIDE INSTRUCTION");
    } finally {
      session.dispose();
    }
  });

  it("adds no override when there is nothing to append", () => {
    const options = buildPiServicesOptions({ cwd, agentDir, extension: () => {}, skillPaths: [] });
    expect(options.resourceLoaderOptions).not.toHaveProperty("appendSystemPromptOverride");
  });

  it("does not write anything to the user's settings file", () => {
    createPiSettingsManager(cwd, agentDir);
    buildPiServicesOptions({ cwd, agentDir, extension: () => {}, skillPaths: [] });
    expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"))).toEqual({ cacheWarming: "idle" });
  });
});
