# Agent System Message Preview

Let the user see the full system message that gets appended for an agent on every
session kickoff (manual chat, cron, trigger, event, tool-spawned), with an
estimated token count, an overview list of all included files/sections, and
expandable content for each section and for the full assembled prompt.

## Background — how the system message is built today

The appended system prompt is composed from two compiler functions in
`backend/src/services/claude-compiler.ts`:

- `compileIdentityPrompt(config)` — Agent Identity, Your Human, Guidelines,
  Custom Instructions sections from `agent.json`.
- `compileWorkspaceContext(workspacePath)` — pre-loads workspace files
  `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `MEMORY.md`, plus daily
  memory journals `memory/<today>.md` and `memory/<yesterday>.md` (empty/missing
  files are skipped), joined with `---` separators under a
  "Pre-loaded Workspace Files" header.

The two parts are joined with `\n\n` identically in **three call sites**:

| Call site                                                              | Used for                            |
| ---------------------------------------------------------------------- | ----------------------------------- |
| `backend/src/services/agent-executor.ts:93-96`                         | cron, event, trigger, tool sessions |
| `backend/src/services/agent-tools.ts:112-115`                          | `start_chat_session` agent tool     |
| `backend/src/routes/agents.ts:125-128` (`GET /:alias/identity-prompt`) | manual chat kickoff from the UI     |

At runtime, `claude.ts:889` passes this as
`systemPrompt: { type: "preset", preset: "claude_code", append: ... }` — i.e. it
is **appended to the Claude Code preset system prompt**, which we cannot
measure. When proxy mode is on, `claude.ts:962-978` additionally appends a
proxy-connections listing at session start. Both caveats must be disclosed in
the UI rather than silently omitted.

There is no existing token estimator anywhere in the repo → use
`Math.round(chars / 4)`.

## Backend changes

### 1. Single source of truth in `claude-compiler.ts`

Add a structured compiler that the existing string-based compilers (and all
three call sites) are refactored on top of, so the preview is guaranteed
byte-identical to what sessions actually receive:

```ts
export interface SystemPromptSection {
  key: string; // "identity" | "SOUL.md" | ... | "memory/2026-06-11.md"
  label: string; // "Agent Identity", "Soul & Personality", ...
  source: "agent.json" | "workspace" | "memory-journal";
  content: string; // the section's contribution, exactly as embedded
  chars: number;
  estTokens: number; // Math.round(chars / 4)
  included: boolean; // false for empty/missing workspace files (still listed)
}

export interface CompiledSystemPrompt {
  prompt: string; // full assembled string (identity + workspace context)
  sections: SystemPromptSection[];
  totalChars: number; // prompt.length — measured on the joined string,
  totalEstTokens: number; // NOT the sum of sections (separators/headers count)
}

