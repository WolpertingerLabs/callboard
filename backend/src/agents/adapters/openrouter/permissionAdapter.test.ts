/**
 * OpenRouter categorizer tests.
 *
 * The tool-name lists here are not invented — they are the harness's own
 * `allTools()` bundle and `DEFAULT_SERVER_TOOLS`, read out of the installed
 * `@wolpertingerlabs/openrouter-agent-harness`. If the harness adds a client
 * tool, `covers every tool the harness ships` is the test that notices.
 */
import { describe, it, expect } from "vitest";
import { categorizeOpenRouterTool, isOrToolIdentifier, MOST_RESTRICTIVE_CATEGORY } from "./permissionAdapter.js";
import { ToolPermissionPolicy } from "../../permissions/ToolPermissionPolicy.js";
import type { DefaultPermissions } from "shared/types/index.js";

/** Every client tool `allTools()` can put in the model's pool. */
const HARNESS_CLIENT_TOOLS = [
  "read_file",
  "write_file",
  "edit_file",
  "list_directory",
  "bash",
  "grep_files",
  "glob",
  "ask_user_question",
  "task_create",
  "task_update",
  "edit_notebook",
  "monitor",
  "spawn_subagent",
  "spawn_subagents",
  "tool_search",
  "tool_load",
  "skill",
] as const;

/** `DEFAULT_SERVER_TOOLS`, in both the prefixed and display forms. */
const SERVER_TOOLS = ["datetime", "web_search", "web_fetch"] as const;

