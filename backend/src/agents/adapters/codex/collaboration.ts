import type { ParsedMessage } from "shared/types/index.js";

export const ENCRYPTED_COLLABORATION_CONTENT = "[Encrypted collaboration content unavailable]";
const UNAVAILABLE_CONTENT = "[Collaboration content unavailable]";

/** Source-observed Fernet-like envelope, not a general secret/text filter. */
function isOpaqueMessage(value: unknown): value is string {
  return typeof value === "string" && /^gAAAA[A-Za-z0-9_-]{90,}={0,2}$/.test(value);
}

/** Only native collaboration tools' documented message argument is protected. */
export function collaborationArguments(name: string, namespace: unknown, content: string): string {
  const bare = name.startsWith("collaboration.") ? name.slice("collaboration.".length) : name;
  if (namespace !== "collaboration" && !name.startsWith("collaboration.")) return content;
  if (!["spawn_agent", "send_message", "followup_task"].includes(bare)) return content;
  try {
    const input: unknown = JSON.parse(content);
    if (!input || typeof input !== "object" || Array.isArray(input)) return content;
    const args = input as Record<string, unknown>;
    if (!isOpaqueMessage(args.message)) return content;
    return JSON.stringify({ ...args, message: ENCRYPTED_COLLABORATION_CONTENT });
  } catch {
    return content;
  }
}

/** Durable agent_message is NOT the SDK's root-assistant AgentMessageItem. */
export function translateCollaborationMessage(payload: Record<string, unknown>, timestamp?: string): ParsedMessage {
  const read = (key: string) => (typeof payload[key] === "string" ? (payload[key] as string) : undefined);
  const parts = Array.isArray(payload.content) ? payload.content : [payload.content];
  let encrypted = false;
  const readable = (text: string) => {
    if (!isOpaqueMessage(text)) return text;
    encrypted = true;
    return ENCRYPTED_COLLABORATION_CONTENT;
  };
  const content =
    parts
      .map((part: unknown) => {
        if (typeof part === "string") return readable(part);
        if (!part || typeof part !== "object") return UNAVAILABLE_CONTENT;
        const block = part as Record<string, unknown>;
        if (block.type === "encrypted_content") {
          encrypted = true;
          return ENCRYPTED_COLLABORATION_CONTENT;
        }
        if (typeof block.text === "string") return readable(block.text);
        return UNAVAILABLE_CONTENT;
      })
      .join("\n") || UNAVAILABLE_CONTENT;
  // The CLI's plaintext envelope carries the kind; do not infer finality from
  // body prose or opaque metadata. Keep the envelope itself losslessly visible.
  const kind = /^Message Type: ([^\r\n]+)\r?\nTask name: [^\r\n]*\r?\nSender: [^\r\n]*\r?\nPayload:\r?\n/.exec(content)?.[1];
  return {
    role: "system",
    type: "system",
    subtype: "agent_message",
    content,
    collaboration: { id: read("id"), author: read("author"), recipient: read("recipient"), kind, encrypted },
    ...(timestamp && { timestamp }),
  };
}
