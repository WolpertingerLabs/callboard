import { randomBytes, createHash } from "crypto";
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from "fs";
import { join } from "path";
import { DATA_DIR } from "../utils/paths.js";

const apiKeysFilePath = join(DATA_DIR, "api-keys.json");

/** Tokens look like `cbk_<40 hex chars>`. The prefix makes leaked keys greppable. */
const TOKEN_PREFIX = "cbk_";

export interface ApiKeyRecord {
  id: string;
  name: string;
  description: string;
  /** SHA-256 hex of the full token. The plaintext token is never stored. */
  tokenHash: string;
  /** First characters of the token (e.g. "cbk_a1b2c3") kept for display only. */
  tokenPreview: string;
  created_at: number;
  /** Epoch ms; null means the key never expires. */
  expires_at: number | null;
  last_used_at: number | null;
}

/** Shape returned to the UI — everything except the hash. */
export type ApiKeyInfo = Omit<ApiKeyRecord, "tokenHash">;

interface ApiKeysFile {
  keys: ApiKeyRecord[];
  metadata: {
    version: number;
  };
}

// Ensure data directory exists
mkdirSync(DATA_DIR, { recursive: true });

let keysCache: ApiKeysFile | null = null;
let lastModified = 0;

function loadKeys(): ApiKeysFile {
  if (!existsSync(apiKeysFilePath)) {
    const initialData: ApiKeysFile = { keys: [], metadata: { version: 1 } };
    saveKeys(initialData);
    return initialData;
  }

  const stats = statSync(apiKeysFilePath);
  const currentModified = stats.mtime.getTime();

  if (!keysCache || currentModified !== lastModified) {
    const data = readFileSync(apiKeysFilePath, "utf8");
    keysCache = JSON.parse(data);
    lastModified = currentModified;
  }

  return keysCache!;
}

function saveKeys(data: ApiKeysFile): void {
  writeFileSync(apiKeysFilePath, JSON.stringify(data, null, 2));
  keysCache = data;
  lastModified = Date.now();
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function toInfo(record: ApiKeyRecord): ApiKeyInfo {
  const { tokenHash: _tokenHash, ...info } = record;
  return info;
}

export function listApiKeys(): ApiKeyInfo[] {
  return loadKeys().keys.map(toInfo);
}

/**
 * Create a new API key. Returns the record plus the plaintext token —
 * the only time the token is ever available.
 */
export function createApiKey(name: string, description: string, expiresAt: number | null): { key: ApiKeyInfo; token: string } {
  const token = TOKEN_PREFIX + randomBytes(20).toString("hex");
  const record: ApiKeyRecord = {
    id: randomBytes(8).toString("hex"),
    name,
    description,
    tokenHash: hashToken(token),
    tokenPreview: token.slice(0, TOKEN_PREFIX.length + 6),
    created_at: Date.now(),
    expires_at: expiresAt,
    last_used_at: null,
  };

  const data = loadKeys();
  data.keys.push(record);
  saveKeys(data);

  return { key: toInfo(record), token };
}

export function deleteApiKey(id: string): boolean {
  const data = loadKeys();
  const index = data.keys.findIndex((k) => k.id === id);
  if (index === -1) return false;
  data.keys.splice(index, 1);
  saveKeys(data);
  return true;
}

// last_used_at is display metadata — throttle writes so a busy API client
// doesn't rewrite the file on every request.
const LAST_USED_WRITE_INTERVAL_MS = 60 * 1000;

/**
 * Verify a presented bearer token. Returns the matching key when the token
 * is valid and unexpired, otherwise null.
 */
export function verifyApiToken(token: string): ApiKeyInfo | null {
  if (!token.startsWith(TOKEN_PREFIX)) return null;

  const tokenHash = hashToken(token);
  const data = loadKeys();
  const record = data.keys.find((k) => k.tokenHash === tokenHash);
  if (!record) return null;

  const now = Date.now();
  if (record.expires_at !== null && now > record.expires_at) return null;

  if (!record.last_used_at || now - record.last_used_at > LAST_USED_WRITE_INTERVAL_MS) {
    record.last_used_at = now;
    saveKeys(data);
  }

  return toInfo(record);
}
