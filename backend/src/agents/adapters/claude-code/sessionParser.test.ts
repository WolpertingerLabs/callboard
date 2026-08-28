/**
 * Unit tests for the Claude Code JSONL session parser — focused on
 * tool_result image extraction (Read on an image file), which interns the
 * base64 payload into the image store and attaches imageIds so the
 * frontend can render thumbnails instead of a stringified blob.
 */
import { describe, expect, it, vi } from "vitest";
import { parseMessages } from "./sessionParser.js";

vi.mock("../../../services/image-storage.js", () => ({
  storeBase64Image: vi.fn((data: string, mimeType: string) => `img-${mimeType.split("/")[1]}-${data.length}`),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toolResultLine(content: any, timestamp = "2026-01-01T10:00:00.000Z") {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-1", content }] },
    timestamp,
  };
}

describe("parseMessages — tool_result image extraction", () => {
  it("interns a base64 image block and attaches its id as imageIds", () => {
    const [msg] = parseMessages([toolResultLine([{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }])]);
    expect(msg).toMatchObject({
      type: "tool_result",
      toolUseId: "tu-1",
      content: "[Image: image/png]",
      imageIds: ["img-png-12"],
    });
  });

  it("keeps text blocks alongside image placeholders, in order", () => {
    const [msg] = parseMessages([
      toolResultLine([
        { type: "text", text: "before" },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "abcd" } },
        { type: "text", text: "after" },
      ]),
    ]);
    expect(msg.content).toBe("before\n[Image: image/jpeg]\nafter");
    expect(msg.imageIds).toEqual(["img-jpeg-4"]);
  });

  it("collects multiple images from one tool_result", () => {
    const [msg] = parseMessages([
      toolResultLine([
        { type: "image", source: { type: "base64", media_type: "image/png", data: "aa" } },
        { type: "image", source: { type: "base64", media_type: "image/webp", data: "bbbb" } },
      ]),
    ]);
    expect(msg.imageIds).toEqual(["img-png-2", "img-webp-4"]);
  });

  it("string tool_result content passes through with no imageIds", () => {
    const [msg] = parseMessages([toolResultLine("plain file contents")]);
    expect(msg).toMatchObject({ type: "tool_result", content: "plain file contents" });
    expect(msg.imageIds).toBeUndefined();
  });

  it("image blocks without base64 source fall back to JSON stringification", () => {
    const [msg] = parseMessages([toolResultLine([{ type: "image", source: { type: "url", url: "http://x/y.png" } }])]);
    expect(msg.content).toBe('{"type":"image","source":{"type":"url","url":"http://x/y.png"}}');
    expect(msg.imageIds).toBeUndefined();
  });
});

// ── CLI plumbing ────────────────────────────────────────────────────
//
// Interrupting a running turn (by sending a follow-up message, or by
// stopping) leaves records in the session log that are not conversation:
// the CLI's interruption marker, the `isMeta` "Continue from where you left
// off." nudge it injects on resume, and the model's canned reply to that
// nudge. All three used to render as ordinary chat bubbles, two of them
// attributed to the user.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function userLine(content: any, extra: Record<string, unknown> = {}) {
  return { type: "user", message: { role: "user", content }, timestamp: "2026-01-01T10:00:00.000Z", ...extra };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function assistantLine(content: any) {
  return { type: "assistant", message: { role: "assistant", content }, timestamp: "2026-01-01T10:00:01.000Z" };
}

