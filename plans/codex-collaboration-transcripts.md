# Codex collaboration transcripts (#411)

## Design
- Inspect durable rollout shapes and installed Codex SDK/CLI schemas without exposing private payloads. Represent native inter-agent messages explicitly, retaining author, recipient, message identity and message/final-result distinction.
- Preserve mixed plaintext and substitute an explicit encrypted/unavailable marker for protected content. Redact only recognized native collaboration message arguments; retain ordinary tool names/IDs and pair results unchanged.
- Render attribution in transcript UI and handoff/export paths; exclude subagent replies from root generation accounting. Do not touch session lineage/status/discovery.
- Support evidenced live stream shapes only; document any SDK transport/refresh gap.

## Validation
- Synthetic, non-private replay tests for encrypted/mixed/plaintext/final/unknown records, scoped argument handling, namespace identity, pairing and token attribution; frontend/handoff regression tests.
- Install worktree dependencies if needed; focused tests (max 2 workers), build, changed-file lint, full tests/lint where practical. Replay the referenced log read-only and report aggregate counts only.
- Rebase origin/main at clean milestones and before delivery; commit and push this branch only.

## Implemented decisions and evidence
- Use existing `role: system`, `type: system`, `subtype: agent_message` plus optional `collaboration` identity/kind metadata. This is context from another agent, not a new assistant generation, tool result or user instruction. No model/request/usage is attached. Unknown kinds remain unknown; only the CLI's leading plaintext `Message Type / Task name / Sender / Payload` envelope establishes MESSAGE versus FINAL_ANSWER.
- Retain plaintext envelope and all readable text blocks in order. Protected blocks become `[Encrypted collaboration content unavailable]`; unrecognized non-text blocks become `[Collaboration content unavailable]`. No decryption or metadata/body reconstruction. The Fernet-like string check is confined to native agent-message bodies and `message` on namespace-qualified collaboration spawn_agent/send_message/followup_task, not arbitrary tools/users/other argument fields. Bare unqualified tools remain untouched because their namespace cannot be established.
- Native collaboration calls display `collaboration.<name>` and retain `toolNamespace`; other tool names stay unchanged. Calls and outputs keep the original call_id. Summaries prioritize task_name/target. The dedicated bubble labels kind, author, recipient and message ID; it does not offer a root-answer fork affordance.
- Cross-engine handoff preserves replies as explicitly labelled inter-agent context on the only available context channel (user), not fabricated assistant answers. read_session_messages also includes attributed context. Native fork copying remains unchanged; parsed JSON responses retain structured attribution.
- Read-only audit of the referenced log on 2026-09-06 found both real mixed encrypted MESSAGE records and plaintext FINAL_ANSWER records with the same envelope. The growing log replay snapshot yielded **22 replies (19 encrypted), 3 final results, 3 spawn calls, 3 paired results, no model/usage on replies, and no ciphertext in spawn inputs**. Tests use synthetic IDs/task bodies/envelopes, never private task prose or source ciphertext. `inter_agent_communication_metadata` is not a body and is ignored rather than used to guess one.

## Live transport limitation
Installed `@openai/codex-sdk` package and bundled `codex-cli --version` both report **0.153.4**. `dist/index.d.ts` defines AgentMessageItem as `{id, type: "agent_message", text}` (root output). Its ThreadItem union contains AgentMessageItem, ReasoningItem, CommandExecutionItem, FileChangeItem, McpToolCallItem, WebSearchItem, TodoListItem and ErrorItem; **no native collaboration events**. The existing live root-message translation is therefore unchanged, not conflated with durable replies. Native collaboration appears when the durable rollout is parsed/refetched, including Chat.tsx's existing end-of-run getMessages refetch or reopening the chat. This does not introduce a new mid-turn transport/watch/poll mechanism; no promise of instantaneous inter-agent live updates is made.
