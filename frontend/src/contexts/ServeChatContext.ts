import { createContext, useContext } from "react";

/**
 * The chat a `/api/files/serve` URL is requested for. The server serves a
 * Sandbox desktop deliverable only to the chat it was delivered to, named as
 * `chat=`; every other path ignores it. Provided by the chat view.
 */
export const ServeChatContext = createContext<string | undefined>(undefined);
export const useServeChat = () => useContext(ServeChatContext);

/** `&chat=<id>` for a local `/api/files/serve` URL, or nothing outside a chat. */
export const serveChatParam = (chatId: string | undefined) => (chatId ? `&chat=${encodeURIComponent(chatId)}` : "");