describe("parseMessages — CLI plumbing is not conversation", () => {
  it("drops the isMeta resume nudge and the canned reply it draws out", () => {
    const parsed = parseMessages([
      userLine("real question"),
      userLine("Continue from where you left off.", { isMeta: true }),
      assistantLine([{ type: "text", text: "No response requested." }]),
      assistantLine([{ type: "text", text: "real answer" }]),
    ]);
    expect(parsed.map((m) => m.content)).toEqual(["real question", "real answer"]);
  });

  it("keeps a real continuation the nudge produced", () => {
    // Only the canned acknowledgment is plumbing — if the model actually got
    // back to work, that turn is the user's content and must survive.
    const parsed = parseMessages([
      userLine("Continue from where you left off.", { isMeta: true }),
      assistantLine([{ type: "text", text: "Picking up where I left off: ..." }]),
    ]);
    expect(parsed.map((m) => m.content)).toEqual(["Picking up where I left off: ..."]);
  });

  it("drops isMeta entries that are not the resume nudge", () => {
    // Slash-command argument blocks and skill preambles arrive the same way.
    const parsed = parseMessages([userLine("## Arguments\n\n`skip-install`", { isMeta: true }), assistantLine([{ type: "text", text: "ok" }])]);
    expect(parsed.map((m) => m.content)).toEqual(["ok"]);
  });

  it("only drops the canned reply when it directly follows a hidden nudge", () => {
    const parsed = parseMessages([userLine("hi"), assistantLine([{ type: "text", text: "No response requested." }])]);
    expect(parsed.map((m) => m.content)).toEqual(["hi", "No response requested."]);
  });

  it("survives the attachment / last-prompt entries the CLI writes between the nudge and the reply", () => {
    // Shaped as they actually appear on disk: bookkeeping keys only, with no
    // `message` and no `content`, which is why they carry no conversation.
    const parsed = parseMessages([
      userLine("Continue from where you left off.", { isMeta: true }),
      { type: "attachment", attachment: { type: "queued_command" }, entrypoint: "cli", timestamp: "2026-01-01T10:00:00.500Z" },
      { type: "last-prompt", lastPrompt: "…", leafUuid: "u-1", timestamp: "2026-01-01T10:00:00.600Z" },
      assistantLine([{ type: "text", text: "No response requested." }]),
    ]);
    expect(parsed).toEqual([]);
  });

  it("renders both interruption markers as system boundaries, not user messages", () => {
    for (const marker of ["[Request interrupted by user]", "[Request interrupted by user for tool use]"]) {
      const [msg] = parseMessages([userLine(marker)]);
      expect(msg).toMatchObject({ role: "system", type: "system", subtype: "interrupted", content: "Interrupted by user" });
    }
  });

  it("leaves assistant prose about interruptions alone", () => {
    const [msg] = parseMessages([assistantLine([{ type: "text", text: "That restart got interrupted by user activity, retrying." }])]);
    expect(msg).toMatchObject({ role: "assistant", type: "text" });
  });

  it("keeps a user message that merely quotes the marker", () => {
    // Exact-match only: a user asking about the marker is still a real message.
    const [msg] = parseMessages([userLine("why does it say [Request interrupted by user] here?")]);
    expect(msg).toMatchObject({ role: "user", type: "text" });
  });

  it("leaves an interrupted turn readable end to end", () => {
    // The shape a follow-up-mid-run actually produces.
    const parsed = parseMessages([
      userLine("MESSAGE ONE"),
      assistantLine([{ type: "text", text: "partial answer" }]),
      userLine("[Request interrupted by user]"),
      userLine("Continue from where you left off.", { isMeta: true }),
      assistantLine([{ type: "text", text: "No response requested." }]),
      userLine("MESSAGE TWO"),
    ]);
    expect(parsed.map((m) => [m.role, m.content])).toEqual([
      ["user", "MESSAGE ONE"],
      ["assistant", "partial answer"],
      ["system", "Interrupted by user"],
      ["user", "MESSAGE TWO"],
    ]);
  });
});

/**
 * Background-task completion notices. Every fixture below is a verbatim
 * record shape lifted from a real session log — the point of this suite is
 * that these shapes reach the UI at all, and they used to reach it as
 * nothing (attachments) or as raw XML in a user bubble (prompts).
 */
