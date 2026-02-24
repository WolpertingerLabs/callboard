# Plan: mcp-memory-server

An MCP server that gives Claude Code persistent, semantic memory -- the ability to store, search, and recall information across sessions using vector embeddings and hybrid search.

---

## Why This Matters

Claude Code has no memory. Every session starts from zero. The agent reads your codebase each time, re-learns your preferences, re-discovers your architecture decisions, and forgets what you told it yesterday. This is the single biggest friction point in daily use.

OpenClaw solved this with a full memory system: Voyage AI embeddings, SQLite-vec for vector search, hybrid retrieval (vector + BM25), and automatic indexing of both memory files and session transcripts. The result is an agent that remembers your name, your deployment process, the bug you fixed last Tuesday, and the fact that you prefer tabs over spaces.

Without memory:

- **Repeated context loading.** Every session, you re-explain project conventions, preferences, and recent decisions. This wastes time and tokens.
- **No institutional knowledge.** The agent can't build up understanding over time. Day 100 is the same as day 1.
- **Lost decisions.** "Why did we choose PostgreSQL over MySQL?" "What was the conclusion from last week's refactor discussion?" Gone.
- **No cross-session continuity.** "Continue what we were working on yesterday" requires you to manually reconstruct context.
- **No proactive recall.** The agent can't say "last time you worked on this file, you mentioned wanting to refactor the error handling." It has no "last time."

Memory transforms the agent from a stateless tool into a persistent collaborator. It's the difference between a contractor who shows up fresh every day and a teammate who's been on the project for months.

---

## Design Principles

1. **File-first memory.** Primary memory source is markdown files (MEMORY.md, memory/\*.md) that humans can read and edit. The database is an index, not the source of truth.
2. **Secure embeddings.** Embedding API keys live on the remote server via drawlatch. Memory content is encrypted in transit.
3. **Hybrid search.** Vector similarity alone misses exact terms. BM25 alone misses semantic relationships. Combine both.
4. **Lazy indexing.** Don't block the agent. Index in the background, serve slightly stale results rather than making the agent wait.
5. **Provider-agnostic.** Support Voyage AI, OpenAI, and local embeddings. Swap without re-architecting.
6. **MCP-native.** Standard MCP tools. Works with any Claude Code session, not just callboard.

---

## Architecture

```
┌─────────────┐  stdio   ┌──────────┐  E2EE   ┌─────────────────────────────────┐
│ Claude Code │◄────────►│ MCP      │◄───────►│       Memory Server (remote)    │
│             │ MCP tools│ Proxy    │         │                                 │
└─────────────┘          └──────────┘         │  ┌───────────┐  ┌───────────┐  │
                                              │  │ Embedding │  │ SQLite    │  │
      ┌──────────────┐                        │  │ Provider  │  │ + vec     │  │
      │ Memory Files │── file watcher ──────►│  │(Voyage/OAI)│  │ + fts5   │  │
      │ MEMORY.md    │                        │  └───────────┘  └───────────┘  │
      │ memory/*.md  │                        │                                 │
      └──────────────┘                        └─────────────────────────────────┘
```

**Key distinction from OpenClaw:** OpenClaw's memory runs in-process with the agent. Ours runs as a separate MCP server, which means:

- Memory persists independently of any Claude Code session
- Multiple sessions can share the same memory index
- The memory server can index files in the background even when no session is active

---

## MCP Tools Exposed

### `memory_search`

Semantic + keyword hybrid search across indexed memory.

```typescript
// Parameters:
{
  query: string,              // Natural language search query
  maxResults?: number,        // Default 8
  minScore?: number,          // Default 0.3 (0-1 scale)
  sources?: string[],         // Filter: ["memory", "sessions"] (default: all)
  path?: string               // Filter to specific file/directory
}

// Returns:
{
  results: [
    {
      path: "memory/2026-02-14.md",
      startLine: 12,
      endLine: 18,
      score: 0.87,
      snippet: "Decided to use PostgreSQL for the new auth service because...",
      source: "memory"
    }
  ],
  searchMode: "hybrid",       // "hybrid" | "vector" | "keyword"
  indexAge: "2m ago"          // How fresh the index is
}
```

