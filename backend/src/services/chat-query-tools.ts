import { z } from "zod";
import type { AnyToolDefinition } from "../agents/ports/tools.js";
import { defineTool } from "../agents/ports/tools.js";
import { searchChats, searchChatsSchema, ChatQueryError } from "./chat-query.js";
import { chatViews, type ChatViewBinding } from "./chat-view.js";
export function buildChatQueryTools(binding?: ChatViewBinding): AnyToolDefinition[] {
  return [
    defineTool(
      "search_chats",
      "Search individual chats with stable global pagination, across every engine (claude-code, codex, cline, pi, acp). Read-only; ignored directories are always excluded. Per-parameter details are on the schema fields — what follows is only what a caller cannot see there.\n" +
        "SCOPING: `folder` is one exact working directory. `repo` expands to a repo's worktrees and is the one to use when you mean 'this project': a worktree path is normalised up to the main checkout (see appliedFilters.repoRoot). `repo` reaches a REMOVED worktree only when a workspace record names it, or its directory was a direct sibling of the repo named <repo-name><.|-|_>...; one that lived elsewhere (~/worktrees/foo) is not found, so an empty result is 'not found here', not 'never existed'. `repoSource` on each row says which rule admitted it — `sibling-path` is an inference from a path that no longer exists, `descendant` means the folder is inside the repo and includes ordinary subdirectories, not just worktrees.\n" +
        "SEARCH: `query` matches stored metadata; `grep` reads transcripts and needs another filter alongside it. `matchKind` on each hit is one of transcript (claude-code: raw log, tool calls and results included), messages (pi: conversational text only, no tool traffic), first-prompt (codex/cline/acp: opening message only), metadata (a codex native child, matched on its nickname), unknown. Grepping a file path or shell command therefore searches claude-code chats far more deeply than any other engine — absence of a pi/codex hit is not evidence.\n" +
        "COMPLETENESS: check `partial`, `total` (null when coverage is not exact) and `warnings` before reading an empty `chats` array as 'no matches'. Transcript search can exhaust its time, memory or per-file budget and still return 200 with zero rows; the warnings say so and `total` goes null.",
      searchChatsSchema,
      async (args) => {
        try {
          return { content: [{ type: "text" as const, text: JSON.stringify(await searchChats(args, binding)) }] };
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  code: error instanceof ChatQueryError ? error.code : error instanceof z.ZodError ? "INVALID_ARGUMENTS" : "CHAT_QUERY_FAILED",
                  error: String(error),
                }),
              },
            ],
          };
        }
      },
    ),
    defineTool(
      "get_chat_view",
      "Read the originating browser tab's live effective sidebar filters, submitted search, revision and freshness. Unavailable for old clients, automation or expired tabs; never falls back to another tab.",
      {},
      async () => ({
        content: [{ type: "text" as const, text: JSON.stringify(chatViews.read(binding)) }],
      }),
    ),
  ];
}
