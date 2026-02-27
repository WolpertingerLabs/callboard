import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useParams, useNavigate, useSearchParams, useLocation } from "react-router-dom";
import {
  RotateCw,
  CheckSquare,
  Square,
  Slash,
  ArrowLeft,
  ArrowDown,
  MessageSquare,
  GitBranch,
  GitFork,
  ChevronUp,
  ChevronDown,
  MoreHorizontal,
} from "lucide-react";
import { useIsMobile } from "../hooks/useIsMobile";
import {
  getChat,
  getMessages,
  getPending,
  respondToChat,
  uploadImages,
  getSlashCommandsAndPlugins,
  getNewChatInfo,
  type Chat as ChatType,
  type ParsedMessage,
  type Plugin,
  type NewChatInfo,
  type DefaultPermissions,
  type BranchConfig,
  type AppPluginsData,
} from "../api";
import { useIsSessionActive } from "../contexts/SessionContext";
import MessageBubble, { TEAM_COLORS } from "../components/MessageBubble";
import ToolCallBubble from "../components/ToolCallBubble";
import PromptInput from "../components/PromptInput";
import FeedbackPanel, { type PendingAction } from "../components/FeedbackPanel";
import DraftModal from "../components/DraftModal";
import SlashCommandsModal from "../components/SlashCommandsModal";
import BranchSelector from "../components/BranchSelector";
import GitDiffView from "../components/GitDiffView";
import { addRecentDirectory, getMaxTurns } from "../utils/localStorage";
import { getActivePlugins } from "../utils/plugins";

interface ToolGroup {
  kind: "tool_group";
  toolUse: ParsedMessage;
  toolResult: ParsedMessage | null;
  originalIndices: [number, number | null];
}

interface SingleMessage {
  kind: "single";
  message: ParsedMessage;
  originalIndex: number;
}

type DisplayItem = ToolGroup | SingleMessage;

/**
 * Detect if the messages contain an unresolved ExitPlanMode tool_use
 * (no matching tool_result). This happens when the page is refreshed
 * after the backend session has ended but before the user approved/rejected.
 */
function detectStaleExitPlanMode(messages: ParsedMessage[]): PendingAction | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    // Stop at first user message — unresolved tool_use must be in latest assistant turn
    if (msg.role === "user") break;
    if (msg.type === "tool_use" && msg.toolName === "ExitPlanMode") {
      const hasResult = messages.some((m) => m.type === "tool_result" && m.toolUseId === msg.toolUseId);
      if (!hasResult) {
        return { type: "plan_review", content: msg.content, stale: true };
      }
      break;
    }
  }
  return null;
}

interface ChatProps {
  onChatListRefresh?: () => void;
}