describe("parseMessages — background task notifications", () => {
  const SHELL_NOTICE =
    "<task-notification>\n<task-id>budijlgzl</task-id>\n<tool-use-id>toolu_01Ckwx</tool-use-id>\n" +
    "<output-file>/tmp/claude-1001/tasks/budijlgzl.output</output-file>\n<status>completed</status>\n" +
    '<summary>Background command "Full baseline run on pristine original" completed (exit code 0)</summary>\n</task-notification>';

  /** Shape 1: consumed mid-turn, as a queued-command attachment. */
  function attachmentLine(prompt: string, timestamp = "2026-01-01T10:00:00.000Z") {
    return {
      type: "attachment",
      attachment: { type: "queued_command", commandMode: "task-notification", prompt, timestamp },
      timestamp,
    };
  }

  /** Shape 2: flushed from the queue on resume, as a plain user prompt. */
  function noticeAsPrompt(content: string, timestamp = "2026-01-01T10:00:00.000Z") {
    return { type: "user", message: { role: "user", content }, timestamp };
  }

  it("surfaces a mid-turn attachment notice as a background_task marker", () => {
    const [msg] = parseMessages([attachmentLine(SHELL_NOTICE)]);
    expect(msg).toMatchObject({
      role: "system",
      type: "system",
      subtype: "background_task",
      backgroundTaskStatus: "completed",
      toolUseId: "toolu_01Ckwx",
      content: 'Background command "Full baseline run on pristine original" completed (exit code 0)',
    });
  });

  it("surfaces the same notice delivered as a prompt, instead of a user bubble of XML", () => {
    const [msg] = parseMessages([noticeAsPrompt(SHELL_NOTICE)]);
    expect(msg).toMatchObject({ role: "system", type: "system", subtype: "background_task" });
    expect(msg.content).not.toContain("<task-notification>");
  });

  it("renders a notice recorded in both shapes exactly once", () => {
    // The overlap is real: ~11 of 207 notices in the local corpus arrive as
    // an attachment AND as a prompt.
    const parsed = parseMessages([attachmentLine(SHELL_NOTICE), noticeAsPrompt(SHELL_NOTICE)]);
    expect(parsed.filter((m) => m.subtype === "background_task")).toHaveLength(1);
  });

  it("does not re-render the queue bookkeeping that mirrors each notice", () => {
    // enqueue/remove carry the same payload; rendering them would triple it.
    const parsed = parseMessages([
      { type: "queue-operation", operation: "enqueue", content: SHELL_NOTICE },
      attachmentLine(SHELL_NOTICE),
      { type: "queue-operation", operation: "remove", content: SHELL_NOTICE },
    ]);
    expect(parsed.filter((m) => m.subtype === "background_task")).toHaveLength(1);
  });

  it("carries the orphaned-task summary through, without its internal scan marker", () => {
    const orphan =
      "<task-notification>\n<task-id>bqg7u6zpk</task-id>\n<task-id>__orphan_summary__:shell</task-id>\n<status>stopped</status>\n" +
      "<summary>1 background shell command task(s) from the previous session have no completion record.</summary>\n</task-notification>";
    const [msg] = parseMessages([noticeAsPrompt(orphan)]);
    expect(msg).toMatchObject({ subtype: "background_task", backgroundTaskStatus: "stopped" });
    expect(msg.content).toBe("1 background shell command task(s) from the previous session have no completion record.");
    // Multi-task notice: not attributable to a single tool call.
    expect(msg.toolUseId).toBeUndefined();
  });

  it("synthesises a line when the notice carries no summary", () => {
    const bare = "<task-notification>\n<task-id>bwt15dfbo</task-id>\n<status>failed</status>\n</task-notification>";
    const [msg] = parseMessages([attachmentLine(bare)]);
    expect(msg).toMatchObject({ subtype: "background_task", content: "Background task bwt15dfbo failed" });
  });

  it("leaves other attachment kinds dropped, as before", () => {
    const parsed = parseMessages([
      { type: "attachment", attachment: { type: "task_reminder", content: "..." }, timestamp: "2026-01-01T10:00:00.000Z" },
      { type: "attachment", attachment: { type: "deferred_tools_delta", removedNames: ["a"] }, timestamp: "2026-01-01T10:00:00.000Z" },
    ]);
    expect(parsed).toEqual([]);
  });

  it("leaves a user message that merely mentions the tag alone", () => {
    const [msg] = parseMessages([noticeAsPrompt("why is <task-notification> not rendering?")]);
    expect(msg).toMatchObject({ role: "user", type: "text" });
  });
});

