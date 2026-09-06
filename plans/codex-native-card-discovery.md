# Native card discovery (#416)

## Plan and implementation
- Read #416, current main `3f836fb`, #415's plan, and card/lineage/discovery consumers. No applicable AGENTS.md exists in this worktree or its ancestors.
- Share one request-scoped card context between board REST and MCP list/get/explicit metadata setters. Build lineage over stored records plus verified native metadata; only existing stored roots may anchor cards. Reuse that context for bulk targets and mutation responses, without adoption or repeated discovery.
- Retain explicit parent/fork precedence, mapped session-to-chat parents, nested native chains, stored/discovered deduplication and eligible stored-orphan behavior. Reject ambiguous mapped owners, duplicate rollout UUIDs, mismatched identity and filesystem-only orphan cards. Ignored discovery and retired-member exclusion remain in force; hidden cards remain directly addressable.
- Keep rollup projection pure over its inputs/dependencies. Inject response-budgeted lifecycle evidence only for returned members, not every discovered thread. Native unknown status remains unknown; active means recent child-local activity, never verified process liveness. Board drawer exposes evidence and parent-owned/read-only limitations.
- Explicit card edits redirect to a stored root. Native targets do not invoke the older stranded-member-card cleanup; non-native stored-member cleanup remains compatible. No metadata writes occur on reads or synthetic rows.

## Budgets and limitations
- One existing dated-directory iterator walk per card request, capped at 20,000 yielded entries. Metadata discovery shares the existing version-keyed parser cache, with a 16 MiB aggregate cold-read allocation budget (8 KiB first reads, up to 1 MiB fallback). Duplicate rollout IDs supply no inferred evidence.
- No discovery-result TTL: newly created/rewritten children are reconsidered on the next request without restart. Metadata cache invalidates on device/inode/ctime/mtime/size; budget exhaustion is not cached as absent evidence. Cold or very large corpora may be conservatively incomplete until later requests warm the cache; directory caps can omit older entries.
- One 8 MiB lifecycle budget per response, including metadata misses, with the existing 4 MiB per-rollout maximum. Direct get/patch replays only the selected card; bulk/list share a single response budget. Oversized/exhausted/stale evidence yields unknown, not completion. Metadata is cached; transient lifecycle is never persisted.
- No provider control, transport, ownership-release or adoption changes. Native inherited MCP remains root-bound as disclosed in #415; explicit card IDs are card metadata targets, not child-local control.

## Regression/review focus
Real REST handlers and real MCP tool handlers use scratch chat files and native rollouts (no native child records in the reproduction). Cover seven-versus-four membership, direct IDs, all explicit mutation surfaces, hidden cards, no read persistence, overlap, mapped/nested parents, explicit fork precedence, missing/mismatched/duplicate/ambiguous evidence, retired/ignored/triggered eligibility, cache freshness, unknown/recent/error evidence, aggregate metadata/lifecycle IO and one scan for bulk. Existing parser/provider/card suites and frontend folder/status checks protect compatibility.

Review especially conservative root anchoring and alias handling, shared context reuse, response-only evidence, storage boundaries, and cold-cache degradation. No independent reviews have yet been performed; root will coordinate them after PR delivery. No subagents, paid probes, live controls, workspace deletion/archive, restart/deploy, credentials changes or merge.

## Validation
Results recorded below after final clean rebase/validation.
