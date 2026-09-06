# Discovered session provider provenance (#409)

- Inspect discovery contracts and existing route/resume tests; preserve explicit metadata as authoritative.
- Carry resolver ownership into read-only lookup metadata and filesystem list/detail responses, including ACP vendor identity only when evidenced by discovery.
- Ensure transcript selection and first resume persistence use that metadata; retain legacy Claude defaults when no resolver evidence exists. Do not infer from IDs or change parentage/transcript parsing.
- Add stubbed/local regression coverage for Codex native children, other external providers, legacy records, missing/stale files, explicit routing, ACP identity, and read immutability.
- Install isolated dependencies, run focused and full tests with at most two workers, build, and lint. Rebase clean milestones and before delivery; commit and push only this branch.

## Implemented contract and choices
- Optional `acpProviderId?: string` on `DiscoveredSession` and `ResolvedSession`; ACP supplies the vendor from its existing transcript directory discovery. No Codex parser/provider changes.
- Shared metadata enrichment preserves explicit provider/vendor values; lookup limits resolution to an explicit owner and tolerates missing/stale resolver paths. Missing provider is inferred only from successful resolution (or list discovery), not ID shape.
- Reads only enrich response copies. Resume pins only the missing routing fields through the metadata merge API, preserving unrelated stored fields. Unknown ACP vendor remains unset, so execution cannot silently pick another vendor.
- Tests use a local native-child-shaped rollout plus scripted providers. No referenced live sessions or paid calls are used.

## Validation
- Isolated install: `NODE_ENV=development npm ci --ignore-scripts --include=dev`; lockfile unchanged.
- Installed Codex CLI and SDK both report 0.153.4; ACP SDK is 1.4.0.
- Focused lookup/list/resume/ACP tests: 70 passed before the final legacy-Claude control was added; the final full run includes that control.
- Final full run: `npx vitest run --maxWorkers=2` — 273 files passed, 3 skipped; 4,350 tests passed, 32 skipped. The first run exposed one old exact-metadata expectation in job-status rows; updated it for the intended provider field, then reran the full suite successfully.
- `npm run build` passes. Existing Swagger comment-parser and frontend chunk-size warnings remain.
- Changed-file ESLint passes; full lint passes with warnings only. No live model calls, server restarts, or transcript/parentage changes.

## Review follow-up plan
- Extend session resolution/parsing with optional ACP vendor routing; reject ambiguous vendor-less ACP IDs rather than selecting by mtime. Keep explicit vendors authoritative for lookup and transcripts.
- On primary-log miss, examine recorded session IDs; infer only unanimous provider/vendor evidence and reject conflicts. Keep list/detail/read/resume aligned without writing on reads.
- Route HTTP, read_session_messages, and job final-text extraction through the same metadata-authoritative transcript helper. Preserve unrelated tool context behavior.
- Add local duplicate-ACP, missing-primary/multi-session conflict, and real consumer regressions; repeat focused/full tests, build and lint; rebase and push this branch only.

### Review implementation contracts
- `SessionProvider.resolveSession(id, routing?)` and `parseSessionMessages(ids, routing?)` accept optional `SessionRouting { acpProviderId?: string }`. Non-ACP implementations need no changes. ACP filters by the explicit vendor and throws `SessionRoutingError` for duplicate vendor-less IDs; mtime never breaks ownership ties.
- Stored lookup uses historical `session_ids` only when the current log cannot resolve. Evidence must agree on kind and ACP vendor. Conflicts produce response-only `_provider_resolution_error`; HTTP reads return 409 and send rejects before persistence/execution. Unstored ambiguous ACP lookup returns not-found rather than inventing an owner.
- List routing reconciliation runs only for returned legacy/ACP rows (after filtering/pagination), avoiding full-history resolver work on over-fetched rows. Read-only metadata stays unpersisted.
- `readChatSessionMessages` consumes resolved chat routing; HTTP transcripts/handoff/title reads, MCP text reads and job final-text extraction no longer rediscover an owner independently. `readFinalAssistantText` is exported for direct regression testing of the production consumer.

### Review validation results
- Final focused route/consumer run: 75 tests passed (lookup/provider regressions, fork, title regeneration, job-status listing). Regressions execute the real HTTP handlers, MCP read handler, job final-text reader, and stubbed resume path.
- Final full run: `npx vitest run --maxWorkers=2` — 273 files passed / 3 skipped; 4,354 tests passed / 32 skipped. The first review full run exposed two outdated full-module mocks and a malformed-metadata list regression; fixed both, retained the existing regression test, and reran successfully.
- Final `npm run build` and `npm run lint:all` pass; lint reports 940 warnings / zero errors. Existing Swagger comment-parser and frontend chunk-size warnings remain. Changed-file lint also passes.
- No paid calls or live session interaction. Main rebases at clean milestones have been trivial. Duplicate vendor-less ACP identities intentionally remain unreadable/unresumable until an explicit vendor is supplied; no mtime-based ownership inference is retained.
