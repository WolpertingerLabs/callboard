/**
 * The gate. Everything here is about one question: can a Cline tool call reach
 * the filesystem or the shell without callboard having decided it may?
 *
 * `ToolPolicy` defaults BOTH `enabled` and `autoApprove` to true, so the
 * failure mode is silent and total — a tool missing from the policy map is not
 * "gated wrongly", it is not gated at all, and nothing in the transcript says
 * so. These tests exist because that is invisible in review.
 */
import { describe, it, expect, vi } from "vitest";
import type { ToolApprovalRequest } from "@cline/sdk";
import type { DefaultPermissions } from "shared/types/index.js";
import {
  buildClineToolPolicies,
  buildRequestToolApproval,
  categorizeClineToolName,
  CLINE_GATED_TOOL_NAMES,
  isClineToolIdentifier,
  MOST_RESTRICTIVE_CATEGORY,
  SPAWN_AGENT_TOOL,
} from "./permissionAdapter.js";

const ALL_ALLOW: DefaultPermissions = { fileRead: "allow", fileWrite: "allow", codeExecution: "allow", webAccess: "allow" };

function approvalRequest(toolName: string, input: unknown = {}): ToolApprovalRequest {
  return {
    sessionId: "s1",
    agentId: "a1",
    conversationId: "c1",
    iteration: 1,
    toolCallId: "t1",
    toolName,
    input,
    policy: { enabled: true, autoApprove: false },
  };
}

describe("categorizeClineToolName", () => {
  it("maps every built-in tool to the axis that actually governs it", () => {
    expect(categorizeClineToolName("read_files")).toBe("fileRead");
    expect(categorizeClineToolName("search_codebase")).toBe("fileRead");
    expect(categorizeClineToolName("editor")).toBe("fileWrite");
    expect(categorizeClineToolName("apply_patch")).toBe("fileWrite");
    expect(categorizeClineToolName("run_commands")).toBe("codeExecution");
    expect(categorizeClineToolName("fetch_web_content")).toBe("webAccess");
  });

  /**
   * OpenRouter's same-named `skill` tool is `fileRead` because it only returns
   * a SKILL.md body. Cline's *invokes* the skill with arguments — its own
   * description advertises `skill: "commit", args: "-m ..."` — so copying the
   * OpenRouter mapping would gate a commit on the read axis.
   */
  it("treats `skills` as execution, not a disk read", () => {
    expect(categorizeClineToolName("skills")).toBe("codeExecution");
  });

  /** A subagent inherits run_commands, so delegating is at least as privileged. */
  it("gates subagent spawning at the execution axis", () => {
    expect(categorizeClineToolName(SPAWN_AGENT_TOOL)).toBe("codeExecution");
  });

  it("never returns null, so an unattended run cannot hang on a bookkeeping call", () => {
    for (const name of [...CLINE_GATED_TOOL_NAMES, "render_file", "spawn_job", "totally_unknown", ""]) {
      expect(categorizeClineToolName(name), `${name || "(empty)"} categorized to null (= "ask")`).not.toBeNull();
    }
  });

  it("sends anything it cannot identify to the strictest axis", () => {
    expect(categorizeClineToolName("totally_unknown")).toBe(MOST_RESTRICTIVE_CATEGORY);
    expect(categorizeClineToolName("")).toBe(MOST_RESTRICTIVE_CATEGORY);
  });

  /** Rule 3 of the two-pass ruling: prose is never parsed for a gate. */
  it("refuses to tokenize a sentence", () => {
    expect(isClineToolIdentifier("Run `rm -rf` to clear the search index")).toBe(false);
    expect(categorizeClineToolName("Run `rm -rf` to clear the search index")).toBe(MOST_RESTRICTIVE_CATEGORY);
  });

  /**
   * The ordering rule: a name matching several families resolves to the most
   * restrictive. Resolving this to `fileRead` would treat a run-capable tool as
   * read-only, which is the widening the order exists to prevent.
   */
  it("resolves an ambiguous name to the most restrictive matching family", () => {
    expect(categorizeClineToolName("search_and_run")).toBe("codeExecution");
  });
});

describe("buildClineToolPolicies", () => {
  /**
   * The load-bearing assertion. A name absent from this map keeps
   * `ToolPolicy`'s defaults — enabled AND auto-approved — so it executes
   * without `requestToolApproval` ever being called.
   */
  it("routes every built-in through the live gate", () => {
    const policies = buildClineToolPolicies();
    for (const name of CLINE_GATED_TOOL_NAMES) {
      expect(policies[name], `${name} has no policy entry — it would be auto-approved`).toEqual({ enabled: true, autoApprove: false });
    }
  });

  it("covers the ten tools the docs describe as nine, spawn_agent included", () => {
    // The published docs list nine and omit spawn_agent. Deriving the list from
    // the SDK's own constants is what closes that gap; this asserts the derived
    // set still contains the names the adapter reasons about by hand.
    for (const name of [
      "read_files",
      "search_codebase",
      "run_commands",
      "fetch_web_content",
      "apply_patch",
      "editor",
      "skills",
      "ask_question",
      "submit_and_exit",
      SPAWN_AGENT_TOOL,
    ]) {
      expect(CLINE_GATED_TOOL_NAMES, `${name} is not in the gated set`).toContain(name);
    }
  });

  it("gates callboard's own tools too", () => {
    const policies = buildClineToolPolicies(["set_chat_title", "spawn_job"]);
    expect(policies.set_chat_title).toEqual({ enabled: true, autoApprove: false });
    expect(policies.spawn_job).toEqual({ enabled: true, autoApprove: false });
  });

  /**
   * Policy is deliberately NOT encoded here. `toolPolicies` rides on
   * `StartSessionInput`, and `send()` has no such field — so anything baked in
   * is frozen for the life of the session, and a user who tightened a policy
   * mid-chat would not be asked until they started a new one.
   */
  it("encodes no allow/deny decision, whatever the axes say", () => {
    const policies = buildClineToolPolicies();
    for (const entry of Object.values(policies)) {
      expect(entry.autoApprove).toBe(false);
      expect(entry.enabled).toBe(true);
    }
  });
});