### `memory_read`

Read a specific section of a memory file (after finding it via search).

```typescript
// Parameters:
{
  path: string,               // Relative path (e.g., "memory/2026-02-14.md")
  fromLine?: number,          // Start line (1-indexed)
  lines?: number              // Number of lines to read (default: 50)
}

// Returns:
{
  path: "memory/2026-02-14.md",
  content: "## Auth Service Decision\n\nWe chose PostgreSQL because...",
  fromLine: 12,
  toLine: 18,
  totalLines: 45
}
```

### `memory_store`

Write or append to a memory file. This is how the agent persists new knowledge.

```typescript
// Parameters:
{
  path?: string,              // File to write to (default: today's daily log)
  content: string,            // Markdown content to store
  mode: "append" | "replace", // Append to file or replace section
  heading?: string            // If mode=append, add under this heading
}

// Returns:
{
  path: "memory/2026-02-16.md",
  linesWritten: 8,
  indexed: true               // Whether the new content has been indexed
}
```

### `memory_status`

Check the health and stats of the memory index.

```typescript
// No parameters
// Returns:
{
  provider: "voyage",
  model: "voyage-3-large",
  totalChunks: 1847,
  totalFiles: 23,
  sources: {
    memory: { files: 20, chunks: 1200 },
    sessions: { files: 3, chunks: 647 }
  },
  lastSync: "2026-02-16T14:20:00Z",
  staleFiles: 0,
  dbSize: "12.4 MB"
}
```

### `memory_sync`

Force an immediate re-index of changed files.

```typescript
// Parameters:
{
  force?: boolean,            // Full re-index even if hashes match
  source?: "memory" | "sessions"
}

// Returns:
{
  filesScanned: 23,
  chunksUpdated: 14,
  chunksAdded: 3,
  chunksRemoved: 0,
  duration: "2.3s"
}
```

---

## Indexing Pipeline

### Chunking Strategy

Files are split into overlapping chunks for embedding:

```
┌─────────────────────────────────────────┐
│ MEMORY.md (full file)                   │
├─────────────────────────────────────────┤
│ Chunk 1: lines 1-25     (400 tokens)   │
│          ↕ overlap: 80 tokens           │
│ Chunk 2: lines 18-42    (400 tokens)   │
│          ↕ overlap: 80 tokens           │
│ Chunk 3: lines 35-60    (400 tokens)   │
└─────────────────────────────────────────┘
```

- **Chunk size:** 400 tokens (configurable)
- **Overlap:** 80 tokens (20% default)
- **Boundary-aware:** Prefer splitting on heading/paragraph boundaries
- **Heading propagation:** Each chunk includes the nearest parent heading for context

### Change Detection

```
File modified
    │
    ▼
Compare SHA-256 hash with stored hash
    │
    ├── Same → skip (already indexed)
    │
    └── Different → re-chunk → diff chunks by hash
                        │
                        ├── Unchanged chunks → keep embeddings
                        └── New/changed chunks → embed → store
```

This avoids re-embedding the entire file when only a few lines change.

### Embedding Providers

```typescript
interface EmbeddingProvider {
  id: string; // "voyage", "openai", "local"
  model: string; // "voyage-3-large", "text-embedding-3-small"
  dimensions: number; // 1024, 1536, etc.

  embedQuery(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}
```

| Provider  | Model                   | Dimensions | Cost            | Quality       |
| --------- | ----------------------- | ---------- | --------------- | ------------- |
| Voyage AI | voyage-3-large          | 1024       | $0.06/1M tokens | Best for code |
| OpenAI    | text-embedding-3-small  | 1536       | $0.02/1M tokens | Good general  |
| Local     | nomic-embed-text (GGUF) | 768        | Free            | Good enough   |

Default: Voyage AI (best quality for code-heavy memory). Falls back to OpenAI, then local.

---

