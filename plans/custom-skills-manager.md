# Custom Skills Manager & Chat Integration

Settings-managed, user-created skills that work in both the Claude Code and
OpenRouter chat paths, plus local (MCP) tools so agents can list/read/edit them
from inside a chat. Scope is **callboard-created skills only** — we never edit
or override skills that ship with frameworks, plugins, or the user's own
`~/.claude/skills` / `<project>/.claude/skills` directories.

## Core design: store skills as one synthetic Claude plugin

Both chat paths already know how to load skills from Claude-convention plugin
directories:

- **Claude Code path** — `claude.ts:buildPluginOptions()` (backend/src/services/claude.ts:107)
  passes `{ type: "local", path, name }` plugin entries to the Agent SDK
  (`plugins` option, claude.ts:886). The SDK discovers `skills/<name>/SKILL.md`
  inside each plugin and exposes them as `<plugin>:<skill>` via its Skill tool
  and slash-command surface.
- **OpenRouter path** — `loadOpenRouterPlugins()` (pluginAdapter.ts) runs the
  harness's `loadPlugins({ pluginDirs })`, and `buildSkillSupport()`
  (skillAdapter.ts:61) turns each plugin's `skillRoots` into the `skill` tool +
  `## Available Skills` listing. `buildCommandLoader()` (OpenRouterAdapter.ts:157)
  already folds the skill loader in, so skills are `/`-invocable too.

So: persist custom skills as a single on-disk plugin and **both paths consume
them with near-zero new rendering logic**.

### Storage layout

```
~/.callboard/custom-skills/            ← DATA_DIR-relative, like themes/
├── .claude-plugin/
│   └── plugin.json                    ← { "name": "callboard", "version": "1.0.0",
│                                          "description": "Custom skills created in Callboard" }
└── skills/
    └── <slug>/
        └── SKILL.md                   ← standard frontmatter (name, description,
                                          optional arguments) + markdown body
```

Skills are namespaced `callboard:<slug>`, which guarantees no collision with
user/project/plugin skills. The plugin dir is created lazily on first skill
creation (and `plugin.json` re-written if missing/corrupt).

## Backend

### 1. Service: `backend/src/services/custom-skills-service.ts`

Modeled on `theme-file-service.ts` (singleton, sanitized names, atomic writes):

- `listSkills(): CustomSkillListItem[]` — slug, name, description, updatedAt.
- `getSkill(slug): CustomSkill` — parsed frontmatter + raw markdown body.
- `createSkill({ name, description, content, arguments? })` — slugify name
  (kebab-case, length-capped), reject duplicates, write SKILL.md, ensure
  `plugin.json` exists.
- `updateSkill(slug, updates)` / `deleteSkill(slug)`.
- `getCustomSkillsPluginDir(): string | null` — returns the plugin path only
  when ≥1 skill exists (so empty installs add nothing to sessions).
- Frontmatter parse/serialize kept here so routes and MCP tools share one
  validator (description required — both SDK and harness rely on it for the
  listing; body size cap, e.g. 64KB).

### 2. Routes: `backend/src/routes/custom-skills.ts`

Follow `routes/themes.ts` exactly; mount at `/api/custom-skills` in
`backend/src/index.ts`:

- `GET /` list · `GET /:slug` read · `POST /` create · `PUT /:slug` update ·
  `DELETE /:slug` delete. Validation at the route boundary, service errors → 4xx.

### 3. Shared types: `shared/types/customSkill.ts`

`CustomSkill { slug, name, description, content, arguments?, updatedAt }` and
`CustomSkillListItem`; re-export from `shared/types/index.ts`.

### 4. Claude Code path wiring (one-line change)

In `buildPluginOptions()` (claude.ts:107): after app-wide plugins, append
`{ type: "local", path: getCustomSkillsPluginDir(), name: "callboard" }` when
the dir is non-null and the name isn't already taken. Since `sendMessage()`
rebuilds options per message, skills created/edited mid-chat apply on the
**next message** — no restart needed.

### 5. OpenRouter path wiring (one-line change)

Two options; prefer (a):