describe("categorizeOpenRouterTool", () => {
  describe("the headline: server tools no longer land on fileWrite", () => {
    it("puts web_search and web_fetch on webAccess", () => {
      expect(categorizeOpenRouterTool("web_search")).toBe("webAccess");
      expect(categorizeOpenRouterTool("web_fetch")).toBe("webAccess");
    });

    it("accepts the openrouter: prefixed form too", () => {
      expect(categorizeOpenRouterTool("openrouter:web_search")).toBe("webAccess");
      expect(categorizeOpenRouterTool("openrouter:web_fetch")).toBe("webAccess");
      expect(categorizeOpenRouterTool("openrouter:datetime")).toBe("fileRead");
    });

    /**
     * `datetime` reads a clock. None of the four axes describes that, and the
     * type can spell "no axis" as `null` — but `null` means "ask", not
     * "allowed", so it would prompt even under an all-allow policy and stall
     * unattended runs. `fileRead` is the weakest real gate and a true upper
     * bound on what the tool can do.
     */
    it("puts datetime on fileRead rather than null", () => {
      expect(categorizeOpenRouterTool("datetime")).toBe("fileRead");
    });
  });

  describe("client tools", () => {
    it("categorizes read-only file tools as fileRead", () => {
      for (const name of ["read_file", "list_directory", "grep_files", "glob"]) {
        expect(categorizeOpenRouterTool(name), name).toBe("fileRead");
      }
    });

    it("categorizes mutating file tools as fileWrite", () => {
      for (const name of ["write_file", "edit_file", "edit_notebook"]) {
        expect(categorizeOpenRouterTool(name), name).toBe("fileWrite");
      }
    });

    it("categorizes bash as codeExecution — the live bypass this fixes", () => {
      expect(categorizeOpenRouterTool("bash")).toBe("codeExecution");
    });

    /**
     * `monitor` reads like a viewer and is not one: it spawns a command via
     * `/bin/sh -c`. The exact table has to catch this, because the tokenizer
     * fallback would not.
     */
    it("categorizes monitor as codeExecution despite the name", () => {
      expect(categorizeOpenRouterTool("monitor")).toBe("codeExecution");
    });

    it("categorizes subagent spawning as codeExecution", () => {
      expect(categorizeOpenRouterTool("spawn_subagent")).toBe("codeExecution");
      expect(categorizeOpenRouterTool("spawn_subagents")).toBe("codeExecution");
    });

    /**
     * OR's `ask_user_question` is surfaced by the harness's own
     * `onAskUserQuestion` host handler AFTER the gate lets the tool run —
     * `buildCanUseTool`'s special case matches Claude's PascalCase
     * `AskUserQuestion` only. So it has to resolve to a normally-allowed
     * category; a `null` here would put a permission dialog in front of every
     * question the agent asks, and hang unattended runs outright.
     */
    it("lets ask_user_question through on a normally-allowed axis", () => {
      expect(categorizeOpenRouterTool("ask_user_question")).toBe("fileRead");
    });

    it("covers every tool the harness ships, with no fallback guessing", () => {
      // A tool reaching MOST_RESTRICTIVE_CATEGORY means the exact table missed
      // it. `bash`/`monitor`/`spawn_subagent*` are legitimately codeExecution,
      // so exclude those four from the "was it guessed?" check.
      const legitimatelyExec = new Set(["bash", "monitor", "spawn_subagent", "spawn_subagents"]);
      for (const name of HARNESS_CLIENT_TOOLS) {
        const category = categorizeOpenRouterTool(name);
        expect(category, `${name} has no category`).not.toBeNull();
        if (!legitimatelyExec.has(name)) {
          expect(category, `${name} fell through to the unknown default — add it to EXACT_CATEGORIES`).not.toBe(MOST_RESTRICTIVE_CATEGORY);
        }
      }
      for (const name of SERVER_TOOLS) {
        expect(categorizeOpenRouterTool(name), `${name} fell through`).not.toBe(MOST_RESTRICTIVE_CATEGORY);
      }
    });
  });

  describe("MCP tools (the fallback path)", () => {
    /**
     * callboard's in-process bundles surface under bare names under OR — there
     * is no `mcp__server__` prefix, because `createSdkMcpServer` is a value bag
     * that passes `def.name` straight through.
     */
    it("tokenizes callboard's own bare-named tools", () => {
      expect(categorizeOpenRouterTool("find_chats")).toBe("fileRead");
      expect(categorizeOpenRouterTool("spawn_job")).toBe("codeExecution");
    });

    /**
     * The Claude map special-cases `mcp__callboard-tools__render_file` as
     * fileRead. Under OR the same tool arrives bare, and neither `render` nor
     * `file` is a token in any family — so without an exact entry it would be
     * gated as codeExecution while the Claude path called it a read.
     */
    it("keeps render_file at parity with the Claude map", () => {
      expect(categorizeOpenRouterTool("render_file")).toBe("fileRead");
    });

    /** The harness's MCP bridge names external server tools `<server>__<tool>`. */
    it("tokenizes bridge-named external tools across the __ separator", () => {
      expect(categorizeOpenRouterTool("mcp-proxy__secure_request")).toBe("webAccess");
      expect(categorizeOpenRouterTool("filesystem__read_file")).toBe("fileRead");
    });

    it("sends genuinely unknown names to the strictest gate", () => {
      expect(categorizeOpenRouterTool("frobnicate")).toBe("codeExecution");
      expect(categorizeOpenRouterTool("some_future_tool")).toBe("codeExecution");
    });
  });

  describe("ordering and prose rules", () => {
    /**
     * Rule 2: most restrictive wins. Resolving `search_and_run` to `fileRead`
     * would treat a run-capable tool as read-only — that is the widening, and
     * `fileRead` is the axis users most often set to "allow".
     */
    it("resolves a multi-family name to the most restrictive match", () => {
      expect(categorizeOpenRouterTool("search_and_run")).toBe("codeExecution");
      expect(categorizeOpenRouterTool("read_and_write")).toBe("fileWrite");
      expect(categorizeOpenRouterTool("fetch_and_list")).toBe("webAccess");
    });

    /** Rule 3: never read words out of a sentence to decide a gate. */
    it("refuses to tokenize prose", () => {
      expect(categorizeOpenRouterTool("Run `rm -rf` to clear the search index")).toBe(MOST_RESTRICTIVE_CATEGORY);
      expect(categorizeOpenRouterTool("read the file")).toBe(MOST_RESTRICTIVE_CATEGORY);
      expect(categorizeOpenRouterTool("")).toBe(MOST_RESTRICTIVE_CATEGORY);
    });

    it("recognizes real tool-name shapes as identifiers", () => {
      for (const name of ["read_file", "mcp-proxy__secure_request", "openrouter:web_search", "fs.read", "web-search"]) {
        expect(isOrToolIdentifier(name), name).toBe(true);
      }
      for (const name of ["read the file", "Run `x`", "", "a b"]) {
        expect(isOrToolIdentifier(name), name).toBe(false);
      }
    });

    it("handles camelCase and kebab-case names", () => {
      expect(categorizeOpenRouterTool("readFile")).toBe("fileRead");
      expect(categorizeOpenRouterTool("web-fetch")).toBe("webAccess");
    });
  });

  /**
   * End-to-end through the policy object `buildCanUseTool` actually holds —
   * the arrangement that shipped the bug.
   */
  describe("through ToolPermissionPolicy", () => {
    const askExec: DefaultPermissions = {
      fileRead: "allow",
      fileWrite: "allow",
      codeExecution: "ask",
      webAccess: "ask",
    };

    it("prompts for OR's bash instead of auto-allowing it", () => {
      const policy = new ToolPermissionPolicy(categorizeOpenRouterTool, () => askExec);
      expect(policy.decide("bash")).toEqual({ decision: "ask", category: "codeExecution" });
    });

    it("prompts for OR's web tools instead of auto-allowing them", () => {
      const policy = new ToolPermissionPolicy(categorizeOpenRouterTool, () => askExec);
      expect(policy.decide("web_search")).toEqual({ decision: "ask", category: "webAccess" });
      expect(policy.decide("web_fetch")).toEqual({ decision: "ask", category: "webAccess" });
    });

    /**
     * The unattended-run guarantee. Every unattended entry point (job steps,
     * deployed agents, `start_chat_session`) hardcodes all-four-"allow", and an
     * agent job step has no timeout — so any tool that resolves to "ask" under
     * this policy hangs the run until someone aborts it. No OR tool may.
     */
    it("reaches a definite allow for every tool under an all-allow policy", () => {
      const allowAll: DefaultPermissions = {
        fileRead: "allow",
        fileWrite: "allow",
        codeExecution: "allow",
        webAccess: "allow",
      };
      const policy = new ToolPermissionPolicy(categorizeOpenRouterTool, () => allowAll);
      const names = [...HARNESS_CLIENT_TOOLS, ...SERVER_TOOLS, "render_file", "spawn_job", "mcp-proxy__secure_request", "totally_unknown_tool"];
      for (const name of names) {
        expect(policy.decide(name).decision, `${name} would stall an unattended run`).toBe("allow");
      }
    });
  });
});