export function compileSystemPrompt(config: AgentConfig, workspacePath: string): CompiledSystemPrompt;
```

Implementation notes:

- `compileIdentityPrompt` and `compileWorkspaceContext` keep their exact output
  (no behavior change for sessions); either reimplement them as
  `compileSystemPrompt(...).prompt` slices or have `compileSystemPrompt` call
  them internally while also collecting per-file contents. Simplest safe
  approach: keep the two existing functions untouched, and have
  `compileSystemPrompt` reuse `readWorkspaceFile`/the same core-file and
  journal-date logic to build `sections`, then set
  `prompt = [compileIdentityPrompt(config), compileWorkspaceContext(workspacePath)].filter(Boolean).join("\n\n")`.
  A unit test asserts the section contents are each substrings of `prompt`
  and that the journal-date logic matches.
- Missing/empty workspace files appear in `sections` with `included: false`
  and `chars: 0` so the UI can show _why_ something isn't in the prompt.
- Put `SystemPromptSection` / shared response types in `shared/types/agent.ts`
  so frontend and backend share them.

### 2. New route in `backend/src/routes/agents.ts`

```
GET /api/agents/:alias/system-message-preview
```

Returns:

```json
{
  "sections": [ ...SystemPromptSection ],
  "fullPrompt": "...",
  "totalChars": 48210,
  "totalEstTokens": 12053,
  "notes": {
    "basePrompt": "Appended to the Claude Code preset system prompt (size not included).",
    "runtimeAdditions": "Proxy-connection listings may be appended at session start when proxy mode is enabled."
  }
}
```

Keep `GET /:alias/identity-prompt` as-is (chat kickoff depends on it), but
reimplement its body as `compileSystemPrompt(...).prompt` so it can never
drift from the preview. Refactor `agent-executor.ts` and `agent-tools.ts` to
use `compileSystemPrompt` too.

### 3. Unit test

`backend/src/services/claude-compiler.test.ts`:

- sections' `content` each appear verbatim in `prompt`
- `totalChars === prompt.length`, `totalEstTokens === Math.round(totalChars / 4)`
- empty workspace file → listed with `included: false`, absent from `prompt`
- journal files for today/yesterday picked up when present

## Frontend changes

### Placement: inside the Memory tab (`frontend/src/pages/agents/dashboard/Memory.tsx`)

Per the request ("close to or with the memory page"), add a **System Message**
entry to the Memory page rather than a new dashboard tab. The Memory page is
already a sidebar + content layout:

- **Sidebar:** new section _above_ "Workspace Files" titled **System Message**,
  containing one selectable row (icon: `ScrollText` or `FileCode`) with the
  total estimate as a badge, e.g. `~12.1k tokens`. Selecting it sets a
  `showSystemMessage` view state (mutually exclusive with file/daily views,
  same pattern as `showDaily`).
- **Content area** when selected, a new component
  `frontend/src/pages/agents/dashboard/SystemMessagePreview.tsx` (keep
  Memory.tsx from growing further):
  1. **Summary header** — "Sent with every session this agent starts — manual
     chats, cron jobs, triggers, and events." Big stat row: total est. tokens
     (`~12.1k`), total characters, N of M sections included.
  2. **Caveat line** (muted, small): appended to the Claude Code base prompt
     (not counted); proxy-connection info may be added at runtime.
  3. **Section list** — one row per section: label + filename, per-section
     `~X tokens` badge, and a chevron to expand/collapse that section's exact
     content in a read-only monospace block (reuse the daily-journal
     `pre-wrap` styling). Sections with `included: false` render greyed with
     an "empty — not included" note instead of a chevron.
  4. **Full system message** — a final expand/collapse row ("View full
     assembled system message") revealing `fullPrompt` in one monospace block,
     with a copy-to-clipboard button.

All styling via existing CSS variables (`var(--surface)`, `var(--border)`,
`var(--text-muted)`, `var(--accent)`, badge tints) — no hardcoded colors.

### Data flow

- `frontend/src/api.ts`: add
  `getAgentSystemMessagePreview(alias): Promise<SystemMessagePreview>` next to
  `getAgentIdentityPrompt` (~line 520).
- Memory.tsx fetches the preview alongside the initial
  `getWorkspaceFiles`/`getAgentMemory` load (so the sidebar badge has the
  total), and **refetches after a successful `updateWorkspaceFile` save** so
  the token counts reflect edits immediately.
- Token formatting helper: `< 1000` → `~840 tokens`; otherwise `~12.1k tokens`.

## Edge cases

- **Journal date boundary:** today/yesterday is computed server-side at
  request time — same code path as session start, so the preview matches what
  a cron firing "now" would get. A cron firing after midnight will differ;
  acceptable and implied by "estimated".
- **No workspace yet / brand-new agent:** sections list shows scaffold files
  with whatever content scaffolding created; identity section may be the only
  included one. Empty state must not crash (sections always returned).
- **Separators count:** totals come from the assembled string, not the sum of
  section chars — the UI may show that section tokens don't sum exactly to the
  total; that's correct, don't "fix" it.

## Build order

1. `shared/types/agent.ts`: add `SystemPromptSection`, `SystemMessagePreview`.
2. `claude-compiler.ts`: add `compileSystemPrompt` + tests.
3. Refactor the three call sites onto it (no output change — verify via test).
4. `routes/agents.ts`: add the preview route.
5. `api.ts` fetcher.
6. `SystemMessagePreview.tsx` + Memory.tsx sidebar integration.
7. Verify against the dev server (`npm install --include=dev`, run dev server
   in background): check totals against `wc -c` of the workspace files for a
   real agent, expand/collapse, light + dark themes, mobile layout.
