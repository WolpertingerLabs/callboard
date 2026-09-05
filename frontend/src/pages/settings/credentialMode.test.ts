import { describe, it, expect } from "vitest";
import {
  readClaudeCredentialMode,
  writeClaudeCredentialMode,
  readCodexCredentialMode,
  writeCodexCredentialMode,
  claudeOpenRouterCredentialReady,
  codexOpenRouterCredentialReady,
  type ClaudeCredentialFields,
  type ClaudeCredentialMode,
  type CodexCredentialFields,
  type CodexCredentialMode,
} from "./credentialMode";

const CLAUDE_MODES: ClaudeCredentialMode[] = ["anthropic", "openrouter"];
const CODEX_MODES: CodexCredentialMode[] = ["subscription", "api-key", "openrouter"];

describe("readClaudeCredentialMode", () => {
  it("reads a settings object with neither field set as anthropic", () => {
    expect(readClaudeCredentialMode({})).toBe("anthropic");
  });

  it("reads an explicit false as anthropic", () => {
    expect(readClaudeCredentialMode({ claudeCodeUseOpenRouter: false })).toBe("anthropic");
  });

  it("reads the routing flag as openrouter", () => {
    expect(readClaudeCredentialMode({ claudeCodeUseOpenRouter: true })).toBe("openrouter");
  });
});

describe("writeClaudeCredentialMode", () => {
  it("round-trips every mode", () => {
    for (const mode of CLAUDE_MODES) {
      expect(readClaudeCredentialMode(writeClaudeCredentialMode(mode))).toBe(mode);
    }
  });

  it("sends the flag off explicitly, so a stored true is cleared rather than left standing", () => {
    // `undefined` would leave the field untouched by the settings route's
    // partial merge — an off that does not turn anything off.
    expect(writeClaudeCredentialMode("anthropic")).toEqual({ claudeCodeUseOpenRouter: false });
  });
});

describe("readCodexCredentialMode", () => {
  it("reads a settings object with neither field set as subscription", () => {
    expect(readCodexCredentialMode({})).toBe("subscription");
  });

  it("reads the auth mode when routing is off", () => {
    expect(readCodexCredentialMode({ codexAuthMode: "api-key" })).toBe("api-key");
    expect(readCodexCredentialMode({ codexUseOpenRouter: false, codexAuthMode: "api-key" })).toBe("api-key");
  });

  it("lets routing win over the auth mode, matching isCodexRoutedThroughOpenRouter", () => {
    expect(readCodexCredentialMode({ codexUseOpenRouter: true, codexAuthMode: "api-key" })).toBe("openrouter");
  });
});

describe("writeCodexCredentialMode", () => {
  it("round-trips every mode", () => {
    for (const mode of CODEX_MODES) {
      expect(readCodexCredentialMode(writeCodexCredentialMode(mode))).toBe(mode);
    }
  });

  it("leaves codexAuthMode alone when selecting openrouter", () => {
    expect(writeCodexCredentialMode("openrouter")).toEqual({ codexUseOpenRouter: true });
  });

  it("preserves the last native choice across a trip through openrouter and back", () => {
    for (const native of ["subscription", "api-key"] as const) {
      let stored: CodexCredentialFields = { codexUseOpenRouter: false, codexAuthMode: native };
      stored = { ...stored, ...writeCodexCredentialMode("openrouter") };
      expect(readCodexCredentialMode(stored)).toBe("openrouter");
      expect(stored.codexAuthMode).toBe(native);
      // "Back" is whatever the control now derives, not a remembered click.
      stored = { ...stored, ...writeCodexCredentialMode(readCodexCredentialMode({ ...stored, codexUseOpenRouter: false })) };
      expect(readCodexCredentialMode(stored)).toBe(native);
    }
  });
});

describe("the two controls together", () => {
  it("write only the fields their own harness reads", () => {
    // The PUT is a partial merge, so a key that is absent here is a setting the
    // daemon keeps — which is what stops one tab's click from touching the
    // other tab's credential, or any unsaved edit on the page.
    for (const mode of CLAUDE_MODES) {
      expect(Object.keys(writeClaudeCredentialMode(mode))).toEqual(["claudeCodeUseOpenRouter"]);
    }
    expect(Object.keys(writeCodexCredentialMode("openrouter"))).toEqual(["codexUseOpenRouter"]);
    expect(Object.keys(writeCodexCredentialMode("api-key")).sort()).toEqual(["codexAuthMode", "codexUseOpenRouter"]);
  });

  it("reads a legacy settings object — every field absent — as the native default on both tabs", () => {
    const legacy: ClaudeCredentialFields & CodexCredentialFields = {};
    expect(readClaudeCredentialMode(legacy)).toBe("anthropic");
    expect(readCodexCredentialMode(legacy)).toBe("subscription");
  });
});

/**
 * The readiness pair, case for case against the backend predicates it mirrors.
 *
 * The one that matters most is the last Codex case: the two harnesses agree on
 * every row but that one, which is why the gate was copied between them and why
 * the copy was wrong. `codexAuth.test.ts` pins the same case on the backend
 * side.
 */
describe("claudeOpenRouterCredentialReady", () => {
  it("is ready on a stored key alone", () => {
    expect(claudeOpenRouterCredentialReady({ claudeCodeOpenRouterApiKey: "sk-or-x" }, false)).toBe(true);
  });

  it("is ready on a detected environment alone — no override needed", () => {
    expect(claudeOpenRouterCredentialReady({}, true)).toBe(true);
  });

  it("treats a whitespace-only key as no key", () => {
    expect(claudeOpenRouterCredentialReady({ claudeCodeOpenRouterApiKey: "   " }, false)).toBe(false);
  });

  it("is not ready with neither", () => {
    expect(claudeOpenRouterCredentialReady({}, false)).toBe(false);
  });
});

describe("codexOpenRouterCredentialReady", () => {
  it("is ready on a stored key alone", () => {
    expect(codexOpenRouterCredentialReady({ codexOpenRouterApiKey: "sk-or-x" }, false)).toBe(true);
  });

  it("is ready on a detected environment WITH an endpoint override to honour", () => {
    expect(codexOpenRouterCredentialReady({ codexOpenRouterBaseUrl: "https://eu.openrouter.ai/api/v1" }, true)).toBe(true);
  });

  it("is NOT ready on a detected environment alone — the user's own provider wiring stands", () => {
    // The case the Claude Code gate gets wrong when it is copied here: a
    // config.toml naming openrouter.ai, no stored key, no override. The backend
    // injects nothing, so the flag would be a no-op and the segment must stay
    // disabled. See codexAuth.test.ts, "stays off with no key and no override".
    expect(codexOpenRouterCredentialReady({}, true)).toBe(false);
    expect(claudeOpenRouterCredentialReady({}, true)).toBe(true);
  });

  it("is not ready on an override with nothing to override", () => {
    expect(codexOpenRouterCredentialReady({ codexOpenRouterBaseUrl: "https://eu.openrouter.ai/api/v1" }, false)).toBe(false);
  });

  it("is not ready with neither", () => {
    expect(codexOpenRouterCredentialReady({}, false)).toBe(false);
  });
});
