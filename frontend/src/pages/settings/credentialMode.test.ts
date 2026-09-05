import { describe, it, expect } from "vitest";
import {
  readClaudeCredentialMode,
  writeClaudeCredentialMode,
  readCodexCredentialMode,
  writeCodexCredentialMode,
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
