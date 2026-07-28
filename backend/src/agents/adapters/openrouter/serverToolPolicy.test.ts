/**
 * Unit tests for the pure `webAccess` gate over OpenRouter's server tools.
 *
 * `optionsAdapter.test.ts` covers the same rules through `translateOptions`
 * (which is where they actually take effect); these pin the parts that are
 * contracts rather than behavior — the assumed harness defaults, and the
 * fail-closed answer for an unclassified tool.
 */
import { describe, expect, it } from "vitest";
import {
  ASSUMED_HARNESS_DEFAULTS,
  applyModelSlugPolicy,
  applyPluginPolicy,
  applyServerToolPolicy,
  pluginNeedsWebAccess,
  serverToolNeedsWebAccess,
} from "./serverToolPolicy.js";
import { OR_MODEL_VARIANTS, OR_MODEL_VARIANT_BY_SUFFIX, OR_PLUGINS, OR_SERVER_TOOLS } from "shared/types/index.js";
import type { DefaultPermissions, PermissionLevel } from "shared/types/index.js";

const perms = (webAccess: PermissionLevel): DefaultPermissions => ({
  fileRead: "allow",
  fileWrite: "allow",
  codeExecution: "allow",
  webAccess,
});

describe("ASSUMED_HARNESS_DEFAULTS", () => {
  /**
   * The drift canary. The harness's own `DEFAULT_SERVER_TOOLS` cannot be
   * imported — it is exported from the package's `tools/index.js` but not from
   * its root, and the `exports` map declares only ".", so a deep import throws
   * ERR_PACKAGE_PATH_NOT_EXPORTED. This pins our stand-in instead, so flipping a
   * `defaultOn` flag in the catalog has to be a deliberate act rather than a
   * side effect that quietly changes what a restricted chat sends.
   */
  it("is exactly the three tools the harness injects when serverTools is unset", () => {
    expect(ASSUMED_HARNESS_DEFAULTS).toEqual([
      { type: "openrouter:datetime" },
      { type: "openrouter:web_search" },
      { type: "openrouter:web_fetch" },
    ]);
  });
});

describe("serverToolNeedsWebAccess", () => {
  it("classifies every catalog entry without falling through to the unknown default", () => {
    // Guards against a new catalog entry landing with no `webAccess` decision:
    // it would answer `true` via the `?? true` fallback and be silently
    // withheld, which is safe but would look like the flag was considered.
    for (const spec of OR_SERVER_TOOLS) {
      expect(typeof spec.webAccess).toBe("boolean");
      expect(serverToolNeedsWebAccess(spec.type)).toBe(spec.webAccess);
    }
  });

  it("answers true for a tool it has never heard of", () => {
    expect(serverToolNeedsWebAccess("openrouter:some_future_tool")).toBe(true);
    expect(serverToolNeedsWebAccess("")).toBe(true);
  });

  it("does not treat the bare (prefix-stripped) name as a known tool", () => {
    // The catalog is keyed on the full `openrouter:*` discriminator, which is
    // also what rides the wire. A bare name is not a wire type, so it is
    // unknown — and unknown fails closed.
    expect(serverToolNeedsWebAccess("web_search")).toBe(true);
    expect(serverToolNeedsWebAccess("datetime")).toBe(true);
  });
});

