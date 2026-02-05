import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbDir = join(__dirname, '..', 'data');
mkdirSync(dbDir, { recursive: true });

const db: InstanceType<typeof Database> = new Database(join(dbDir, 'claude-code-ui.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    folder TEXT NOT NULL,
    session_id TEXT,
    session_log_path TEXT,
    metadata TEXT DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);

// Sessions table removed - now stored in /data/sessions.json

db.exec(`
  CREATE TABLE IF NOT EXISTS message_queue (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    user_message TEXT NOT NULL,
    scheduled_time TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    retry_count INTEGER DEFAULT 0,
    error_message TEXT DEFAULT NULL,
    FOREIGN KEY (chat_id) REFERENCES chats (id) ON DELETE CASCADE
  )
`);

export default db;