a. In `loadOpenRouterPlugins()` (pluginAdapter.ts), append the custom-skills
plugin dir to `pluginDirs` before calling `loadPlugins()`. Skills, listing,
`${CLAUDE_PLUGIN_ROOT}` substitution, and slash-command resolution all flow
through existing code (skillAdapter + commandAdapter) untouched.
b. (fallback if the harness loader is strict about manifests) Push a synthetic
`pluginRoots` entry in `buildSkillSupport()` (skillAdapter.ts:69).

Verify during implementation when `buildRun()` re-executes (it's lazy per
adapter instance) to confirm mid-chat freshness semantics; worst case, new
skills appear on the next session, same as plugin changes today.

### 6. Agent-facing local tools (callboard-tools)

Add to `buildCallboardToolsSpec()` (backend/src/services/callboard-tools.ts:141),
which is injected universally into **both** Claude and OpenRouter sessions:

- `list_custom_skills` — slugs + descriptions + updatedAt.
- `read_custom_skill { slug }` — full SKILL.md (frontmatter + body).
- `write_custom_skill { slug?, name, description, content }` — upsert; create
  when no slug, update when slug given. Same service-layer validation as the
  HTTP routes, so agents can't write malformed frontmatter.

Deliberately **no delete tool** — deletion stays in the settings UI (the user
asked for read/list/edit). Tool descriptions state the scope explicitly:
"manages Callboard custom skills only; does not touch ~/.claude or project
skills."

## Frontend

### 7. API client (`frontend/src/api.ts`)

`listCustomSkills` / `getCustomSkill` / `createCustomSkill` /
`updateCustomSkill` / `deleteCustomSkill`, following the agents/themes
fetch-wrapper pattern with `assertOk`.

### 8. Settings page: `frontend/src/pages/settings/SkillsSettings.tsx`

- Register a `skills` tab in `Settings.tsx` (tabs array + `validTabKeys` +
  content mapping), icon e.g. `Wand2`/`Sparkles`.
- **List view** — card per skill (name, description, updated time), Edit/Delete
  actions, "New skill" button. Reuse the section styling from `ApiSettings.tsx`
  and the optimistic-update + toast pattern from `GeneralSettings.tsx` themes.
- **Editor** — modal (DraftModal pattern) or inline expand (PluginsSettings
  pattern) with: name (slug preview shown), description (one line, required,
  explained as "what the model sees when deciding to use this skill"), and a
  monospace auto-growing textarea for the markdown body. Frontmatter is
  composed server-side from the structured fields, so users write only the
  body; an "advanced" toggle could expose raw frontmatter later.
- Delete confirms first (skills are user-authored content).

### 9. Chat discoverability

- Extend the existing slash-command listing the chat UI consumes
  (`getSlashCommandsAndPlugins()` → backend `slashCommands.ts`) to append
  `callboard:<slug>` entries sourced from the service. They then show up in
  `SlashCommandAutocomplete` for both providers; invocation already works on
  both paths (Claude CLI plugin commands surface; OR `commandLoader` includes
  the skill loader).
- No per-chat enable/disable in v1: all custom skills are active in all chats,
  matching how user-level skills behave in Claude Code.

## Testing

- Unit tests for the service (slugging, frontmatter round-trip, validation)
  next to `skillAdapter.test.ts` conventions.
- skillAdapter/pluginAdapter test: custom-skills dir present → skill appears in
  loader listing with `callboard:` namespace.
- Manual verify (dev server, background): create a skill in settings → invoke
  in a Claude Code chat and an OpenRouter chat → edit via `write_custom_skill`
  from inside a chat → confirm next message sees the edit.

## Out of scope (v1) / possible follow-ups

- Per-chat or per-skill enable/disable toggles.
- AI-assisted skill generation (themes' `POST /generate` pattern would port over).
- Editing/overriding framework, plugin, or user-directory skills — explicitly
  excluded by design.
- `context: fork` skills under OpenRouter (harness limitation noted in
  skillAdapter.ts header).

## Implementation order

1. Shared types + service + routes (testable via curl immediately).
2. Claude path plugin injection → verify `callboard:<slug>` appears in a session.
3. OpenRouter path pluginDirs injection → verify listing + invocation.
4. callboard-tools: list/read/write tools.
5. Settings UI + api.ts.
6. Slash-command autocomplete integration.
7. Tests + manual end-to-end pass.