describe("applyServerToolPolicy", () => {
  it("passes undefined through untouched under allow (harness defaults stay in force)", () => {
    expect(applyServerToolPolicy(undefined, perms("allow"))).toEqual({ serverTools: undefined, withheld: [] });
  });

  it("materializes an explicit array under a restrictive policy", () => {
    const { serverTools, withheld } = applyServerToolPolicy(undefined, perms("deny"));
    expect(serverTools).toEqual([{ type: "openrouter:datetime" }]);
    expect(withheld).toEqual(["openrouter:web_search", "openrouter:web_fetch"]);
  });

  it("copies rather than aliases the configured array", () => {
    const configured = [{ type: "openrouter:datetime" }];
    const { serverTools } = applyServerToolPolicy(configured, perms("allow"));
    expect(serverTools).toEqual(configured);
    expect(serverTools).not.toBe(configured);
  });

  it("only ever narrows — the result is always a subset of the input", () => {
    const configured = OR_SERVER_TOOLS.map((t) => ({ type: t.type }));
    for (const level of ["allow", "ask", "deny"] as const) {
      const { serverTools } = applyServerToolPolicy(configured, perms(level));
      const inputTypes = new Set(configured.map((t) => t.type));
      for (const tool of serverTools ?? []) expect(inputTypes.has(tool.type)).toBe(true);
    }
  });

  it("treats a missing policy as restrictive", () => {
    for (const missing of [null, undefined]) {
      const { serverTools } = applyServerToolPolicy(undefined, missing);
      expect(serverTools).toEqual([{ type: "openrouter:datetime" }]);
    }
  });

  it("keeps an explicitly empty configured set empty under every policy", () => {
    for (const level of ["allow", "ask", "deny"] as const) {
      expect(applyServerToolPolicy([], perms(level))).toEqual({ serverTools: [], withheld: [] });
    }
  });
});

describe("pluginNeedsWebAccess", () => {
  it("classifies every catalog plugin without falling through to the unknown default", () => {
    // Same canary as the server-tool version: a new plugin landing with no
    // `webAccess` decision would answer `true` via the `?? true` fallback —
    // safe, but indistinguishable from a decision actually having been made.
    for (const spec of OR_PLUGINS) {
      expect(typeof spec.webAccess).toBe("boolean");
      expect(pluginNeedsWebAccess(spec.id)).toBe(spec.webAccess);
    }
  });

  it("holds the two web-carrying plugins to that classification by name", () => {
    // Pinned explicitly, not just via the loop above: these are the two entries
    // whose misclassification would silently reopen the channel, and `fusion` is
    // the one whose name suggests it is only model-to-model routing.
    expect(pluginNeedsWebAccess("web")).toBe(true);
    expect(pluginNeedsWebAccess("fusion")).toBe(true);
  });

  it("answers true for a plugin it has never heard of", () => {
    expect(pluginNeedsWebAccess("some-future-plugin")).toBe(true);
    expect(pluginNeedsWebAccess("")).toBe(true);
  });
});

describe("applyPluginPolicy", () => {
  it("passes a configured set through untouched under allow", () => {
    const configured = [{ id: "web", maxResults: 5 }, { id: "response-healing" }];
    const { plugins, withheld } = applyPluginPolicy(configured, perms("allow"));
    expect(plugins).toEqual(configured);
    expect(withheld).toEqual([]);
  });

  it("copies rather than aliases the configured entries", () => {
    // The caller's array is the resolved settings profile; the gate must not
    // hand back a reference into it (nor into its member objects).
    const configured = [{ id: "response-healing" }];
    const { plugins } = applyPluginPolicy(configured, perms("allow"));
    expect(plugins).not.toBe(configured);
    expect(plugins[0]).not.toBe(configured[0]);
  });

  it.each(["ask", "deny"] as const)("withholds web and fusion under webAccess=%s", (level) => {
    const { plugins, withheld } = applyPluginPolicy(
      [{ id: "web" }, { id: "fusion" }, { id: "response-healing" }],
      perms(level),
    );
    expect(plugins).toEqual([{ id: "response-healing" }]);
    expect(withheld).toEqual(["web", "fusion"]);
  });

  it.each(["allow", "ask", "deny"] as const)("keeps every non-web plugin under webAccess=%s", (level) => {
    const nonWeb = OR_PLUGINS.filter((p) => !p.webAccess).map((p) => ({ id: p.id }));
    const { plugins, withheld } = applyPluginPolicy(nonWeb, perms(level));
    expect(plugins).toEqual(nonWeb);
    expect(withheld).toEqual([]);
  });

  it("only ever narrows — the result is always a subset of the input", () => {
    const configured = OR_PLUGINS.map((p) => ({ id: p.id }));
    for (const level of ["allow", "ask", "deny"] as const) {
      const { plugins } = applyPluginPolicy(configured, perms(level));
      const inputIds = new Set(configured.map((p) => p.id));
      for (const plugin of plugins) expect(inputIds.has(plugin.id)).toBe(true);
    }
  });

  it("withholds an unknown plugin under a restrictive policy", () => {
    const { plugins, withheld } = applyPluginPolicy(
      [{ id: "response-healing" }, { id: "some-future-plugin" }],
      perms("deny"),
    );
    expect(plugins).toEqual([{ id: "response-healing" }]);
    expect(withheld).toEqual(["some-future-plugin"]);
  });

  it("withholds an entry whose id is not even a string", () => {
    // Only reachable via a hand-edited agent-settings.json, but the log line
    // should name something rather than blank.
    const { plugins, withheld } = applyPluginPolicy(
      [{ id: 7 } as unknown as { id: string }],
      perms("deny"),
    );
    expect(plugins).toEqual([]);
    expect(withheld).toEqual(["7"]);
  });

  it("treats a missing policy as restrictive", () => {
    for (const missing of [null, undefined]) {
      const { plugins, withheld } = applyPluginPolicy([{ id: "web" }], missing);
      expect(plugins).toEqual([]);
      expect(withheld).toEqual(["web"]);
    }
  });

  it("returns an empty set for no configured plugins under every policy", () => {
    // Unlike `serverTools`, absence carries no "inject your defaults" meaning
    // here — so there is nothing to materialize and nothing to withhold.
    for (const level of ["allow", "ask", "deny"] as const) {
      expect(applyPluginPolicy(undefined, perms(level))).toEqual({ plugins: [], withheld: [] });
      expect(applyPluginPolicy([], perms(level))).toEqual({ plugins: [], withheld: [] });
    }
  });
});

