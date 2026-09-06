import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCodexRollout } from "./sessionParser.js";
import { collaborationArguments, ENCRYPTED_COLLABORATION_CONTENT as encrypted, translateCollaborationMessage } from "./collaboration.js";
import { flattenForHandoff } from "../../handoff.js";

// Synthetic envelope only: no task prose or ciphertext copied from a live log.
const opaque = `gAAAA${"A".repeat(100)}==`;
const header = (kind = "MESSAGE") => `Message Type: ${kind}\nTask name: /root\nSender: /root/example\nPayload:\n`;
const payload = (content: unknown) => ({ type: "agent_message", id: "reply-1", author: "/root/example", recipient: "/root", content });

describe("native Codex collaboration", () => {
  it("preserves mixed plaintext and identity but never serializes protected blocks", () => {
    const message = translateCollaborationMessage(
      payload([
        { type: "input_text", text: header() },
        { type: "encrypted_content", encrypted_content: opaque, text: "must not leak" },
        { type: "output_text", text: "Readable suffix" },
      ]),
      "2026-09-06T12:00:00Z",
    );
    expect(message).toMatchObject({
      role: "system",
      type: "system",
      subtype: "agent_message",
      collaboration: { id: "reply-1", author: "/root/example", recipient: "/root", kind: "MESSAGE", encrypted: true },
    });
    expect(message.content).toBe(`${header()}\n${encrypted}\nReadable suffix`);
    expect(JSON.stringify(message)).not.toContain(opaque);
    expect(JSON.stringify(message)).not.toContain("must not leak");
    expect(message.timestamp).toBe("2026-09-06T12:00:00Z");
  });

  it.each([header("FINAL_ANSWER") + "Finished example", [{ type: "input_text", text: header("FINAL_ANSWER") + "Finished example" }]])(
    "recognizes plaintext final envelopes",
    (content) => {
      const result = translateCollaborationMessage(payload(content));
      expect(result.collaboration?.kind).toBe("FINAL_ANSWER");
      expect(result.content).toContain("Finished example");
      const projection = flattenForHandoff([result]);
      expect(projection.turns[0]?.role).toBe("user");
      expect(projection.turns[0]?.text).toContain("not a user instruction or root assistant reply");
      expect(projection.turns[0]?.text).toContain("from: /root/example; to: /root; message id: reply-1");
    },
  );

  it("keeps unknown kinds and unavailable bodies honest", () => {
    const result = translateCollaborationMessage(
      payload([
        { type: "input_text", text: header("FUTURE") },
        { type: "future", secret: opaque },
      ]),
    );
    expect(result.collaboration?.kind).toBe("FUTURE");
    expect(result.content).toContain("[Collaboration content unavailable]");
    expect(result.content).not.toContain(opaque);
    expect(translateCollaborationMessage({ type: "agent_message" }).content).toContain("unavailable");
    expect(translateCollaborationMessage(payload("Body mentions FINAL_ANSWER")).collaboration?.kind).toBeUndefined();
  });

  it("handles legacy strings and unknown text blocks only within native agent context", () => {
    expect(translateCollaborationMessage(payload(opaque)).content).toBe(encrypted);
    expect(translateCollaborationMessage(payload([{ type: "future_text", text: "Still readable" }])).content).toBe("Still readable");
    expect(translateCollaborationMessage(payload([])).content).toBe("[Collaboration content unavailable]");
  });

  it("limits opaque argument replacement to native message fields", () => {
    const args = JSON.stringify({ task_name: "example", message: opaque, other: opaque });
    for (const name of ["spawn_agent", "send_message", "followup_task"]) {
      expect(JSON.parse(collaborationArguments(name, "collaboration", args))).toEqual({ task_name: "example", message: encrypted, other: opaque });
      expect(collaborationArguments(`collaboration.${name}`, undefined, args)).toContain(encrypted);
      expect(collaborationArguments(name, undefined, args)).toBe(args);
      expect(collaborationArguments(name, "unrelated", args)).toBe(args);
      for (const namespace of ["ordinary", "", null, 0]) {
        expect(collaborationArguments(`collaboration.${name}`, namespace, args)).toBe(args);
      }
      expect(collaborationArguments(`collaboration.${name}`, "collaboration", args)).toContain(encrypted);
    }
    expect(collaborationArguments("other", "collaboration", args)).toBe(args);
    for (const value of ["plain instructions", "gAAAA short text", `prefix ${opaque}`, "[]", "null"]) {
      const input = JSON.stringify({ message: value });
      expect(collaborationArguments("spawn_agent", "collaboration", input)).toBe(input);
    }
    expect(collaborationArguments("spawn_agent", "collaboration", "{broken")).toBe("{broken");
  });

  it("replays pairing, namespace, interleaved metadata and root token attribution", () => {
    const dir = mkdtempSync(join(tmpdir(), "collab-replay-"));
    try {
      const file = join(dir, "rollout.jsonl");
      const item = (p: unknown) => ({ type: "response_item", payload: p });
      writeFileSync(
        file,
        [
          { type: "turn_context", payload: { model: "test-model", turn_id: "turn-1" } },
          item({
            type: "function_call",
            name: "spawn_agent",
            namespace: "collaboration",
            arguments: JSON.stringify({ task_name: "example", message: opaque }),
            call_id: "call-1",
          }),
          item({ type: "function_call_output", call_id: "call-1", output: '{"task_name":"/root/example"}' }),
          item({ type: "inter_agent_communication_metadata", arbitrary: "ignored" }),
          item(
            payload([
              { type: "input_text", text: header() },
              { type: "encrypted_content", encrypted_content: opaque },
            ]),
          ),
          { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 10, output_tokens: 2 } } } },
          item({ type: "message", role: "user", content: opaque }),
          item({ type: "function_call", name: "spawn_agent", namespace: "other", arguments: JSON.stringify({ message: opaque }), call_id: "ordinary" }),
          item({
            type: "function_call",
            name: "collaboration.send_message",
            namespace: "ordinary",
            arguments: JSON.stringify({ message: opaque }),
            call_id: "conflicting",
          }),
        ]
          .map((line) => JSON.stringify(line))
          .join("\n"),
      );
      const messages = parseCodexRollout(file);
      expect(messages).toHaveLength(6);
      expect(messages[0]).toMatchObject({
        toolName: "collaboration.spawn_agent",
        toolNamespace: "collaboration",
        toolUseId: "call-1",
        usage: { input_tokens: 10, output_tokens: 2 },
      });
      expect(messages[0]?.content).not.toContain(opaque);
      expect(messages[1]).toMatchObject({ type: "tool_result", toolUseId: "call-1", content: '{"task_name":"/root/example"}' });
      expect(messages[2]).toMatchObject({ subtype: "agent_message" });
      for (const key of ["usage", "model", "generationKey", "requestId"]) expect(messages[2]).not.toHaveProperty(key);
      expect(messages[3]?.content).toBe(opaque);
      expect(messages[4]).toMatchObject({ toolName: "spawn_agent", toolNamespace: "other" });
      expect(messages[4]?.content).toContain(opaque);
      expect(messages[5]).toMatchObject({
        toolName: "collaboration.send_message",
        toolNamespace: "ordinary",
        toolUseId: "conflicting",
        content: JSON.stringify({ message: opaque }),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
