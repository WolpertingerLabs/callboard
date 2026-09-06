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
