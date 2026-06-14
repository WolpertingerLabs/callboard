/**
 * Unit tests for {@link isCodexConfigured} — the credential-readiness check
 * surfaced as `codexConfigured` on `GET /api/system-info`. Subscription mode
 * keys off a parseable `$CODEX_HOME/auth.json`; api-key mode keys off a
 * non-empty `codexApiKey`.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isCodexConfigured } from "./codexAuth.js";

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

describe("isCodexConfigured", () => {
  it("api-key mode: true when codexApiKey is set", async () => {
    await setSettings({ codexAuthMode: "api-key", codexApiKey: "sk-test" });
    expect(isCodexConfigured()).toBe(true);
  });

  it("api-key mode: false when codexApiKey is blank", async () => {
    await setSettings({ codexAuthMode: "api-key", codexApiKey: "   " });
    expect(isCodexConfigured()).toBe(false);
  });

  it("subscription mode: true when $CODEX_HOME/auth.json parses", async () => {
    writeFileSync(join(CODEX_HOME, "auth.json"), JSON.stringify({ tokens: { access_token: "x" } }), "utf-8");
    await setSettings({ codexAuthMode: "subscription", codexHome: CODEX_HOME });
    expect(isCodexConfigured()).toBe(true);
  });

  it("subscription mode (default): false when auth.json is absent", async () => {
    await setSettings({ codexHome: CODEX_HOME });
    expect(isCodexConfigured()).toBe(false);
  });

  it("subscription mode: false when auth.json is malformed JSON", async () => {
    writeFileSync(join(CODEX_HOME, "auth.json"), "{ not json", "utf-8");
    await setSettings({ codexAuthMode: "subscription", codexHome: CODEX_HOME });
    expect(isCodexConfigured()).toBe(false);
  });
});