export default function Chat({ onChatListRefresh }: ChatProps = {}) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const isMobile = useIsMobile();

  // Mode detection: no id means we're on /chat/new (new chat mode)
  const folder = searchParams.get("folder") || "";
  const defaultPermissions = (location.state as any)?.defaultPermissions as DefaultPermissions | undefined;
  const agentSystemPrompt = (location.state as any)?.systemPrompt as string | undefined;
  const agentAlias = (location.state as any)?.agentAlias as string | undefined;

  const [chat, setChat] = useState<ChatType | null>(null);
  const [info, setInfo] = useState<NewChatInfo | null>(null);
  const [messages, setMessages] = useState<ParsedMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const globalSessionActive = useIsSessionActive(id);
  const [networkError, setNetworkError] = useState<string | null>(null);
  const [showDraftModal, setShowDraftModal] = useState(false);
  const [draftMessage, setDraftMessage] = useState("");
  const [inFlightMessage, setInFlightMessage] = useState<string | null>(null);
  const [slashCommands, setSlashCommands] = useState<string[]>([]);
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [activePluginIds, setActivePluginIds] = useState<string[]>([]);
  const [appPluginsData, setAppPluginsData] = useState<AppPluginsData | null>(null);
  const [showSlashCommandsModal, setShowSlashCommandsModal] = useState(false);
  const [promptInputSetValue, setPromptInputSetValue] = useState<((value: string) => void) | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [compacting, setCompacting] = useState(false);
  const [branchConfig, setBranchConfig] = useState<BranchConfig>({});
  const [viewMode, setViewMode] = useState<"chat" | "diff">("chat");
  const [showMobileActions, setShowMobileActions] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const hasReceivedFirstResponseRef = useRef<boolean>(false);
  const currentIdRef = useRef<string | undefined>(id);
  const handleSendRef = useRef<(prompt: string) => void>(() => {});
  const planApprovedRef = useRef(false);
  const tempChatIdRef = useRef<string | null>(null);
  const streamingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Compute team color map - assigns colors to teams in order of appearance
  const teamColorMap = useMemo(() => {
    const map = new Map<string, number>();
    let colorIndex = 0;
    for (const msg of messages) {
      if (msg.teamName && !map.has(msg.teamName)) {
        map.set(msg.teamName, colorIndex % TEAM_COLORS.length);
        colorIndex++;
      }
    }
    return map;
  }, [messages]);

  // Group tool_use + tool_result pairs into combined display items
  const displayItems: DisplayItem[] = useMemo(() => {
    const items: DisplayItem[] = [];
    const consumedIndices = new Set<number>();

    for (let i = 0; i < messages.length; i++) {
      if (consumedIndices.has(i)) continue;
      const msg = messages[i];

      if (msg.type === "tool_use") {
        // Look for a matching tool_result
        let matchedResultIndex: number | null = null;

        if (i + 1 < messages.length && messages[i + 1].type === "tool_result") {
          // If both have toolUseId, verify the match
          if (msg.toolUseId && messages[i + 1].toolUseId) {
            if (messages[i + 1].toolUseId === msg.toolUseId) {
              matchedResultIndex = i + 1;
            }
          } else {
            // Fallback for old data without toolUseId: trust adjacency
            matchedResultIndex = i + 1;
          }
        }

        // If not adjacent, scan forward with toolUseId matching
        if (matchedResultIndex === null && msg.toolUseId) {
          for (let j = i + 1; j < messages.length && j < i + 10; j++) {
            if (messages[j].type === "tool_result" && messages[j].toolUseId === msg.toolUseId && !consumedIndices.has(j)) {
              matchedResultIndex = j;
              break;
            }
          }
        }

        if (matchedResultIndex !== null) {
          consumedIndices.add(matchedResultIndex);
        }

        items.push({
          kind: "tool_group",
          toolUse: msg,
          toolResult: matchedResultIndex !== null ? messages[matchedResultIndex] : null,
          originalIndices: [i, matchedResultIndex],
        });
      } else if (msg.type === "tool_result") {
        // Orphaned tool_result (its tool_use was not found or already consumed)
        items.push({ kind: "single", message: msg, originalIndex: i });
      } else {
        items.push({ kind: "single", message: msg, originalIndex: i });
      }
    }

    return items;
  }, [messages]);

  // Keep navigate and onChatListRefresh in refs to avoid readSSE dependency churn
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const onChatListRefreshRef = useRef(onChatListRefresh);
  onChatListRefreshRef.current = onChatListRefresh;

  // Safety timeout: if streaming is true but no SSE events arrive for 2 minutes,
  // assume the stream is dead and reset the indicator.
  const STREAMING_INACTIVITY_TIMEOUT_MS = 300_000; // 5 minutes

  const clearStreamingTimeout = useCallback(() => {
    if (streamingTimeoutRef.current) {
      clearTimeout(streamingTimeoutRef.current);
      streamingTimeoutRef.current = null;
    }
  }, []);

  const resetStreamingTimeout = useCallback(() => {
    clearStreamingTimeout();
    streamingTimeoutRef.current = setTimeout(() => {
      setStreaming(false);
      setInFlightMessage(null);
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
    }, STREAMING_INACTIVITY_TIMEOUT_MS);
  }, [clearStreamingTimeout]);

  // Start/stop the safety timeout when streaming state changes
  useEffect(() => {
    if (streaming) {
      resetStreamingTimeout();
    } else {
      clearStreamingTimeout();
    }
    return () => clearStreamingTimeout();
  }, [streaming, resetStreamingTimeout, clearStreamingTimeout]);

  // Shared SSE reader that processes notifications and refetches chat data
  const readSSE = useCallback(
    async (body: ReadableStream<Uint8Array>) => {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      // Capture the chat ID this stream was created for
      const streamChatId = id;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          // If the user navigated to a different chat, stop processing this stream
          if (currentIdRef.current !== streamChatId) {
            reader.cancel();
            return;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const event = JSON.parse(line.slice(6));

              // Reset the safety timeout on every SSE event received
              resetStreamingTimeout();

              // Handle chat_created - fires during new chat creation
              if (event.type === "chat_created" && event.chatId) {
                tempChatIdRef.current = event.chatId;
                // Navigate to the real chat URL
                navigateRef.current(`/chat/${event.chatId}`, { replace: true });
                // Refresh chat list to show the new chat
                onChatListRefreshRef.current?.();
                // Cancel this stream - Chat will re-render with id param
                // and auto-connect via the globalSessionActive useEffect
                reader.cancel();
                return;
              }

              if (event.type === "message_complete") {
                if (currentIdRef.current !== streamChatId) return;
                setCompacting(false);

                // Check if the conversation ended right after a plan approval.
                // The SDK may end the conversation turn after ExitPlanMode is processed,
                // requiring a follow-up message to start the implementation phase.
                if (planApprovedRef.current) {
                  planApprovedRef.current = false;
                  // Refetch messages first, then auto-continue
                  getChat(streamChatId!).then((chatData) => {
                    if (currentIdRef.current !== streamChatId) return;
                    setChat(chatData);
                  });
                  getMessages(streamChatId!).then((msgs) => {
                    if (currentIdRef.current !== streamChatId) return;
                    setMessages(Array.isArray(msgs) ? msgs : []);
                  });
                  // Send a continuation message to start the implementation
                  // This mirrors how the CLI handles plan approval - it auto-continues
                  handleSendRef.current("Proceed with the plan.");
                  return;
                }

                // Build a system message if the session ended for a non-normal reason
                const reasonMessages: Record<string, string> = {
                  max_turns: `Agent reached the maximum turn limit (${getMaxTurns()}). You can send another message to continue.`,
                  max_budget: "Agent reached the maximum budget limit.",
                  execution_error: "Agent stopped due to an execution error.",
                  aborted: "Session was interrupted.",
                };
                const reasonMsg = event.reason ? reasonMessages[event.reason] : undefined;

                setStreaming(false);
                setInFlightMessage(null);
                // Refetch complete chat data and messages
                getChat(streamChatId!).then((chatData) => {
                  if (currentIdRef.current !== streamChatId) return;
                  setChat(chatData);
                });
                getMessages(streamChatId!).then((msgs) => {
                  if (currentIdRef.current !== streamChatId) return;
                  const msgArray = Array.isArray(msgs) ? msgs : [];
                  if (reasonMsg) {
                    setMessages([...msgArray, { role: "system", type: "system", content: reasonMsg }]);
                  } else {
                    setMessages(msgArray);
                  }
                });
                // Refresh slash commands in case they were discovered during initialization
                loadSlashCommands();
                return;
              }

              if (event.type === "message_error") {
                if (currentIdRef.current !== streamChatId) return;
                planApprovedRef.current = false;
                setCompacting(false);
                setStreaming(false);
                setInFlightMessage(null);
                // Refetch messages to show any partial content, then add error
                getMessages(streamChatId!).then((msgs) => {
                  if (currentIdRef.current !== streamChatId) return;
                  const msgArray = Array.isArray(msgs) ? msgs : [];
                  setMessages([...msgArray, { role: "assistant", type: "text", content: `Error: ${event.content}` }]);
                });
                return;
              }

              if (event.type === "compacting") {
                if (currentIdRef.current !== streamChatId) return;
                setCompacting(true);
                // Refetch messages to pick up the compact_boundary system message
                getMessages(streamChatId!).then((msgs) => {
                  if (currentIdRef.current !== streamChatId) return;
                  setMessages(Array.isArray(msgs) ? msgs : []);
                });
                continue;
              }

              if (event.type === "message_update") {
                if (currentIdRef.current !== streamChatId) return;
                setCompacting(false);
                // If we get message_update events after plan approval, it means
                // the SDK continued on its own — clear the auto-continue flag
                if (planApprovedRef.current) {
                  planApprovedRef.current = false;
                }
                // Clear in-flight message once we get the first response
                setInFlightMessage(null);
                // New content is available - refetch all messages to show latest state with timestamps
                getMessages(streamChatId!).then((msgs) => {
                  if (currentIdRef.current !== streamChatId) return;
                  setMessages(Array.isArray(msgs) ? msgs : []);
                });

                // Check if this is the first response and we should refresh chat list
                if (!hasReceivedFirstResponseRef.current && onChatListRefresh) {
                  hasReceivedFirstResponseRef.current = true;
                  onChatListRefresh();
                }
                continue;
              }

              if (event.type === "permission_request" || event.type === "user_question" || event.type === "plan_review") {
                if (currentIdRef.current !== streamChatId) return;
                setPendingAction({
                  type: event.type,
                  toolName: event.toolName,
                  input: event.input,
                  questions: event.questions,
                  suggestions: event.suggestions,
                  content: event.content,
                });
                continue;
              }
            } catch {}
          }
        }
      } finally {
        // Only update state if still on the same chat
        if (currentIdRef.current === streamChatId) {
          setStreaming(false);
          setInFlightMessage(null);
        }
      }
    },
    [id, resetStreamingTimeout],
  );

  // Connect to an existing SSE stream (e.g. after page refresh)
  const connectToStream = useCallback(async () => {
    // Avoid duplicate connections
    if (abortRef.current) {
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch(`/api/chats/${id}/stream`, {
        credentials: "include",
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        setStreaming(false);
        return;
      }
      await readSSE(res.body);
    } catch (err: any) {
      if (err.name !== "AbortError") {
        setNetworkError("network error");
        setStreaming(false);
      }
    } finally {
      abortRef.current = null;
    }
  }, [id, readSSE]);

  // Auto-connect to active sessions when the global session registry reports activity.
  // This replaces the old one-shot checkSessionStatus() call with a reactive approach:
  // whenever globalSessionActive becomes truthy, we connect to the SSE stream.
  useEffect(() => {
    if (!id || !globalSessionActive) return;
    if (streaming || abortRef.current) return; // Already connected

    setNetworkError(null);
    setStreaming(true);
    connectToStream();
  }, [id, globalSessionActive, streaming, connectToStream]);

  // Safety net: if the session registry reports the session stopped but we still
  // think we're streaming (e.g., SSE drop without message_complete), reset.
  useEffect(() => {
    if (!globalSessionActive && streaming && !abortRef.current) {
      setStreaming(false);
      setInFlightMessage(null);
    }
  }, [globalSessionActive, streaming]);

  // Fetch slash commands and plugins for the chat
  const loadSlashCommands = useCallback(async () => {
    if (!id) return;
    try {
      const { slashCommands, plugins, appPlugins } = await getSlashCommandsAndPlugins(id);
      setSlashCommands(slashCommands);
      setPlugins(plugins);
      if (appPlugins) setAppPluginsData(appPlugins);
    } catch (error) {
      console.warn("Failed to load slash commands and plugins:", error);
    }
  }, [id]);

  // Load folder info for new chat mode
  useEffect(() => {
    if (id || !folder) return; // Only run in new chat mode with a folder

    // Reset state from any previous existing chat — prevents stale streaming/error state
    // from carrying over when navigating from an active chat to a new chat
    setStreaming(false);
    setInFlightMessage(null);
    setPendingAction(null);
    setNetworkError(null);
    setChat(null);
    setMessages([]);
    setBranchConfig({});
    setViewMode("chat");
    currentIdRef.current = undefined;
    tempChatIdRef.current = null;

    // Abort any existing SSE stream from a previous chat
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }

    getNewChatInfo(folder)
      .then((data) => {
        setInfo(data);
        if (data.slash_commands) {
          setSlashCommands(data.slash_commands.map((cmd: any) => (typeof cmd === "string" ? cmd : cmd.name)));
        }
        if (data.plugins) {
          setPlugins(data.plugins);
        }
        if (data.appPlugins) {
          setAppPluginsData(data.appPlugins);
        }
      })
      .catch((err) => {
        setNetworkError(err.message || "Failed to load folder info");
      });
  }, [folder, id]);

  // Load existing chat data (only when id is available)
  useEffect(() => {
    if (!id) return;

    // Track the current chat ID for staleness detection in closures
    currentIdRef.current = id;

    // Reset state for new chat — prevents old chat's streaming/error state
    // from being visible while new chat data loads
    setStreaming(false);
    setInFlightMessage(null);
    setPendingAction(null);
    setNetworkError(null);
    setInfo(null); // Clear new-chat info when transitioning to existing mode
    setViewMode("chat"); // Reset to chat view when switching chats

    // Reset first response flag and plan approval tracking when chat ID changes
    hasReceivedFirstResponseRef.current = false;
    planApprovedRef.current = false;
    tempChatIdRef.current = null;

    getChat(id!).then((chatData) => {
      // Guard: only apply if still on this chat
      if (currentIdRef.current !== id) return;
      setChat(chatData);
      // Use slash commands and plugins from chat data if available for faster display
      if (chatData?.slash_commands && chatData.slash_commands.length > 0) {
        setSlashCommands(chatData.slash_commands.map((cmd: any) => (typeof cmd === "string" ? cmd : cmd.name)));
      }
      if (chatData?.plugins && chatData.plugins.length > 0) {
        setPlugins(chatData.plugins);
      }
      if ((chatData as any)?.appPlugins) {
        setAppPluginsData((chatData as any).appPlugins);
      }

      // Fetch fresh data if not available
      if (!chatData?.slash_commands?.length && !chatData?.plugins?.length) {
        loadSlashCommands();
      }
    });
    Promise.all([getMessages(id!), getPending(id!)]).then(([msgs, pending]) => {
      if (currentIdRef.current !== id) return;
      const messageArray = Array.isArray(msgs) ? msgs : [];
      setMessages(messageArray);

      // On chat refresh / SSE drop, if messages contain a user message,
      // refresh the chat list so the title/preview shows up in the sidebar
      if (messageArray.some((m) => m.role === "user")) {
        onChatListRefreshRef.current?.();
      }

      if (pending) {
        setPendingAction(pending);
        setStreaming(true);
      } else {
        // Detect stale ExitPlanMode: if the last assistant turn has an unresolved
        // ExitPlanMode tool_use, reconstruct the plan review panel from message history
        const stalePlan = detectStaleExitPlanMode(messageArray);
        if (stalePlan) {
          setPendingAction(stalePlan);
          // Don't set streaming=true — no active backend session
        }
      }
    });

    // Auto-connect is now handled reactively by the globalSessionActive useEffect above

    // Cleanup: abort SSE stream when chat ID changes or component unmounts
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
    };
  }, [id, loadSlashCommands]);

  useEffect(() => {
    // Only auto-scroll if auto-scroll is enabled
    if (!autoScroll) return;

    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, inFlightMessage, autoScroll]);

  // Auto-scroll to bottom when switching from diff view back to chat
  useEffect(() => {
    if (viewMode === "chat") {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [viewMode]);

  // Load active plugins from localStorage and listen for changes
  useEffect(() => {
    const loadActive = () => setActivePluginIds(Array.from(getActivePlugins()));

    loadActive();

    // Listen for storage changes (when SlashCommandsModal updates activePlugins)
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === "activePlugins") loadActive();
    };

    window.addEventListener("storage", handleStorageChange);
    return () => window.removeEventListener("storage", handleStorageChange);
  }, []);

  const toggleAutoScroll = useCallback(() => {
    setAutoScroll((prev) => {
      const newAutoScroll = !prev;
      // If turning auto-scroll on, immediately scroll to bottom
      if (newAutoScroll) {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" });
      }
      return newAutoScroll;
    });
  }, []);

  const handleSend = useCallback(
    async (prompt: string, images?: File[]) => {
      // Set in-flight message to show user's message immediately
      setInFlightMessage(prompt);
      setNetworkError(null); // Clear any previous network errors

      // If there's already a streaming connection, stop it first
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }

      setStreaming(true);
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        let res: Response;

        if (!id) {
          // NEW CHAT MODE: POST to /api/chats/new/message
          addRecentDirectory(folder);

          const requestBody: any = { folder, prompt, defaultPermissions, maxTurns: getMaxTurns() };
          if (activePluginIds.length > 0) {
            requestBody.activePlugins = activePluginIds;
          }
          if (branchConfig.baseBranch || branchConfig.newBranch || branchConfig.useWorktree) {
            requestBody.branchConfig = branchConfig;
          }
          if (agentSystemPrompt) {
            requestBody.systemPrompt = agentSystemPrompt;
          }
          if (agentAlias) {
            requestBody.agentAlias = agentAlias;
          }

          res = await fetch("/api/chats/new/message", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify(requestBody),
            signal: controller.signal,
          });
        } else {
          // EXISTING CHAT MODE: POST to /api/chats/:id/message
          // Handle image upload first if images are provided
          let imageIds: string[] = [];
          if (images && images.length > 0) {
            try {
              const uploadResult = await uploadImages(id, images);
              if (uploadResult.success) {
                imageIds = (uploadResult.images ?? []).map((img) => img.id);
              } else {
                console.error("Image upload failed:", uploadResult.errors);
              }
            } catch (error) {
              console.error("Image upload error:", error);
            }
          }

          if (chat?.folder) {
            addRecentDirectory(chat.displayFolder || chat.folder);
          }

          const body: any = { prompt, maxTurns: getMaxTurns() };
          if (imageIds.length > 0) {
            body.imageIds = imageIds;
          }
          if (activePluginIds.length > 0) {
            body.activePlugins = activePluginIds;
          }

          res = await fetch(`/api/chats/${id}/message`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        }

        if (!res.ok || !res.body) {
          const errorData = await res.json().catch(() => ({}));
          setNetworkError(errorData.error || "Failed to send message");
          setStreaming(false);
          setInFlightMessage(null);
          return;
        }

        await readSSE(res.body);
      } catch (err: any) {
        if (err.name !== "AbortError") {
          setNetworkError("network error");
          setStreaming(false);
          setInFlightMessage(null); // Clear in-flight message on error
        }
      } finally {
        // Only stop streaming if this is still the current request
        if (abortRef.current === controller) {
          setStreaming(false);
          setInFlightMessage(null); // Clear in-flight message when done
          abortRef.current = null;
        }
      }
    },
    [id, folder, defaultPermissions, agentSystemPrompt, agentAlias, readSSE, activePluginIds, chat, branchConfig],
  );

  // Keep ref in sync so readSSE can call handleSend without stale closure
  handleSendRef.current = handleSend;

  const handleRespond = useCallback(
    async (allow: boolean, updatedInput?: Record<string, unknown>) => {
      const wasReconnect = !abortRef.current; // no active SSE = page was refreshed
      const currentAction = pendingAction; // Capture before clearing
      setPendingAction(null);

      // Use id if available, fall back to tempChatIdRef for new chat mode
      const chatId = id || tempChatIdRef.current;
      if (!chatId) return;

      // Stale plan review: no live backend session to resolve, so start a new
      // conversation turn with an appropriate message instead
      if (currentAction?.stale && currentAction.type === "plan_review") {
        if (allow) {
          handleSend("Proceed with the plan.");
        } else {
          handleSend("I rejected the plan. Please revise it.");
        }
        return;
      }

      const result = await respondToChat(chatId, allow, updatedInput);

      // Track if this was an ExitPlanMode approval - the SDK conversation may end
      // after plan approval, so we need to auto-send a continuation message
      if (result.toolName === "ExitPlanMode" && allow) {
        planApprovedRef.current = true;
      }

      // If we got here via page refresh (no active stream), reconnect to the SSE stream
      if (wasReconnect && id) {
        setStreaming(true);
        connectToStream();
      }
    },
    [id, connectToStream, pendingAction, handleSend],
  );

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    if (id) {
      fetch(`/api/chats/${id}/stop`, { method: "POST", credentials: "include" });
    }
    setStreaming(false);
    setInFlightMessage(null); // Clear in-flight message when stopping
    setPendingAction(null);
  }, [id]);

  const handleReconnect = useCallback(async () => {
    setNetworkError(null);
    // Refetch chat data and messages to capture any missing content
    getChat(id!).then(setChat);
    Promise.all([getMessages(id!), getPending(id!)]).then(([msgs, pending]) => {
      const messageArray = Array.isArray(msgs) ? msgs : [];
      setMessages(messageArray);
      if (pending) {
        setPendingAction(pending);
        setStreaming(true);
      } else {
        const stalePlan = detectStaleExitPlanMode(messageArray);
        if (stalePlan) {
          setPendingAction(stalePlan);
        }
      }
    });
    // Auto-connect is handled reactively by the globalSessionActive useEffect
    if (globalSessionActive && !streaming && !abortRef.current) {
      setStreaming(true);
      connectToStream();
    }
  }, [globalSessionActive, streaming, connectToStream, id]);

  // Compute indices of user text messages for navigation
  const userMessageIndices = useMemo(() => {
    const indices: number[] = [];
    messages.forEach((msg, i) => {
      if (msg.role === "user" && msg.type === "text") {
        indices.push(i);
      }
    });
    return indices;
  }, [messages]);

  // Track which user message we're currently navigated to
  const [userMsgNavIndex, setUserMsgNavIndex] = useState<number | null>(null);

  // Reset user message nav when messages change (new messages arrive)
  useEffect(() => {
    setUserMsgNavIndex(null);
  }, [messages.length]);

  // Navigate to previous (older) user message
  const navigatePrevUserMessage = useCallback(() => {
    if (userMessageIndices.length === 0) return;
    setAutoScroll(false);
    const newNavIndex = userMsgNavIndex === null ? userMessageIndices.length - 1 : Math.max(0, userMsgNavIndex - 1);
    setUserMsgNavIndex(newNavIndex);
    const msgIndex = userMessageIndices[newNavIndex];
    const el = document.querySelector(`[data-message-index="${msgIndex}"]`) as HTMLElement | null;
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.style.outline = "2px solid var(--accent)";
      el.style.borderRadius = "8px";
      setTimeout(() => {
        el.style.outline = "";
        el.style.borderRadius = "";
      }, 2000);
    }
  }, [userMessageIndices, userMsgNavIndex]);

  // Navigate to next (newer) user message
  const navigateNextUserMessage = useCallback(() => {
    if (userMessageIndices.length === 0 || userMsgNavIndex === null) return;
    const newNavIndex = userMsgNavIndex + 1;
    if (newNavIndex >= userMessageIndices.length) {
      // Past the last user message — go to bottom
      setUserMsgNavIndex(null);
      setAutoScroll(true);
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
      return;
    }
    setUserMsgNavIndex(newNavIndex);
    const msgIndex = userMessageIndices[newNavIndex];
    const el = document.querySelector(`[data-message-index="${msgIndex}"]`) as HTMLElement | null;
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.style.outline = "2px solid var(--accent)";
      el.style.borderRadius = "8px";
      setTimeout(() => {
        el.style.outline = "";
        el.style.borderRadius = "";
      }, 2000);
    }
  }, [userMessageIndices, userMsgNavIndex]);

  // Check if there are any TodoWrite tool calls in the conversation
  const hasTodoList = useMemo(() => {
    return messages.some((message) => message.type === "tool_use" && message.toolName === "TodoWrite");
  }, [messages]);

  const handleTodoListClick = useCallback(() => {
    // Find the latest TodoWrite tool call and its result
    let latestTodoIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].type === "tool_use" && messages[i].toolName === "TodoWrite") {
        latestTodoIndex = i;
        break;
      }
    }

    if (latestTodoIndex >= 0) {
      // Scroll to the todo list
      const targetElement = document.querySelector(`[data-message-index="${latestTodoIndex}"]`) as HTMLElement | null;
      if (targetElement) {
        targetElement.scrollIntoView({ behavior: "smooth", block: "center" });
        targetElement.style.outline = "2px solid var(--accent)";
        targetElement.style.borderRadius = "8px";
        setTimeout(() => {
          targetElement.style.outline = "";
          targetElement.style.borderRadius = "";
        }, 2000);
      }
    }
  }, [messages]);

  const handleSaveDraft = useCallback((message: string, images?: File[], onSuccess?: () => void) => {
    if (!message.trim()) return;
    setDraftMessage(message.trim());
    setShowDraftModal(true);
    // Store the success callback to call when draft is saved
    if (onSuccess) {
      setDraftSuccessCallback(() => onSuccess);
    }
    // TODO: Handle images in draft
  }, []);

  const [draftSuccessCallback, setDraftSuccessCallback] = useState<(() => void) | null>(null);

  const handleCommandSelect = useCallback(
    (command: string) => {
      if (promptInputSetValue) {
        promptInputSetValue(command);
      }
    },
    [promptInputSetValue],
  );

  // Early return: no folder specified in new chat mode
  if (!id && !folder) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <p style={{ color: "var(--text-muted)" }}>No folder specified. Please select a folder from the chat list.</p>
      </div>
    );
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <header
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexShrink: 0,
        }}
      >
        {isMobile && (
          <button
            onClick={() => navigate("/")}
            style={{
              background: "none",
              border: "none",
              padding: "4px 8px",
              cursor: "pointer",
              color: "var(--text)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            title="Back to chat list"
          >
            <ArrowLeft size={20} />
          </button>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ fontSize: 15, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {!id
                ? info?.is_git_repo
                  ? info.git_branch || "main"
                  : folder.split("/").pop() || "New Chat"
                : chat?.is_git_repo
                  ? chat.git_branch || "main"
                  : chat?.folder?.split("/").pop() || "Chat"}
            </div>
            {!id ? (
              <div
                style={{
                  fontSize: 11,
                  padding: "2px 6px",
                  borderRadius: 4,
                  background: "var(--accent)",
                  color: "#fff",
                  fontWeight: 500,
                }}
              >
                New
              </div>
            ) : globalSessionActive ? (
              <div
                style={{
                  fontSize: 11,
                  padding: "2px 6px",
                  borderRadius: 4,
                  background: globalSessionActive.type === "web" ? "var(--accent)" : "#10b981",
                  color: "#fff",
                  fontWeight: 500,
                }}
              >
                {globalSessionActive.type === "web" ? "🌐 Active" : "💻 CLI"}
              </div>
            ) : null}
            {/* Worktree tag */}
            {(!id ? info?.is_worktree : chat?.folder && chat?.displayFolder && chat.folder !== chat.displayFolder) && (
              <div
                style={{
                  fontSize: 11,
                  padding: "2px 6px",
                  borderRadius: 4,
                  background: "#8b5cf6",
                  color: "#fff",
                  fontWeight: 500,
                  display: "flex",
                  alignItems: "center",
                  gap: 3,
                  flexShrink: 0,
                }}
                title="This session is running in a git worktree"
              >
                <GitFork size={10} />
                worktree
              </div>
            )}
          </div>
          <div
            title={!id ? folder : chat?.folder}
            style={{
              fontSize: 12,
              color: "var(--text-muted)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              direction: "rtl",
              textAlign: "left",
            }}
          >
            {!id ? folder : chat?.folder}
          </div>
        </div>
        {/* Desktop: action buttons inline, right-aligned */}
        {!isMobile && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto" }}>
            {/* Chat / Diff view toggle - only for git repos */}
            {((!id && info?.is_git_repo) || (id && chat?.is_git_repo)) && (
              <button
                onClick={() => setViewMode(viewMode === "chat" ? "diff" : "chat")}
                style={{
                  background: "var(--bg-secondary, var(--surface))",
                  color: "var(--text)",
                  padding: "8px",
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  transition: "all 0.15s ease",
                }}
                title={viewMode === "chat" ? "Show git diff" : "Back to chat"}
              >
                {viewMode === "chat" ? <GitBranch size={16} /> : <MessageSquare size={16} />}
              </button>
            )}

            {id && userMessageIndices.length > 1 && (
              <div style={{ display: "flex", borderRadius: 6, overflow: "hidden", border: "1px solid var(--border)" }}>
                <button
                  onClick={navigatePrevUserMessage}
                  disabled={userMsgNavIndex === 0}
                  style={{
                    background: "var(--bg-secondary, var(--surface))",
                    color: userMsgNavIndex === 0 ? "var(--text-muted)" : "var(--text)",
                    padding: "8px",
                    border: "none",
                    borderRight: "1px solid var(--border)",
                    cursor: userMsgNavIndex === 0 ? "default" : "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    opacity: userMsgNavIndex === 0 ? 0.4 : 1,
                    transition: "all 0.15s ease",
                  }}
                  title="Previous user message"
                >
                  <ChevronUp size={16} />
                </button>
                <button
                  onClick={navigateNextUserMessage}
                  disabled={userMsgNavIndex === null}
                  style={{
                    background: "var(--bg-secondary, var(--surface))",
                    color: userMsgNavIndex === null ? "var(--text-muted)" : "var(--text)",
                    padding: "8px",
                    border: "none",
                    cursor: userMsgNavIndex === null ? "default" : "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    opacity: userMsgNavIndex === null ? 0.4 : 1,
                    transition: "all 0.15s ease",
                  }}
                  title="Next user message"
                >
                  <ChevronDown size={16} />
                </button>
              </div>
            )}

            {hasTodoList && (
              <button
                onClick={handleTodoListClick}
                style={{
                  background: "var(--accent)",
                  color: "#fff",
                  padding: "8px",
                  borderRadius: 6,
                  border: "none",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
                title="Jump to latest to-do list"
              >
                <CheckSquare size={16} />
              </button>
            )}

            {/* Slash Commands Modal Button */}
            {slashCommands.length > 0 && (
              <button
                onClick={() => setShowSlashCommandsModal(true)}
                style={{
                  background: "var(--bg-secondary)",
                  color: "var(--text)",
                  padding: "8px",
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
                title="View available slash commands"
              >
                <Slash size={16} />
              </button>
            )}

            {networkError && (
              <button
                onClick={handleReconnect}
                style={{
                  background: "var(--accent)",
                  color: "#fff",
                  padding: "8px",
                  borderRadius: 6,
                  border: "none",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
                title="Reconnect to stream"
              >
                <RotateCw size={16} />
              </button>
            )}
          </div>
        )}

        {/* Stop button - always in top bar */}
        <button
          onClick={handleStop}
          disabled={!streaming}
          style={{
            background: streaming ? "var(--danger)" : "var(--border)",
            color: streaming ? "#fff" : "var(--text-secondary)",
            padding: "8px",
            borderRadius: 6,
            border: "none",
            cursor: streaming ? "pointer" : "default",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            opacity: streaming ? 1 : 0.5,
          }}
          title={streaming ? "Stop generation" : "No active generation"}
        >
          <Square size={14} />
        </button>

        {/* Mobile: toggle button for secondary action bar */}
        {isMobile && (
          <button
            onClick={() => setShowMobileActions(!showMobileActions)}
            style={{
              background: showMobileActions ? "var(--accent)" : "var(--bg-secondary)",
              color: showMobileActions ? "#fff" : "var(--text)",
              padding: "8px",
              borderRadius: 6,
              border: showMobileActions ? "none" : "1px solid var(--border)",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            title={showMobileActions ? "Hide actions" : "Show actions"}
          >
            <MoreHorizontal size={16} />
          </button>
        )}
      </header>

      {/* Mobile: secondary action bar */}
      {isMobile && showMobileActions && (
        <div
          style={{
            padding: "6px 16px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 8,
            flexShrink: 0,
          }}
        >
          {/* Chat / Diff view toggle - only for git repos */}
          {((!id && info?.is_git_repo) || (id && chat?.is_git_repo)) && (
            <button
              onClick={() => setViewMode(viewMode === "chat" ? "diff" : "chat")}
              style={{
                background: "var(--bg-secondary, var(--surface))",
                color: "var(--text)",
                padding: "8px",
                borderRadius: 6,
                border: "1px solid var(--border)",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
              title={viewMode === "chat" ? "Show git diff" : "Back to chat"}
            >
              {viewMode === "chat" ? <GitBranch size={16} /> : <MessageSquare size={16} />}
            </button>
          )}

          {id && userMessageIndices.length > 1 && (
            <div style={{ display: "flex", borderRadius: 6, overflow: "hidden", border: "1px solid var(--border)", flexShrink: 0 }}>
              <button
                onClick={navigatePrevUserMessage}
                disabled={userMsgNavIndex === 0}
                style={{
                  background: "var(--bg-secondary, var(--surface))",
                  color: userMsgNavIndex === 0 ? "var(--text-muted)" : "var(--text)",
                  padding: "8px",
                  border: "none",
                  borderRight: "1px solid var(--border)",
                  cursor: userMsgNavIndex === 0 ? "default" : "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  opacity: userMsgNavIndex === 0 ? 0.4 : 1,
                }}
                title="Previous user message"
              >
                <ChevronUp size={16} />
              </button>
              <button
                onClick={navigateNextUserMessage}
                disabled={userMsgNavIndex === null}
                style={{
                  background: "var(--bg-secondary, var(--surface))",
                  color: userMsgNavIndex === null ? "var(--text-muted)" : "var(--text)",
                  padding: "8px",
                  border: "none",
                  cursor: userMsgNavIndex === null ? "default" : "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  opacity: userMsgNavIndex === null ? 0.4 : 1,
                }}
                title="Next user message"
              >
                <ChevronDown size={16} />
              </button>
            </div>
          )}

          {hasTodoList && (
            <button
              onClick={handleTodoListClick}
              style={{
                background: "var(--accent)",
                color: "#fff",
                padding: "8px",
                borderRadius: 6,
                border: "none",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
              title="Jump to latest to-do list"
            >
              <CheckSquare size={16} />
            </button>
          )}

          {slashCommands.length > 0 && (
            <button
              onClick={() => setShowSlashCommandsModal(true)}
              style={{
                background: "var(--bg-secondary)",
                color: "var(--text)",
                padding: "8px",
                borderRadius: 6,
                border: "1px solid var(--border)",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
              title="View available slash commands"
            >
              <Slash size={16} />
            </button>
          )}

          {networkError && (
            <button
              onClick={handleReconnect}
              style={{
                background: "var(--accent)",
                color: "#fff",
                padding: "8px",
                borderRadius: 6,
                border: "none",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
              title="Reconnect to stream"
            >
              <RotateCw size={16} />
            </button>
          )}
        </div>
      )}

      <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
        {viewMode === "diff" ? (
          <GitDiffView folder={!id ? folder : chat?.folder || folder} />
        ) : (
          <div ref={chatContainerRef} style={{ height: "100%", overflow: "auto", padding: "12px 16px" }}>
            {!id ? (
              /* NEW CHAT MODE: Welcome screen */
              <>
                {networkError && (
                  <div
                    style={{
                      color: "var(--danger)",
                      background: "var(--danger-bg, rgba(255, 0, 0, 0.1))",
                      padding: "12px 16px",
                      borderRadius: 6,
                      marginBottom: 16,
                    }}
                  >
                    {networkError}
                  </div>
                )}

                {!streaming && !networkError && (
                  <div style={{ padding: "40px 20px", maxWidth: 600, margin: "0 auto" }}>
                    {/* Folder info */}
                    <div
                      style={{
                        background: "var(--bg-secondary)",
                        borderRadius: 12,
                        padding: "20px 24px",
                        marginBottom: 16,
                      }}
                    >
                      <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 8 }}>Working Directory</div>
                      <div style={{ fontSize: 15, fontWeight: 500, wordBreak: "break-all" }}>{folder}</div>
                      {info?.is_git_repo && (
                        <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 8 }}>
                          <span
                            style={{
                              background: "#10b981",
                              color: "#fff",
                              padding: "3px 8px",
                              borderRadius: 4,
                              fontSize: 11,
                              fontWeight: 500,
                            }}
                          >
                            Git
                          </span>
                          <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
                            Branch: <strong style={{ color: "var(--text)" }}>{info.git_branch || "main"}</strong>
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Slash commands if available */}
                    {slashCommands.length > 0 && (
                      <div
                        style={{
                          background: "var(--bg-secondary)",
                          borderRadius: 12,
                          padding: "20px 24px",
                          marginBottom: 16,
                        }}
                      >
                        <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 12 }}>Available Commands</div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                          {slashCommands.slice(0, 8).map((cmd, i) => (
                            <button
                              key={i}
                              onClick={() => {
                                if (promptInputSetValue) {
                                  promptInputSetValue(cmd);
                                }
                              }}
                              style={{
                                background: "var(--bg)",
                                border: "1px solid var(--border)",
                                borderRadius: 6,
                                padding: "6px 12px",
                                fontSize: 13,
                                color: "var(--accent)",
                                cursor: "pointer",
                                fontFamily: "monospace",
                              }}
                            >
                              {cmd}
                            </button>
                          ))}
                          {slashCommands.length > 8 && (
                            <button
                              onClick={() => setShowSlashCommandsModal(true)}
                              style={{
                                background: "var(--bg)",
                                border: "1px solid var(--border)",
                                borderRadius: 6,
                                padding: "6px 12px",
                                fontSize: 13,
                                color: "var(--text-muted)",
                                cursor: "pointer",
                              }}
                            >
                              +{slashCommands.length - 8} more
                            </button>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Getting started hint */}
                    <p style={{ color: "var(--text-muted)", textAlign: "center", fontSize: 14 }}>Send a message to start coding with Claude.</p>
                  </div>
                )}

                {inFlightMessage && (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "flex-end",
                      margin: "6px 0",
                    }}
                  >
                    <div
                      style={{
                        maxWidth: "85%",
                        padding: "10px 14px",
                        borderRadius: "var(--radius)",
                        background: "var(--user-bg)",
                        border: "1px solid transparent",
                        fontSize: 14,
                        lineHeight: 1.5,
                        wordBreak: "break-word",
                        opacity: 0.7,
                      }}
                    >
                      {inFlightMessage}
                    </div>
                    <div
                      style={{
                        fontSize: 10,
                        color: "var(--text-muted)",
                        opacity: 0.5,
                        marginTop: 4,
                        textAlign: "right",
                      }}
                    >
                      Sending...
                    </div>
                  </div>
                )}

                {streaming && <div style={{ color: "var(--text-muted)", fontSize: 13, padding: "8px 0" }}>Starting chat session...</div>}
              </>
            ) : (
              /* EXISTING CHAT MODE: Message list */
              <>
                {messages.length === 0 && !streaming && (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      height: "100%",
                      color: "var(--text-muted)",
                      fontSize: 14,
                    }}
                  >
                    No messages in this conversation
                  </div>
                )}
                {displayItems.map((item) => {
                  if (item.kind === "tool_group") {
                    return (
                      <div key={`tool-${item.originalIndices[0]}`} data-message-index={item.originalIndices[0]}>
                        <ToolCallBubble toolUse={item.toolUse} toolResult={item.toolResult} isRunning={item.toolResult === null && streaming} />
                      </div>
                    );
                  }
                  return (
                    <div key={item.originalIndex} data-message-index={item.originalIndex}>
                      <MessageBubble message={item.message} teamColorMap={teamColorMap} />
                    </div>
                  );
                })}
                {inFlightMessage && (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "flex-end",
                      margin: "6px 0",
                    }}
                  >
                    <div
                      style={{
                        maxWidth: "85%",
                        padding: "10px 14px",
                        borderRadius: "var(--radius)",
                        background: "var(--user-bg)",
                        border: "1px solid transparent",
                        fontSize: 14,
                        lineHeight: 1.5,
                        wordBreak: "break-word",
                        opacity: 0.7,
                      }}
                    >
                      {inFlightMessage}
                    </div>
                    <div
                      style={{
                        fontSize: 10,
                        color: "var(--text-muted)",
                        opacity: 0.5,
                        marginTop: 4,
                        textAlign: "right" as const,
                      }}
                    >
                      Sending...
                    </div>
                  </div>
                )}
                {networkError && (
                  <div
                    style={{
                      color: "var(--danger)",
                      fontSize: 13,
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      background: "var(--danger-bg, rgba(255, 0, 0, 0.1))",
                      borderRadius: 6,
                      padding: "12px 16px",
                      margin: "8px 0",
                    }}
                  >
                    <div>Network error occurred</div>
                    <button
                      onClick={handleReconnect}
                      style={{
                        background: "var(--accent)",
                        color: "#fff",
                        padding: "4px 8px",
                        borderRadius: 4,
                        fontSize: 11,
                        marginLeft: "auto",
                      }}
                    >
                      <RotateCw size={12} style={{ marginRight: 4 }} />
                      Reconnect
                    </button>
                  </div>
                )}
                {streaming && (
                  <div style={{ color: "var(--text-muted)", fontSize: 13, padding: "8px 0", display: "flex", alignItems: "center", gap: 8 }}>
                    <div>{compacting ? "Compacting conversation..." : "Claude is working..."}</div>
                    <div style={{ fontSize: 11, opacity: 0.7 }}>
                      {compacting ? "(Summarizing context to free up space)" : "(You can send another message anytime)"}
                    </div>
                  </div>
                )}
                <div ref={bottomRef} />
              </>
            )}
          </div>
        )}

        {/* Auto-scroll toggle button - only show in existing chat mode */}
        {id && viewMode === "chat" && (
          <button
            onClick={toggleAutoScroll}
            style={{
              position: "absolute",
              bottom: "20px",
              right: "20px",
              background: autoScroll ? "var(--accent)" : "var(--bg-secondary)",
              color: autoScroll ? "#fff" : "var(--text)",
              border: autoScroll ? "none" : "1px solid var(--border)",
              borderRadius: "50%",
              width: "40px",
              height: "40px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              boxShadow: "0 4px 12px rgba(0, 0, 0, 0.15)",
              zIndex: 10,
              transition: "all 0.2s ease",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = "scale(1.1)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = "scale(1)";
            }}
            title={autoScroll ? "Auto-scroll is ON - Click to disable" : "Auto-scroll is OFF - Click to enable"}
          >
            <ArrowDown size={20} />
          </button>
        )}
      </div>

      {/* Branch selector for git repos - shown above prompt for new chats */}
      {!id && info?.is_git_repo && !pendingAction && (
        <div style={{ padding: "0 16px" }}>
          <BranchSelector folder={folder} currentBranch={info.git_branch || "main"} onChange={setBranchConfig} />
        </div>
      )}

      {pendingAction ? (
        <FeedbackPanel action={pendingAction} onRespond={handleRespond} />
      ) : (
        <PromptInput
          onSend={handleSend}
          disabled={!id && streaming}
          onSaveDraft={handleSaveDraft}
          slashCommands={slashCommands}
          onSetValue={setPromptInputSetValue}
        />
      )}

      <DraftModal
        isOpen={showDraftModal}
        onClose={() => {
          setShowDraftModal(false);
          setDraftMessage("");
          setDraftSuccessCallback(null);
        }}
        chatId={id || null}
        message={draftMessage}
        onSuccess={draftSuccessCallback || undefined}
        folder={!id ? folder : undefined}
        defaultPermissions={!id ? defaultPermissions : undefined}
      />

      <SlashCommandsModal
        isOpen={showSlashCommandsModal}
        onClose={() => setShowSlashCommandsModal(false)}
        slashCommands={slashCommands}
        plugins={plugins}
        appPluginsData={appPluginsData}
        onCommandSelect={handleCommandSelect}
        onActivePluginsChange={setActivePluginIds}
        onAppPluginsDataChange={setAppPluginsData}
      />
    </div>
  );
}
