import { z } from "zod";
import type { AnyToolDefinition } from "../agents/ports/tools.js";
import { defineTool } from "../agents/ports/tools.js";
import { searchChats, searchChatsSchema, ChatQueryError } from "./chat-query.js";
import { chatViews, type ChatViewBinding } from "./chat-view.js";
export function buildChatQueryTools(binding?: ChatViewBinding): AnyToolDefinition[] {
  return [
    defineTool(
      "search_chats",
      "Search individual chats with stable global pagination, across every engine (claude-code, codex, cline, pi, acp). scope defaults to all; visible requires the originating browser tab's live filters. anyOf ORs individual pinned/bookmarked state and eligible open-card membership. " +
        "query searches metadata only; grep searches transcript content and is the expensive one — every other filter narrows the candidate set before it opens a file. " +
        "folder is an exact working directory; repo is a repo root that expands to its worktrees, including worktrees whose directory has since been removed (their chats are still recorded). Each row reports repoSource for how it was admitted. " +
        "branch matches the chat's recorded branch and, failing that, the directory's live branch; branchSource on each row says which, or `unknown`. A grep hit reports matchKind, because grep means different things per engine — claude-code and pi search the whole transcript, codex/cline/acp match the first prompt only, and a codex native child matches on its nickname. " +
        "Read-only; ignored directories are always excluded.",
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