describe("buildRequestToolApproval", () => {
  const signal = new AbortController().signal;

  it("auto-allows when the axis says allow, without prompting", async () => {
    const canUseTool = vi.fn();
    const approve = buildRequestToolApproval({ getPermissions: () => ALL_ALLOW, canUseTool, signal });
    await expect(approve(approvalRequest("run_commands"))).resolves.toEqual({ approved: true });
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it("denies when the axis says deny, and tells the model why", async () => {
    const approve = buildRequestToolApproval({ getPermissions: () => ({ ...ALL_ALLOW, codeExecution: "deny" }), signal });
    const result = await approve(approvalRequest("run_commands"));
    expect(result.approved).toBe(false);
    expect(result.reason).toContain("codeExecution");
  });

  it("escalates to the user when the axis says ask", async () => {
    const canUseTool = vi.fn().mockResolvedValue({ behavior: "allow" });
    const approve = buildRequestToolApproval({ getPermissions: () => ({ ...ALL_ALLOW, fileWrite: "ask" }), canUseTool, signal });
    await expect(approve(approvalRequest("editor", { path: "/tmp/x" }))).resolves.toEqual({ approved: true });
    // Pass 2 must receive the SAME string pass 1 categorized, or the two can
    // disagree and pass 2 can auto-allow what pass 1 escalated.
    expect(canUseTool).toHaveBeenCalledWith("editor", { path: "/tmp/x" }, expect.objectContaining({ signal }));
  });

  it("carries the user's refusal back to the model", async () => {
    const canUseTool = vi.fn().mockResolvedValue({ behavior: "deny", message: "Not that file" });
    const approve = buildRequestToolApproval({ getPermissions: () => ({ ...ALL_ALLOW, fileWrite: "ask" }), canUseTool, signal });
    await expect(approve(approvalRequest("editor"))).resolves.toEqual({ approved: false, reason: "Not that file" });
  });

  // ── Fail-closed: every one of these must deny ──────────────────────

  it("denies an unrecognised tool under an all-allow policy", async () => {
    // The whole point of MOST_RESTRICTIVE_CATEGORY. An unknown tool lands on
    // codeExecution, so an all-allow policy allows it — but a policy that asks
    // about execution must ask about the unknown too.
    const canUseTool = vi.fn().mockResolvedValue({ behavior: "deny" });
    const approve = buildRequestToolApproval({ getPermissions: () => ({ ...ALL_ALLOW, codeExecution: "ask" }), canUseTool, signal });
    await expect(approve(approvalRequest("some_new_cline_tool"))).resolves.toMatchObject({ approved: false });
    expect(canUseTool).toHaveBeenCalledWith("some_new_cline_tool", {}, expect.anything());
  });

  it("denies when there is no policy at all", async () => {
    // No settings ⇒ every category resolves to "ask", and with no canUseTool
    // there is nobody to ask.
    const approve = buildRequestToolApproval({ getPermissions: () => null, signal });
    await expect(approve(approvalRequest("read_files"))).resolves.toMatchObject({ approved: false });
  });

  it("denies an ask decision when no approval channel exists", async () => {
    const approve = buildRequestToolApproval({ getPermissions: () => ({ ...ALL_ALLOW, codeExecution: "ask" }), signal });
    await expect(approve(approvalRequest("run_commands"))).resolves.toMatchObject({ approved: false });
  });

  it("denies rather than throwing when canUseTool blows up", async () => {
    const canUseTool = vi.fn().mockRejectedValue(new Error("SSE gone"));
    const approve = buildRequestToolApproval({ getPermissions: () => ({ ...ALL_ALLOW, codeExecution: "ask" }), canUseTool, signal });
    await expect(approve(approvalRequest("run_commands"))).resolves.toMatchObject({ approved: false });
  });

  it("denies a request with no tool name", async () => {
    const approve = buildRequestToolApproval({ getPermissions: () => ALL_ALLOW, signal });
    await expect(approve(approvalRequest(""))).resolves.toMatchObject({ approved: false });
  });

  it("denies once the run is aborted mid-prompt", async () => {
    const controller = new AbortController();
    const canUseTool = vi.fn().mockImplementation(async () => {
      controller.abort();
      return { behavior: "allow" };
    });
    const approve = buildRequestToolApproval({
      getPermissions: () => ({ ...ALL_ALLOW, codeExecution: "ask" }),
      canUseTool,
      signal: controller.signal,
    });
    await expect(approve(approvalRequest("run_commands"))).resolves.toMatchObject({ approved: false });
  });

  /**
   * Rule 1 of the two-pass ruling applied to *when* the policy is read. The
   * accessor is called per request, so a policy tightened mid-chat binds on the
   * very next tool call rather than after the session ends.
   */
  it("reads the policy at decision time, not at session start", async () => {
    let permissions: DefaultPermissions = ALL_ALLOW;
    const canUseTool = vi.fn().mockResolvedValue({ behavior: "deny" });
    const approve = buildRequestToolApproval({ getPermissions: () => permissions, canUseTool, signal });

    await expect(approve(approvalRequest("run_commands"))).resolves.toEqual({ approved: true });
    permissions = { ...ALL_ALLOW, codeExecution: "ask" };
    await expect(approve(approvalRequest("run_commands"))).resolves.toMatchObject({ approved: false });
  });
});