describe("OR_MODEL_VARIANTS", () => {
  /**
   * The money canary. Everything except `:online` changes routing, pricing or
   * model identity, so a stray `webAccess: true` in the catalog would silently
   * move `:free` runs onto the paid model or `:floor` runs onto a pricier
   * provider — under a web-access policy, where nobody would look for it.
   */
  it("marks exactly one variant as web access, and it is :online", () => {
    expect(OR_MODEL_VARIANTS.filter((v) => v.webAccess).map((v) => v.suffix)).toEqual(["online"]);
  });

  it("covers OpenRouter's documented variant vocabulary", () => {
    // Verbatim from the FAQ's "What are model variants?" section (2026-07):
    // static :free/:extended/:thinking, dynamic :online/:nitro/:floor/:exacto.
    expect([...OR_MODEL_VARIANTS].map((v) => v.suffix).sort()).toEqual([
      "exacto",
      "extended",
      "floor",
      "free",
      "nitro",
      "online",
      "thinking",
    ]);
  });

  it("keys every suffix in the lowercase, colon-free form the gate normalizes to", () => {
    for (const v of OR_MODEL_VARIANTS) {
      expect(v.suffix).toBe(v.suffix.trim().toLowerCase());
      expect(v.suffix).not.toContain(":");
      expect(OR_MODEL_VARIANT_BY_SUFFIX.get(v.suffix)).toBe(v);
    }
  });
});

