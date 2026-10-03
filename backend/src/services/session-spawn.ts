/**
 * Plumbing shared by every backend path that starts a session through
 * `sendMessage` on someone else's behalf — `start_chat_session` /
 * `continue_chat`, `talk_to_agent`, agent execution, job steps, completion
 * callbacks.
 */
import type { EventEmitter } from "events";
import type { DefaultPermissions } from "shared/types/index.js";

/** A single plain-text user turn, the shape `sendMessage` streams to the SDK. */
export interface UserPromptMessage {
  type: "user";
  message: { role: "user"; content: string };
}

/**
 * Wrap one text prompt as the async-iterable form `sendMessage` takes (required
 * when MCP servers are present).
 */
export function toPromptIterable(content: string): AsyncIterable<UserPromptMessage> {
  return (async function* () {
    yield { type: "user" as const, message: { role: "user" as const, content } };
  })();
}

/**
 * Permissions for a session no human is attending: every axis allowed except
 * computer control. A fresh object per call — it is stored on the chat record.
 */
export function unattendedPermissions(): DefaultPermissions {
  return { fileRead: "allow", fileWrite: "allow", codeExecution: "allow", webAccess: "allow", computerControl: "deny" };
}

export interface AwaitChatCreatedOptions {
  timeoutMs: number;
  /** Rejection message when no `chat_created` arrives within `timeoutMs`. */
  timeoutMessage: string;
  /** Rejection message for an `error` event that carries no `content`. */
  failMessage: string;
}

/**
 * Resolve with the chat id from the session's `chat_created` event; reject on an
 * `error` event or after `timeoutMs`.
 *
 * The listener is named and detached on all three exits. The emitter outlives
 * this promise by the whole length of the spawned run, so an anonymous handler
 * left attached would go on being called for every event of a session the
 * caller stopped caring about the moment it had the id — and one spawner that
 * starts many children accumulates one dead listener per child.
 */
export function awaitChatCreated(emitter: EventEmitter, { timeoutMs, timeoutMessage, failMessage }: AwaitChatCreatedOptions): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const onEvent = (event: { type?: string; chatId?: string; content?: string }) => {
      if (event.type === "chat_created" && event.chatId) {
        clearTimeout(timeout);
        emitter.off("event", onEvent);
        resolve(event.chatId);
      } else if (event.type === "error") {
        clearTimeout(timeout);
        emitter.off("event", onEvent);
        reject(new Error(event.content || failMessage));
      }
    };
    const timeout = setTimeout(() => {
      emitter.off("event", onEvent);
      reject(new Error(timeoutMessage));
    }, timeoutMs);
    emitter.on("event", onEvent);
  });
}