## Storage Schema (SQLite + sqlite-vec + FTS5)

```sql
-- Metadata tracking
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Tracked files with change detection
CREATE TABLE files (
  path TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'memory',  -- 'memory' | 'sessions'
  hash TEXT NOT NULL,                      -- SHA-256 of file content
  mtime INTEGER NOT NULL,
  size INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Content chunks with embeddings
CREATE TABLE chunks (
  id TEXT PRIMARY KEY,                     -- deterministic hash-based ID
  path TEXT NOT NULL,
  source TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  hash TEXT NOT NULL,                      -- SHA-256 of chunk text
  heading TEXT,                            -- nearest parent heading
  model TEXT NOT NULL,                     -- embedding model used
  text TEXT NOT NULL,                      -- raw chunk text
  embedding BLOB NOT NULL,                 -- float32 array
  updated_at INTEGER NOT NULL,

  FOREIGN KEY (path) REFERENCES files(path) ON DELETE CASCADE
);

-- Vector similarity search (sqlite-vec extension)
CREATE VIRTUAL TABLE chunks_vec USING vec0(
  id TEXT PRIMARY KEY,
  embedding FLOAT[1024]                    -- matches provider dimensions
);

-- Full-text keyword search (FTS5)
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  text,
  id UNINDEXED,
  path UNINDEXED,
  source UNINDEXED,
  heading UNINDEXED,
  start_line UNINDEXED,
  end_line UNINDEXED
);

-- Embedding cache (avoid re-computing unchanged content)
CREATE TABLE embedding_cache (
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  hash TEXT NOT NULL,                      -- chunk content hash
  embedding BLOB NOT NULL,
  dims INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (provider, model, hash)
);

CREATE INDEX idx_chunks_path ON chunks(path);
CREATE INDEX idx_chunks_source ON chunks(source);
```

---

## Hybrid Search Algorithm

```
User query: "Why did we choose PostgreSQL?"
                │
    ┌───────────┴───────────┐
    ▼                       ▼
Vector Search           Keyword Search
(embed query →          (FTS5 BM25 on
 cosine similarity       tokenized query)
 via sqlite-vec)
    │                       │
    ▼                       ▼
Top 32 candidates       Top 32 candidates
with cosine scores      with BM25 ranks
    │                       │
    └───────────┬───────────┘
                ▼
         Reciprocal Rank Fusion
         ┌─────────────────────┐
         │ score = w_v * S_vec │
         │       + w_k * S_kw  │
         │                     │
         │ w_v = 0.7 (vector)  │
         │ w_k = 0.3 (keyword) │
         │                     │
         │ S_kw = 1/(1+rank)   │
         └─────────────────────┘
                │
                ▼
         Deduplicate by chunk ID
         Filter by minScore
         Return top maxResults
```

Why hybrid matters:

- **Vector alone** finds "database selection rationale" when you search "PostgreSQL decision" (semantic match), but misses exact function names or error codes.
- **Keyword alone** finds "PostgreSQL" mentions but misses "we chose the relational database because of ACID compliance" (no keyword overlap).
- **Hybrid** catches both.

---

## File Watching & Background Sync

The memory server watches for file changes using `chokidar`:

```typescript
const watcher = chokidar.watch(
  [path.join(workspaceDir, "MEMORY.md"), path.join(workspaceDir, "memory.md"), path.join(workspaceDir, "memory/"), ...extraPaths],
  {
    ignoreInitial: false, // Index existing files on startup
    awaitWriteFinish: {
      stabilityThreshold: 1500, // Wait for writes to settle
      pollInterval: 100,
    },
  },
);

watcher.on("change", (filePath) => {
  markDirty(filePath);
  debouncedSync(); // Sync after 2s of quiet
});

watcher.on("unlink", (filePath) => {
  removeFileChunks(filePath);
});
```

Sync is non-blocking: searches return current index state while background sync processes changes.

---

## Security Model

### Embedding API Keys

Embedding providers require API keys. These follow the same pattern as drawlatch:

```
Local (no secrets)                    Remote (has secrets)
─────────────────                     ────────────────────
MCP proxy knows:                      Memory server knows:
  - Remote server URL                   - VOYAGE_API_KEY
  - Its own Ed25519 keys                - OPENAI_API_KEY (fallback)
  - Session encryption keys             - Memory file contents
                                        - Embedding vectors
```

The memory index itself lives on the remote server. The MCP proxy only sees search results (snippets), never raw embeddings or the full index.

### Memory Content Security

- Memory files may contain sensitive information (credentials mentioned in context, private decisions, personal preferences).
- All MCP communication is E2E encrypted via the existing drawlatch crypto layer.
- Memory files are read from the local filesystem but indexed on the remote server. For fully local operation, the "local" embedding provider uses on-device models with no network calls.
- Session transcript indexing is opt-in (disabled by default).

### Access Control

- Only authenticated MCP sessions can query memory.
- Per-caller memory isolation: different callers (e.g., work laptop vs personal laptop) can have separate memory indices.
- Memory files are gitignored by default (added to `.gitignore` on first `memory_store` call).

---

## Configuration

### Memory Server Config (`memory.config.json`)

```json
{
  "workspace": "/home/user/projects/my-app",

  "sources": {
    "memory": {
      "enabled": true,
      "paths": ["MEMORY.md", "memory.md", "memory/"],
      "extraPaths": []
    },
    "sessions": {
      "enabled": false,
      "path": "~/.claude/projects/*/sessions/",
      "syncThreshold": {
        "deltaBytes": 100000,
        "deltaMessages": 50
      }
    }
  },

  "embedding": {
    "provider": "voyage",
    "model": "voyage-3-large",
    "fallback": "openai",
    "local": {
      "model": "nomic-embed-text-v1.5.Q8_0.gguf"
    },
    "batch": {
      "enabled": true,
      "maxTokens": 8000,
      "concurrency": 4
    }
  },

  "chunking": {
    "tokens": 400,
    "overlap": 80,
    "boundaryAware": true
  },

  "search": {
    "maxResults": 8,
    "minScore": 0.3,
    "hybrid": {
      "enabled": true,
      "vectorWeight": 0.7,
      "keywordWeight": 0.3,
      "candidateMultiplier": 4
    }
  },

  "sync": {
    "watchEnabled": true,
    "watchDebounceMs": 2000,
    "intervalMinutes": 0
  },

  "store": {
    "path": "memory.sqlite",
    "vectorExtensionPath": null,
    "cache": {
      "enabled": true,
      "maxEntries": 10000
    }
  },

  "secrets": {
    "VOYAGE_API_KEY": "${VOYAGE_API_KEY}",
    "OPENAI_API_KEY": "${OPENAI_API_KEY}"
  }
}
```

---

## Implementation Phases

### Phase 1: Core Index + Search (MVP)

**Goal:** Agent can search and read from MEMORY.md and memory/ files.

1. SQLite schema + sqlite-vec + FTS5 setup
2. File scanner and chunking pipeline (heading-aware, overlap)
3. Embedding provider abstraction (Voyage AI first)
4. Vector search (cosine similarity via sqlite-vec)
5. Keyword search (BM25 via FTS5)
6. Hybrid merge with reciprocal rank fusion
7. MCP tools: `memory_search`, `memory_read`, `memory_status`
8. MCP proxy integration (reuse drawlatch E2EE)
9. File change detection (hash-based skip)
10. Basic tests

**Estimated effort:** 2-3 weeks

### Phase 2: Write + Watch + Sync

**Goal:** Agent can write memories and the index stays current automatically.

1. `memory_store` tool (append/replace to markdown files)
2. `memory_sync` tool (manual re-index trigger)
3. File watcher (chokidar) for automatic background re-indexing
4. Debounced sync with dirty tracking
5. Embedding cache (avoid re-computing unchanged chunks)
6. OpenAI embedding provider (fallback)
7. Provider fallback logic (Voyage → OpenAI on error)

**Estimated effort:** 1-2 weeks