describe("applyModelSlugPolicy", () => {
  const online = "anthropic/claude-sonnet-4:online";

  it("passes :online through untouched under allow", () => {
    expect(applyModelSlugPolicy(online, perms("allow"))).toEqual({
      model: online,
      stripped: [],
      unknown: [],
    });
  });

  it("strips :online under ask and deny alike", () => {
    // `ask` withholds for the same reason the sibling gates give: the model id
    // is fixed when the request body is assembled, and there is no per-call
    // moment at which a prompt could be raised.
    for (const level of ["ask", "deny"] as const) {
      expect(applyModelSlugPolicy(online, perms(level))).toEqual({
        model: "anthropic/claude-sonnet-4",
        stripped: ["online"],
        unknown: [],
      });
    }
  });

  it("treats a missing policy as restrictive", () => {
    for (const missing of [null, undefined]) {
      expect(applyModelSlugPolicy(online, missing).model).toBe("anthropic/claude-sonnet-4");
    }
  });

  it("never touches a variant that is not web access, under any policy", () => {
    // The regression that would quietly cost money. `:free` is a different
    // (free) copy of the model and `:floor`/`:nitro`/`:exacto` re-sort
    // providers — stripping any of them is a billing change, not a policy one.
    for (const level of ["allow", "ask", "deny"] as const) {
      for (const suffix of ["free", "extended", "thinking", "nitro", "floor", "exacto"]) {
        const slug = `openai/gpt-oss-20b:${suffix}`;
        expect(applyModelSlugPolicy(slug, perms(level))).toEqual({
          model: slug,
          stripped: [],
          unknown: [],
        });
      }
    }
  });

  it("removes only the :online segment from a chained slug, keeping the rest", () => {
    // The docs' own chaining example is `openai/gpt-oss-20b:free:online`, so a
    // suffix test would be wrong in both directions: it has to be a split.
    expect(applyModelSlugPolicy("openai/gpt-oss-20b:free:online", perms("deny"))).toEqual({
      model: "openai/gpt-oss-20b:free",
      stripped: ["online"],
      unknown: [],
    });
    expect(applyModelSlugPolicy("openai/gpt-oss-20b:online:floor", perms("deny"))).toEqual({
      model: "openai/gpt-oss-20b:floor",
      stripped: ["online"],
      unknown: [],
    });
  });

  it("matches :online regardless of case or padding, and keeps the rest verbatim", () => {
    // Leniency in the DETECTION direction only — it can strip a spelling
    // OpenRouter would have rejected, never miss one it accepts. Kept segments
    // keep the caller's own spelling.
    expect(applyModelSlugPolicy("x/y:ONLINE", perms("deny")).model).toBe("x/y");
    expect(applyModelSlugPolicy("x/y:Online", perms("deny")).stripped).toEqual(["Online"]);
    expect(applyModelSlugPolicy("x/y: online ", perms("deny")).model).toBe("x/y");
    expect(applyModelSlugPolicy("x/y:FREE:online", perms("deny")).model).toBe("x/y:FREE");
  });

  it("forwards an unrecognized variant instead of stripping it, and names it", () => {
    // The one place this gate diverges from its siblings' fail-closed default:
    // the action here is a REWRITE of the model id, so an unknown variant is
    // reported rather than removed. Silence is what it must not be.
    const { model, stripped, unknown } = applyModelSlugPolicy("x/y:someFutureVariant", perms("deny"));
    expect(model).toBe("x/y:someFutureVariant");
    expect(stripped).toEqual([]);
    expect(unknown).toEqual(["someFutureVariant"]);
  });

  it("reports unknown variants under allow too, where nothing is stripped", () => {
    const { model, unknown } = applyModelSlugPolicy("x/y:whatever:online", perms("allow"));
    expect(model).toBe("x/y:whatever:online");
    expect(unknown).toEqual(["whatever"]);
  });

  it("still strips :online when it rides alongside an unknown variant", () => {
    expect(applyModelSlugPolicy("x/y:whatever:online", perms("deny"))).toEqual({
      model: "x/y:whatever",
      stripped: ["online"],
      unknown: ["whatever"],
    });
  });

  it("leaves a plain slug, an empty string and undefined exactly as they are", () => {
    expect(applyModelSlugPolicy("anthropic/claude-sonnet-4", perms("deny"))).toEqual({
      model: "anthropic/claude-sonnet-4",
      stripped: [],
      unknown: [],
    });
    expect(applyModelSlugPolicy(undefined, perms("deny")).model).toBeUndefined();
    expect(applyModelSlugPolicy("", perms("deny")).model).toBe("");
  });

  it("yields the absent-model signal rather than an empty slug", () => {
    // Degenerate input (never a valid model id), but "" is a worse thing to
    // hand a caller than `undefined`, which every call site already reads as
    // "no model — let the harness default".
    expect(applyModelSlugPolicy(":online", perms("deny"))).toEqual({
      model: undefined,
      stripped: ["online"],
      unknown: [],
    });
  });
});
