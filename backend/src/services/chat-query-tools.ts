import { z } from "zod";
import type { AnyToolDefinition } from "../agents/ports/tools.js";
import { defineTool } from "../agents/ports/tools.js";
import { searchChats, searchChatsSchema, ChatQueryError } from "./chat-query.js";
import { chatViews, type ChatViewBinding } from "./chat-view.js";
export function buildChatQueryTools(binding?: ChatViewBinding): AnyToolDefinition[] {
  return [
    defineTool(
      "search_chats",
      "Search individual chats with stable global pagination. scope defaults to all; visible requires the originating browser tab's live filters. anyOf ORs individual pinned/bookmarked state and eligible open-card membership. query searches metadata, not transcripts. Read-only; ignored directories excluded.",
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