### Phase 3: Session Indexing + Local Embeddings

**Goal:** Index past session transcripts and support fully offline operation.

1. Session transcript parser (JSONL → text chunks)
2. Session source indexing with separate sync thresholds
3. Local embedding provider (GGUF model via node-llama-cpp)
4. Re-index logic when provider/model changes
5. Atomic re-index with rollback (temp DB → swap)
6. Embedding cache LRU eviction

**Estimated effort:** 2 weeks

### Phase 4: Integration + Polish

**Goal:** Production-ready with callboard integration.

1. callboard memory panel (search UI, memory file browser)
2. Auto-gitignore for memory/ directory
3. Per-workspace memory isolation
4. Cross-workspace memory linking (optional shared index)
5. Memory usage analytics (total chunks, index freshness, search latency)
6. Connection template for drawlatch
7. Documentation, examples, deployment guide
8. Performance benchmarks (search latency, indexing throughput)

**Estimated effort:** 2 weeks

---

## Integration with Existing Stack

### With drawlatch

The memory server runs as a separate process alongside the API proxy:

```
drawlatch remote  (port 9999)  ← API proxy
mcp-memory-server remote (port 9997)  ← Memory index
mcp-channel-bridge remote (port 9998) ← Channel bridge (if deployed)
```

Same keypair infrastructure, same handshake, same caller authorization.

### With callboard

The UI can show:

- Memory search results inline in chat (when agent uses `memory_search`)
- A dedicated memory browser panel (browse/edit memory files)
- Index status indicator (stale, syncing, current)
- "Remember this" button that calls `memory_store` with selected chat content

### With callboard slash commands

A `/remember` slash command that:

1. Takes a natural language note
2. Calls `memory_store` to append to today's daily log
3. Confirms what was stored

A `/recall` slash command that:

1. Takes a search query
2. Calls `memory_search`
3. Displays results in a formatted panel

---

## What This Doesn't Do (And Why)

| Intentionally excluded | Reason                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| Memory expiry/TTL      | Memory files are human-managed markdown; users delete what they don't need                  |
| Importance scoring     | Adds complexity without clear value; hybrid search relevance is sufficient                  |
| Auto-summarization     | Risks lossy compression of facts; raw storage is safer                                      |
| Cross-agent memory     | Each workspace gets its own index; sharing is a future concern                              |
| Graph memory           | Embeddings + keyword search cover the retrieval need without a knowledge graph's complexity |

---

## Dependencies

| Dependency                   | Purpose                     | Why                                            |
| ---------------------------- | --------------------------- | ---------------------------------------------- |
| `better-sqlite3`             | Database engine             | Fast, embedded, no external DB needed          |
| `sqlite-vec`                 | Vector similarity search    | Native SQLite extension, no external vector DB |
| `chokidar`                   | File watching               | Reliable cross-platform file watcher           |
| `@modelcontextprotocol/sdk`  | MCP server implementation   | Standard MCP tooling                           |
| `tiktoken` / `gpt-tokenizer` | Token counting for chunking | Accurate chunk sizing                          |
| drawlatch shared crypto      | E2EE channel                | Reuse existing infrastructure                  |

Embedding provider SDKs (HTTP calls, no heavy deps):

- Voyage AI: raw `fetch` to `api.voyageai.com`
- OpenAI: raw `fetch` to `api.openai.com`
- Local: `node-llama-cpp` (optional, only if local provider enabled)

---

## Success Criteria

- [ ] `memory_search` returns relevant results in < 200ms for a 10k-chunk index
- [ ] Hybrid search outperforms vector-only on exact-term queries (measurable in test suite)
- [ ] File changes are reflected in search results within 5 seconds
- [ ] Embedding API keys never appear in MCP proxy logs or Claude's context
- [ ] Re-indexing after a provider change completes without data loss (atomic swap)
- [ ] A fresh Claude Code session can recall information stored in a previous session
- [ ] Local embedding provider works fully offline with acceptable quality
- [ ] Index size stays under 50MB for a typical project with 6 months of daily memory logs
