/**
 * Unit tests for {@link isCodexConfigured} and {@link getCodexAuthSource} —
 * the credential-readiness check surfaced as `codexConfigured` /
 * `codexAuthSource` on `GET /api/system-info`. Three sources count as
 * configured: a non-empty `codexApiKey` (api-key mode), a parseable
 * `$CODEX_HOME/auth.json` (subscription, from `codex login`), or a
 * `$CODEX_HOME/config.toml` declaring a `model_provider` (manual setup).
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCodexAuthSource, isCodexConfigured } from "./codexAuth.js";

const SETTINGS_MODULE = "../../../services/agent-settings.js";

vi.mock("../../../services/agent-settings.js", () => ({
  getAgentSettings: vi.fn(),
}));

let CODEX_HOME: string;

beforeEach(() => {
  CODEX_HOME = join(tmpdir(), `codex-auth-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(CODEX_HOME, { recursive: true });
});

afterEach(async () => {
  rmSync(CODEX_HOME, { recursive: true, force: true });
  const { getAgentSettings } = await import(SETTINGS_MODULE);
  vi.mocked(getAgentSettings).mockReset();
});

async function setSettings(settings: Record<string, unknown>) {
  const { getAgentSettings } = await import(SETTINGS_MODULE);
  vi.mocked(getAgentSettings).mockReturnValue(settings as never);
}

describe("isCodexConfigured / getCodexAuthSource", () => {
  it("api-key mode: configured when codexApiKey is set", async () => {
    await setSettings({ codexAuthMode: "api-key", codexApiKey: "sk-test" });
    expect(isCodexConfigured()).toBe(true);
    expect(getCodexAuthSource()).toBe("api-key");
  });

  it("api-key mode: unconfigured when codexApiKey is blank", async () => {
    await setSettings({ codexAuthMode: "api-key", codexApiKey: "   " });
    expect(isCodexConfigured()).toBe(false);
    expect(getCodexAuthSource()).toBe(null);
  });

  it("subscription mode: auth.json source when $CODEX_HOME/auth.json parses", async () => {
    writeFileSync(join(CODEX_HOME, "auth.json"), JSON.stringify({ tokens: { access_token: "x" } }), "utf-8");
    await setSettings({ codexAuthMode: "subscription", codexHome: CODEX_HOME });
    expect(getCodexAuthSource()).toBe("auth.json");
    expect(isCodexConfigured()).toBe(true);
  });

  it("subscription mode (default): unconfigured when nothing in $CODEX_HOME", async () => {
    await setSettings({ codexHome: CODEX_HOME });
    expect(getCodexAuthSource()).toBe(null);
    expect(isCodexConfigured()).toBe(false);
  });

  it("subscription mode: falls back to config.toml when auth.json is malformed", async () => {
    writeFileSync(join(CODEX_HOME, "auth.json"), "{ not json", "utf-8");
    writeFileSync(join(CODEX_HOME, "config.toml"), 'model_provider = "myprov"\n[model_providers.myprov]\nbase_url = "https://x"\n', "utf-8");
    await setSettings({ codexAuthMode: "subscription", codexHome: CODEX_HOME });
    expect(getCodexAuthSource()).toBe("config.toml");
    expect(isCodexConfigured()).toBe(true);
  });

  it("subscription mode: unconfigured when auth.json malformed and no config.toml", async () => {
    writeFileSync(join(CODEX_HOME, "auth.json"), "{ not json", "utf-8");
    await setSettings({ codexAuthMode: "subscription", codexHome: CODEX_HOME });
    expect(getCodexAuthSource()).toBe(null);
    expect(isCodexConfigured()).toBe(false);
  });

  it("subscription mode: config.toml with model_provider counts as configured", async () => {
    writeFileSync(join(CODEX_HOME, "config.toml"), 'model_provider = "openai"\n', "utf-8");
    await setSettings({ codexAuthMode: "subscription", codexHome: CODEX_HOME });
    expect(getCodexAuthSource()).toBe("config.toml");
    expect(isCodexConfigured()).toBe(true);
  });

  it("subscription mode: config.toml with [model_providers.X] counts as configured", async () => {
    writeFileSync(join(CODEX_HOME, "config.toml"), '[model_providers.proxy]\nbase_url = "https://x"\nenv_key = "OPENAI_API_KEY"\n', "utf-8");
    await setSettings({ codexAuthMode: "subscription", codexHome: CODEX_HOME });
    expect(getCodexAuthSource()).toBe("config.toml");
    expect(isCodexConfigured()).toBe(true);
  });

  it("subscription mode: trust-only config.toml does NOT count (no provider declared)", async () => {
    // The user's own config.toml had only [projects.*] trust settings, which
    // the CLI can't use to authenticate. Treating it as configured would
    // promise something Codex can't deliver.
    writeFileSync(join(CODEX_HOME, "config.toml"), '[projects."/some/path"]\ntrust_level = "trusted"\n', "utf-8");
    await setSettings({ codexAuthMode: "subscription", codexHome: CODEX_HOME });
    expect(getCodexAuthSource()).toBe(null);
    expect(isCodexConfigured()).toBe(false);
  });

  it("subscription mode: auth.json wins over config.toml when both are present", async () => {
    writeFileSync(join(CODEX_HOME, "auth.json"), JSON.stringify({ tokens: { access_token: "x" } }), "utf-8");
    writeFileSync(join(CODEX_HOME, "config.toml"), 'model_provider = "myprov"\n', "utf-8");
    await setSettings({ codexAuthMode: "subscription", codexHome: CODEX_HOME });
    expect(getCodexAuthSource()).toBe("auth.json");
  });
});
