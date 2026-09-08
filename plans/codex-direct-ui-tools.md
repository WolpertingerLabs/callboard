# Codex direct UI tools

## Design

`render_file`, `create_canvas`, and `update_canvas` are the complete UI-producing
subset of `callboard-tools`. Canvas inspection/listing and ordinary tools stay
on the ordinary server. Codex gets two **filtered views of the same in-process
socket/handlers**, not duplicate handler implementations:

- `callboard-tools`: `disabled_tools` excludes the three UI tools.
- `callboard-ui`: `enabled_tools` contains exactly those three tools.
- Per-run SDK config unions `mcp__callboard_ui` into
  `features.code_mode.direct_only_tool_namespaces`.

The exact native selector is **`mcp__callboard_ui`**, not `callboard-ui` or
`mcp__callboard-ui`. Codex normalizes the hyphen for its native namespace. Ordinary
`functions.exec` remains available, and the three UI tools are absent from its
`ALL_TOOLS`. Nothing changes global `config.toml`, enables/disables code mode,
grants desktop permissions, or changes the execution transport.

The existing read-only `config/read` route probe also returns the effective user
namespace list and CLI version evidence. Enable the split only for the verified
native route and CLI 0.153.4+ (0.x), plus a fresh `directUiPolicy: "unconfigured"`
proof from that same effective config read. A namespace list alone cannot
authorize splitting. Preserve boolean code-mode shorthand as its
explicit `enabled` value when adding the nested setting. Unknown/older binaries,
unreadable/malformed config, and alternate provider routes retain the previous
unsplit behavior; they do not claim direct-rendering support. No new App Server
execution transport or additional probe is introduced.

`callboard-ui` and `callboard_ui` are reserved. External Callboard MCP entries
cannot overwrite them. Per-run atomic SDK `configOverrides` replace the reserved
alias table (avoiding stale user URL/env/command leaves) and disable its underscore
collision. The disabled entry includes an inert command because the native config
parser requires a transport even when disabled. Other user configuration remains
untouched. Socket lifetime, timeout, cancellation, and root-bound identity remain
owned by the original handle. No handler infers caller identity from request IDs.

## Policy-preserving fallback (root review P1)

The initial candidate incorrectly overwrote the original server's deny list and
exposed all three UI tools under the alias, escaping allowlists and server-disable
settings. The revised implementation deliberately does **not** attempt to copy or
reinterpret server policy. If effective `config/read` has **any** entry for
`callboard-tools`, `callboard_tools`, `callboard-ui`, or `callboard_ui`, the run
stays unsplit. This includes transport-only entries: the conservative tradeoff is
legacy rendering for explicitly configured first-party identities, rather than
silently broadening their policy. The original server's policy leaves are not
overridden, and both reserved UI aliases stay disabled.

The audit also covers server-default/per-tool approval settings
(`default_tools_approval_mode`, `tools.<tool>.approval_mode`), unknown/future fields
inside those server entries, plugin server-policy tables for affected identities,
and code-mode namespace exclusions. A nonempty or malformed exclusion list, or an
unknown shape in the inspected policy containers, likewise prevents splitting.
Unrelated external server policies do not prevent the normal no-policy split.
Global approval/sandbox policy and the legacy bridge transport/timeout behavior
are unchanged. No raw server/auth configuration is carried outside the probe.

`directUiPolicy.test.ts` runs the installed native CLI's **config/read**, not a
mock, before and after the actual adapter's SDK-equivalent flattened config plus
raw overrides. It needs no login, model call, or production server. The first
three regression cases retain these exact original-server policies:

| Original policy | Original after translation | UI alias after translation |
| --- | --- | --- |
| `disabled_tools=["render_file","set_chat_title"]` | Unchanged | Disabled |
| `enabled_tools=["read_canvas"]` | Unchanged | Disabled |
| `enabled=false` | Unchanged | Disabled |

Native cases also cover empty/combined allow/deny lists, default/per-tool approvals,
an unknown server field, trusted-project policy, and the policy-free positive
control (the split still works and preserves the user's code-mode namespace list).
Unit cases fail closed for malformed policy and plugin entries. The coordinating
root's original standalone config probe also now passes unchanged.

## Transcript and trust

No wire changes. Live SDK MCP events already supply real server/tool identity,
results, and per-run stable item IDs. History uses its own native `call_id` domain;
we never invent an equivalence between SDK item IDs and rollout call IDs.

The shared explicit registry recognizes historical Claude/Codex/pi spellings and
the new reserved alias. History canonicalizes genuine UI calls and removes the
captured two-block timing envelope **only after trusted call-ID pairing**. Mixed
ordering and duplicate delivery are covered; ambiguous IDs cannot authorize
unwrapping. Exec output is never inspected for nested UI JSON. Foreign namespaces
and lookalike suffixes stay generic. The frontend also validates the complete
media/canvas contract before using the existing renderers, including the existing
untrusted-media warning gate.

A separate real failure probe found that 0.153.4 drops MCP `isError` from durable
`response_item` output, even though SDK status is `failed`. The bridge therefore
prepends a diagnostic text block to failed first-party UI results. This retains
both the error and original content and prevents a success-shaped error payload
from becoming rich UI after refresh. This is transport normalization, not extra
handler execution. Arbitrary historical errors whose status the CLI already lost
cannot be reconstructed; existing handlers return plain error text, not UI data.

## Provenance and repeatable checks

Native CLI/SDK: **0.153.4**; model: **gpt-5.6-sol**; date: **2026-09-08**.
Official configuration reference:
<https://learn.chatgpt.com/docs/config-file/config-reference> (the selector's exact
MCP spelling is established by execution, not inferred from documentation).

```sh
umask 022
npm ci --ignore-scripts
npm run build
node --import tsx scripts/codex-direct-ui-smoke.ts
node --import tsx scripts/codex-direct-ui-browser-smoke.ts
npm test
npm run lint:all
```

The opt-in native smoke is billable and requires a local Codex subscription login.
It copies auth into a private temporary Codex home, uses an isolated Callboard data
directory, the actual options adapter/Unix-socket/stdio bridge, and the real three
UI handlers. The only synthetic handler is ordinary `echo`. It neither starts a
Callboard server nor contacts production. Test-only permission mode is
`danger-full-access`/`never` for the explicitly requested canvas writes; no desktop
tool is registered. Scratch/auth copies are removed on exit. The test creates an
image payload (example.com URL, not fetched), a real canvas snapshot, ordinary
exec echo, then resumes via SDK and creates canvas version 2. Each handler runs
exactly once. The existing user namespace is preserved and the transcript proves
UI tools are absent from exec. Only synthetic, sanitized tool records are retained.

`direct-ui-rollout.jsonl` and `direct-ui-sdk.json` are sanitized native captures:
no prompts/session metadata, auth, private paths, user artifacts, or screenshots.
Native generated canvas/call IDs are replaced with fixture IDs. The SDK fixture
retains its small per-run `item_N` IDs, which can repeat after resume.

The offline Chromium smoke passes that captured rollout through the real history
parser and `ToolCallBubble`/`MediaRenderer`/`CanvasRenderer`, loads a synthetic PNG
and both HTML snapshots from an ephemeral loopback server, verifies ordinary exec
stays generic, and repeats after browser reload. External requests are blocked.
It tests browser rendering without a desktop-access grant. It is an isolated
component integration, not a production-daemon end-to-end test.
