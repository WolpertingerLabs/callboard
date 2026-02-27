import { EventEmitter } from "events";
import { createLogger } from "../utils/logger.js";

const log = createLogger("session-registry");

export type SessionType = "web" | "cli";

export interface SessionInfo {
  chatId: string;
  type: SessionType;
  startedAt: number;
  /** Only set for web sessions */
  abortController?: AbortController;
  /** Only set for web sessions */
  emitter?: EventEmitter;
}

export interface SessionEvent {
  event: "session_started" | "session_stopped";
  chatId: string;
  type: SessionType;
}

/**
 * Centralized registry of all active chat sessions (both web and CLI).
 *
 * Extends EventEmitter to broadcast "change" events whenever a session
 * starts or stops, enabling real-time status updates across the app.
 */
class SessionRegistry extends EventEmitter {
  private sessions = new Map<string, SessionInfo>();

  /**
   * Register a new active session.
   * Emits a "change" event with { event: "session_started", chatId, type }.
   */
  register(chatId: string, info: Omit<SessionInfo, "chatId" | "startedAt">): void {
    const session: SessionInfo = {
      chatId,
      startedAt: Date.now(),
      ...info,
    };
    this.sessions.set(chatId, session);
    log.debug(`Session registered: chatId=${chatId}, type=${info.type}`);

    const event: SessionEvent = { event: "session_started", chatId, type: info.type };
    this.emit("change", event);
  }

  /**
   * Unregister a session (it has completed or been stopped).
   * Emits a "change" event with { event: "session_stopped", chatId, type }.
   * Returns true if a session was actually removed, false if it didn't exist.
   */
  unregister(chatId: string): boolean {
    const session = this.sessions.get(chatId);
    if (!session) return false;

    this.sessions.delete(chatId);
    log.debug(`Session unregistered: chatId=${chatId}, type=${session.type}`);

    const event: SessionEvent = { event: "session_stopped", chatId, type: session.type };
    this.emit("change", event);
    return true;
  }

  /**
   * Migrate a session from one tracking ID to another (e.g., temp ID → real session ID).
   * Emits stop for old ID and start for new ID.
   */
  migrate(oldId: string, newId: string): void {
    const session = this.sessions.get(oldId);
    if (!session) {
      log.warn(`migrate: no session found for oldId=${oldId}`);
      return;
    }

    this.sessions.delete(oldId);
    const oldType = session.type;

    const newSession: SessionInfo = { ...session, chatId: newId };
    this.sessions.set(newId, newSession);

    log.debug(`Session migrated: ${oldId} → ${newId}`);

    // Emit stop for old, start for new
    this.emit("change", { event: "session_stopped", chatId: oldId, type: oldType } as SessionEvent);
    this.emit("change", { event: "session_started", chatId: newId, type: newSession.type } as SessionEvent);
  }

  /**
   * Get session info for a specific chat ID.
   */
  get(chatId: string): SessionInfo | undefined {
    return this.sessions.get(chatId);
  }

  /**
   * Check if a session exists for the given chat ID.
   */
  has(chatId: string): boolean {
    return this.sessions.has(chatId);
  }

  /**
   * Get a snapshot of all active sessions.
   * Returns a plain object map of chatId → { type, startedAt }.
   */
  getAll(): Record<string, { type: SessionType; startedAt: number }> {
    const result: Record<string, { type: SessionType; startedAt: number }> = {};
    for (const [chatId, info] of this.sessions) {
      result[chatId] = { type: info.type, startedAt: info.startedAt };
    }
    return result;
  }

  /**
   * Get the number of active sessions.
   */
  get size(): number {
    return this.sessions.size;
  }
}

/** Singleton session registry instance */
export const sessionRegistry = new SessionRegistry();
