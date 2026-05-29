/**
 * User contact info storage.
 *
 * Persists the user's contact channels (Discord, Telegram, phone, email),
 * each with a handle and an on/off toggle, to ~/.callboard/user-contact.json.
 * Used by the notify_user callboard tool to decide which channels the agent
 * may use to reach the user via drawlatch.
 *
 * The file holds PII, so it's written with 0600 permissions.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { ContactChannel, UserContactInfo } from "shared";
import { createLogger } from "../utils/logger.js";

const log = createLogger("user-contact");

const CONTACT_CONFIG_FILE = join(process.env.CALLBOARD_DATA_DIR || join(homedir(), ".callboard"), "user-contact.json");

const CHANNEL_KEYS: (keyof UserContactInfo)[] = ["discord", "telegram", "phone", "email"];

function emptyChannel(): ContactChannel {
  return { value: "", enabled: false };
}

function emptyContactInfo(): UserContactInfo {
  return {
    discord: emptyChannel(),
    telegram: emptyChannel(),
    phone: emptyChannel(),
    email: emptyChannel(),
  };
}

function coerceChannel(raw: unknown): ContactChannel {
  if (!raw || typeof raw !== "object") return emptyChannel();
  const r = raw as Record<string, unknown>;
  return {
    value: typeof r.value === "string" ? r.value.trim() : "",
    enabled: r.enabled === true,
  };
}

let _cache: UserContactInfo | null = null;

/** Read the user's contact info from disk, falling back to empty channels. */
export function getUserContact(): UserContactInfo {
  if (_cache) return _cache;
  const result = emptyContactInfo();
  try {
    if (existsSync(CONTACT_CONFIG_FILE)) {
      const parsed = JSON.parse(readFileSync(CONTACT_CONFIG_FILE, "utf8"));
      if (parsed && typeof parsed === "object") {
        for (const key of CHANNEL_KEYS) {
          result[key] = coerceChannel((parsed as Record<string, unknown>)[key]);
        }
      }
    }
  } catch {
    // Fall through to empty on any error
  }
  _cache = result;
  return result;
}

/** Persist the user's contact info, normalizing and refreshing the cache. */
export function saveUserContact(info: Partial<UserContactInfo>): UserContactInfo {
  const next = emptyContactInfo();
  for (const key of CHANNEL_KEYS) {
    next[key] = coerceChannel(info[key]);
  }

  const dataDir = process.env.CALLBOARD_DATA_DIR || join(homedir(), ".callboard");
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
  writeFileSync(CONTACT_CONFIG_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  _cache = next;
  log.info("Saved user contact info");
  return next;
}