/**
 * Pairing the two ends of a background task.
 *
 * The launching `tool_result` and the completion marker are what the UI matches
 * to tell a background task that is still running from one that has finished.
 * Both ids come from the transcript's own fields; nothing here parses the
 * "Command running in background with ID: …" sentence, which the CLI writes for
 * the model rather than for us.
 */
describe("parseMessages — background task ids", () => {
  /** A backgrounded Bash result, shaped as the CLI records it. */
  function backgroundResultLine(taskId: string, toolUseId = "toolu_01Ckwx") {
    return {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            content: `Command running in background with ID: ${taskId}. Output is being written to: /tmp/claude-1001/tasks/${taskId}.output`,
          },
        ],
      },
      toolUseResult: { stdout: "", stderr: "", interrupted: false, isImage: false, backgroundTaskId: taskId },
      timestamp: "2026-01-01T10:00:00.000Z",
    };
  }

  it("tags the launching tool_result with the background task id", () => {
    const [msg] = parseMessages([backgroundResultLine("budijlgzl")]);
    expect(msg).toMatchObject({ type: "tool_result", toolUseId: "toolu_01Ckwx", backgroundTaskId: "budijlgzl" });
  });

  it("leaves an ordinary tool_result untagged", () => {
    // The absence is what the UI reads as "this call is simply done".
    const line = {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01Plain", content: "ok" }] },
      toolUseResult: { stdout: "ok", stderr: "", interrupted: false, isImage: false },
      timestamp: "2026-01-01T10:00:00.000Z",
    };
    const [msg] = parseMessages([line]);
    expect(msg.backgroundTaskId).toBeUndefined();
  });

  it("tags the completion marker with the same id, so the two pair up", () => {
    const notice =
      "<task-notification>\n<task-id>budijlgzl</task-id>\n<tool-use-id>toolu_01Ckwx</tool-use-id>\n" +
      "<status>completed</status>\n<summary>Background command completed (exit code 0)</summary>\n</task-notification>";
    const parsed = parseMessages([backgroundResultLine("budijlgzl"), { type: "queue-operation", operation: "enqueue", content: notice }]);

    const launch = parsed.find((m) => m.type === "tool_result");
    const marker = parsed.find((m) => m.subtype === "background_task");
    expect(launch?.backgroundTaskId).toBe("budijlgzl");
    expect(marker?.backgroundTaskId).toBe("budijlgzl");
  });

  it("does not attribute a multi-task summary to a single task, but still accounts for all of them", () => {
    // Two fields because there are two questions. Attribution must stay silent
    // — tagging the notice with whichever id came first would mark one task
    // finished on another's evidence. Settling must not: these tasks *are*
    // accounted for, and omitting them left every one of them rendering as
    // still running for the rest of the chat.
    const orphan =
      "<task-notification>\n<task-id>bqg7u6zpk</task-id>\n<task-id>bother1234</task-id>\n<task-id>__orphan_summary__:shell</task-id>\n<status>stopped</status>\n" +
      "<summary>2 background shell command task(s) from the previous session have no completion record.</summary>\n</task-notification>";
    const [msg] = parseMessages([{ type: "queue-operation", operation: "enqueue", content: orphan }]);
    expect(msg).toMatchObject({ subtype: "background_task" });
    expect(msg.backgroundTaskId).toBeUndefined();
    // The synthetic scan marker is not a task and must not be listed.
    expect(msg.backgroundTaskIds).toEqual(["bqg7u6zpk", "bother1234"]);
  });

  it("lists the single id on both fields for an ordinary notice", () => {
    const notice = "<task-notification>\n<task-id>budijlgzl</task-id>\n<status>completed</status>\n</task-notification>";
    const [msg] = parseMessages([{ type: "queue-operation", operation: "enqueue", content: notice }]);
    expect(msg.backgroundTaskId).toBe("budijlgzl");
    expect(msg.backgroundTaskIds).toEqual(["budijlgzl"]);
  });
});

describe("parseMessages — slash-command envelopes", () => {
  // Shaped as they appear on disk. Skills write message-first, harness
  // built-ins write name-first with the tags indented; both are real.
  const skill =
    "<command-message>callboard:begin-development</command-message>\n" +
    "<command-name>/callboard:begin-development</command-name>\n" +
    "<command-args>Active-first is all that is needed.</command-args>";
  const builtin = "<command-name>/login</command-name>\n            <command-message>login</command-message>\n            <command-args></command-args>";

  it("projects a skill invocation back to the line the user typed", () => {
    // This exact string is what the composer sent, and what the frontend's
    // optimistic bubble is matched against — see inFlightMessages.ts.
    const [msg] = parseMessages([userLine(skill)]);
    expect(msg).toMatchObject({
      role: "user",
      type: "text",
      content: "/callboard:begin-development Active-first is all that is needed.",
      isBuiltInCommand: true,
    });
  });

  it("drops the expanded body the CLI writes after the envelope", () => {
    // The skill's prompt text arrives as a separate isMeta entry. Rendering
    // both would show the command twice, once as prose nobody wrote.
    const parsed = parseMessages([
      userLine(skill),
      userLine([{ type: "text", text: "Base directory for this skill: /home/u/.callboard/…\n\nGo ahead and…" }], { isMeta: true }),
      assistantLine([{ type: "text", text: "On it." }]),
    ]);
    expect(parsed.map((m) => m.content)).toEqual(["/callboard:begin-development Active-first is all that is needed.", "On it."]);
  });

  it("omits the argument separator when the command took no arguments", () => {
    expect(parseMessages([userLine(builtin)])[0].content).toBe("/login");
  });

  it("reads the envelope out of a text block, not just a bare string", () => {
    expect(parseMessages([userLine([{ type: "text", text: skill }])])[0].content).toBe("/callboard:begin-development Active-first is all that is needed.");
  });

  it("supplies the leading slash when the envelope omits it", () => {
    expect(parseMessages([userLine("<command-name>review</command-name>")])[0].content).toBe("/review");
  });

  it("leaves prose that merely mentions the tags alone", () => {
    // Whole-content match only: a user asking about the markup is a real
    // message and must render as written.
    const prose = "why does <command-name>/foo</command-name> show up in my transcript?";
    const [msg] = parseMessages([userLine(prose)]);
    expect(msg.content).toBe(prose);
    expect(msg.isBuiltInCommand).toBeUndefined();
  });

  it("leaves an envelope with no command name alone", () => {
    const nameless = "<command-message>something</command-message>";
    expect(parseMessages([userLine(nameless)])[0].content).toBe(nameless);
  });

  it("rejects a near-envelope in linear time rather than backtracking on it", () => {
    // Many well-formed tag pairs followed by one character that cannot belong
    // to an envelope is the shape that makes an anchored `(...)+` pattern
    // explore every split. A user could type this; the parse runs on every
    // transcript read, on the event loop.
    const bomb = `${"<command-name>x</command-name>".repeat(400)}!`;
    const started = performance.now();
    const [msg] = parseMessages([userLine(bomb)]);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(msg.content).toBe(bomb);
  });

  it("does not project an assistant turn that echoes the envelope", () => {
    const [msg] = parseMessages([assistantLine([{ type: "text", text: skill }])]);
    expect(msg.content).toBe(skill);
  });
});
