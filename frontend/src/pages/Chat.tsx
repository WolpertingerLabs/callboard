import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { RotateCw, CheckSquare, Square, Slash, ArrowLeft, ChevronDown, ArrowDown } from 'lucide-react';
import { useIsMobile } from '../hooks/useIsMobile';
import { getChat, getMessages, getPending, respondToChat, getSessionStatus, uploadImages, getSlashCommands, getSlashCommandsAndPlugins, type Chat as ChatType, type ParsedMessage, type SessionStatus, type Plugin } from '../api';
import MessageBubble, { TEAM_COLORS } from '../components/MessageBubble';
import PromptInput from '../components/PromptInput';
import FeedbackPanel, { type PendingAction } from '../components/FeedbackPanel';
import DraftModal from '../components/DraftModal';
import SlashCommandsModal from '../components/SlashCommandsModal';
import { addRecentDirectory } from '../utils/localStorage';

interface ChatProps {
  onChatListRefresh?: () => void;
}

export default function Chat({ onChatListRefresh }: ChatProps = {}) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [chat, setChat] = useState<ChatType | null>(null);
  const [messages, setMessages] = useState<ParsedMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus | null>(null);
  const [networkError, setNetworkError] = useState<string | null>(null);
  const [showDraftModal, setShowDraftModal] = useState(false);
  const [draftMessage, setDraftMessage] = useState('');
  const [inFlightMessage, setInFlightMessage] = useState<string | null>(null);
  const [slashCommands, setSlashCommands] = useState<string[]>([]);
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [activePluginIds, setActivePluginIds] = useState<string[]>([]);
  const [showSlashCommandsModal, setShowSlashCommandsModal] = useState(false);
  const [promptInputSetValue, setPromptInputSetValue] = useState<((value: string) => void) | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const hasReceivedFirstResponseRef = useRef<boolean>(false);
  const currentIdRef = useRef<string | undefined>(id);

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

  // Shared SSE reader that processes notifications and refetches chat data
  const readSSE = useCallback(async (body: ReadableStream<Uint8Array>) => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
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
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6));

            if (event.type === 'message_complete') {
              if (currentIdRef.current !== streamChatId) return;
              setStreaming(false);
              setInFlightMessage(null);
              // Refetch complete chat data and messages
              getChat(streamChatId!).then(chatData => {
                if (currentIdRef.current !== streamChatId) return;
                setChat(chatData);
              });
              getMessages(streamChatId!).then(msgs => {
                if (currentIdRef.current !== streamChatId) return;
                setMessages(Array.isArray(msgs) ? msgs : []);
              });
              // Refresh slash commands in case they were discovered during initialization
              loadSlashCommands();
              return;
            }

            if (event.type === 'message_error') {
              if (currentIdRef.current !== streamChatId) return;
              setStreaming(false);
              setInFlightMessage(null);
              // Refetch messages to show any partial content, then add error
              getMessages(streamChatId!).then(msgs => {
                if (currentIdRef.current !== streamChatId) return;
                const msgArray = Array.isArray(msgs) ? msgs : [];
                setMessages([...msgArray, { role: 'assistant', type: 'text', content: `Error: ${event.content}` }]);
              });
              return;
            }

            if (event.type === 'message_update') {
              if (currentIdRef.current !== streamChatId) return;
              // Clear in-flight message once we get the first response
              setInFlightMessage(null);
              // New content is available - refetch all messages to show latest state with timestamps
              getMessages(streamChatId!).then(msgs => {
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

            if (event.type === 'permission_request' || event.type === 'user_question' || event.type === 'plan_review') {
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
  }, [id]);

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
        credentials: 'include',
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        setStreaming(false);
        return;
      }
      await readSSE(res.body);
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        setNetworkError('network error');
        setStreaming(false);
      }
    } finally {
      abortRef.current = null;
    }
  }, [id, readSSE]);

  // Check session status and auto-connect to active sessions
  const checkSessionStatus = useCallback(async () => {
    if (!id) return;
    const checkId = id; // Capture for staleness check
    try {
      const status = await getSessionStatus(id);
      // If user navigated to a different chat while awaiting, discard result
      if (currentIdRef.current !== checkId) return;
      setSessionStatus(status);

      // Auto-connect if session is active (web or CLI)
      if (status.active && (status.type === 'web' || status.type === 'cli')) {
        setNetworkError(null); // Clear any previous network errors
        setStreaming(true);
        connectToStream();
      }
    } catch (error) {
      console.warn('Failed to check session status:', error);
    }
  }, [id, connectToStream]);

  // Fetch slash commands and plugins for the chat
  const loadSlashCommands = useCallback(async () => {
    if (!id) return;
    try {
      const { slashCommands, plugins } = await getSlashCommandsAndPlugins(id);
      setSlashCommands(slashCommands);
      setPlugins(plugins);
    } catch (error) {
      console.warn('Failed to load slash commands and plugins:', error);
    }
  }, [id]);

  useEffect(() => {
    // Track the current chat ID for staleness detection in closures
    currentIdRef.current = id;

    // Reset state for new chat — prevents old chat's streaming/error state
    // from being visible while new chat data loads
    setStreaming(false);
    setInFlightMessage(null);
    setPendingAction(null);
    setNetworkError(null);
    setSessionStatus(null);

    // Reset first response flag when chat ID changes
    hasReceivedFirstResponseRef.current = false;

    getChat(id!).then(chatData => {
      // Guard: only apply if still on this chat
      if (currentIdRef.current !== id) return;
      setChat(chatData);
      // Use slash commands and plugins from chat data if available for faster display
      if (chatData?.slash_commands && chatData.slash_commands.length > 0) {
        setSlashCommands(chatData.slash_commands.map((cmd: any) =>
          typeof cmd === 'string' ? cmd : cmd.name
        ));
      }
      if (chatData?.plugins && chatData.plugins.length > 0) {
        setPlugins(chatData.plugins);
      }

      // Fetch fresh data if not available
      if (!chatData?.slash_commands?.length && !chatData?.plugins?.length) {
        loadSlashCommands();
      }
    });
    getMessages(id!).then(msgs => {
      if (currentIdRef.current !== id) return;
      setMessages(Array.isArray(msgs) ? msgs : []);
    });
    getPending(id!).then(p => {
      if (currentIdRef.current !== id) return;
      if (p) {
        setPendingAction(p);
        setStreaming(true);
      }
    });

    // Check session status and auto-connect
    checkSessionStatus();

    // Cleanup: abort SSE stream when chat ID changes or component unmounts
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
    };
  }, [id, checkSessionStatus, loadSlashCommands]);


  useEffect(() => {
    // Only auto-scroll if auto-scroll is enabled
    if (!autoScroll) return;

    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, inFlightMessage, autoScroll]);

  // Load active plugins from localStorage and listen for changes
  useEffect(() => {
    const loadActivePlugins = () => {
      try {
        const active = localStorage.getItem('activePlugins');
        setActivePluginIds(active ? JSON.parse(active) : []);
      } catch {
        setActivePluginIds([]);
      }
    };

    loadActivePlugins();

    // Listen for storage changes (when SlashCommandsModal updates activePlugins)
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === 'activePlugins') {
        loadActivePlugins();
      }
    };

    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, []);

  const toggleAutoScroll = useCallback(() => {
    setAutoScroll(prev => {
      const newAutoScroll = !prev;
      // If turning auto-scroll on, immediately scroll to bottom
      if (newAutoScroll) {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
      }
      return newAutoScroll;
    });
  }, []);

  const handleSend = useCallback(async (prompt: string, images?: File[]) => {
    // Handle image upload first if images are provided
    let imageIds: string[] = [];
    if (images && images.length > 0) {
      try {
        const uploadResult = await uploadImages(id!, images);
        if (uploadResult.success) {
          imageIds = uploadResult.images.map(img => img.id);
        } else {
          console.error('Image upload failed:', uploadResult.errors);
          // Continue without images
        }
      } catch (error) {
        console.error('Image upload error:', error);
        // Continue without images
      }
    }

    // Set in-flight message to show user's message immediately
    setInFlightMessage(prompt);
    setNetworkError(null); // Clear any previous network errors

    // Track directory usage when sending message
    if (chat?.folder) {
      addRecentDirectory(chat.folder);
    }

    // If there's already a streaming connection, stop it first
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }

    setStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const body: any = { prompt };
      if (imageIds.length > 0) {
        body.imageIds = imageIds;
      }
      if (activePluginIds.length > 0) {
        body.activePlugins = activePluginIds;
      }

      const res = await fetch(`/api/chats/${id}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        setStreaming(false);
        return;
      }

      await readSSE(res.body);
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        setNetworkError('network error');
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
  }, [id, readSSE, activePluginIds]);

  const handleRespond = useCallback(async (allow: boolean, updatedInput?: Record<string, unknown>) => {
    const wasReconnect = !abortRef.current; // no active SSE = page was refreshed
    setPendingAction(null);
    await respondToChat(id!, allow, updatedInput);
    // If we got here via page refresh (no active stream), reconnect to the SSE stream
    if (wasReconnect) {
      setStreaming(true);
      connectToStream();
    }
  }, [id, connectToStream]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    fetch(`/api/chats/${id}/stop`, { method: 'POST', credentials: 'include' });
    setStreaming(false);
    setInFlightMessage(null); // Clear in-flight message when stopping
    setPendingAction(null);
  }, [id]);

  const handleReconnect = useCallback(async () => {
    setNetworkError(null);
    // Refetch chat data and messages to capture any missing content
    getChat(id!).then(setChat);
    getMessages(id!).then(msgs => setMessages(Array.isArray(msgs) ? msgs : []));
    getPending(id!).then(p => {
      if (p) {
        setPendingAction(p);
        setStreaming(true);
      }
    });
    await checkSessionStatus();
  }, [checkSessionStatus, id]);

  // Check if there are any TodoWrite tool calls in the conversation
  const hasTodoList = useMemo(() => {
    return messages.some(message =>
      message.type === 'tool_use' &&
      message.toolName === 'TodoWrite'
    );
  }, [messages]);

  const handleTodoListClick = useCallback(() => {
    // Find the latest TodoWrite tool call and its result
    let latestTodoIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].type === 'tool_use' && messages[i].toolName === 'TodoWrite') {
        latestTodoIndex = i;
        break;
      }
    }

    if (latestTodoIndex >= 0) {
      // Scroll to the todo list
      const targetElement = document.querySelector(`[data-message-index="${latestTodoIndex}"]`) as HTMLElement | null;
      if (targetElement) {
        targetElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
        targetElement.style.outline = '2px solid var(--accent)';
        targetElement.style.borderRadius = '8px';
        setTimeout(() => {
          targetElement.style.outline = '';
          targetElement.style.borderRadius = '';
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

  const handleCommandSelect = useCallback((command: string) => {
    if (promptInputSetValue) {
      promptInputSetValue(command);
    }
  }, [promptInputSetValue]);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <header style={{
        padding: '12px 16px',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexShrink: 0,
      }}>
        {isMobile && (
          <button
            onClick={() => navigate('/')}
            style={{
              background: 'none',
              border: 'none',
              padding: '4px 8px',
              cursor: 'pointer',
              color: 'var(--text)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
            title="Back to chat list"
          >
            <ArrowLeft size={20} />
          </button>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ fontSize: 15, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {chat?.is_git_repo ? (chat.git_branch || 'main') : (chat?.folder?.split('/').pop() || 'Chat')}
            </div>
            {sessionStatus?.active && (
              <div style={{
                fontSize: 11,
                padding: '2px 6px',
                borderRadius: 4,
                background: sessionStatus.type === 'web' ? 'var(--accent)' : '#10b981',
                color: '#fff',
                fontWeight: 500,
              }}>
                {sessionStatus.type === 'web' ? '🌐 Active' : '💻 CLI'}
              </div>
            )}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {chat?.folder}
          </div>
        </div>
        {hasTodoList && (
          <button
            onClick={handleTodoListClick}
            style={{
              background: 'var(--accent)',
              color: '#fff',
              padding: '8px',
              borderRadius: 6,
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
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
              background: 'var(--bg-secondary)',
              color: 'var(--text)',
              padding: '8px',
              borderRadius: 6,
              border: '1px solid var(--border)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
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
              background: 'var(--accent)',
              color: '#fff',
              padding: '8px',
              borderRadius: 6,
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            title="Reconnect to stream"
          >
            <RotateCw size={16} />
          </button>
        )}
        {streaming && (
          <button
            onClick={handleStop}
            style={{
              background: 'var(--danger)',
              color: '#fff',
              padding: '8px',
              borderRadius: 6,
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            title="Stop generation"
          >
            <Square size={14} />
          </button>
        )}
      </header>

      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <div ref={chatContainerRef} style={{ height: '100%', overflow: 'auto', padding: '12px 16px' }}>
        {messages.length === 0 && !streaming && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            color: 'var(--text-muted)',
            fontSize: 14,
          }}>
            No messages in this conversation
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} data-message-index={i}>
            <MessageBubble message={msg} teamColorMap={teamColorMap} />
          </div>
        ))}
        {inFlightMessage && (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
            margin: '6px 0',
          }}>
            <div style={{
              maxWidth: '85%',
              padding: '10px 14px',
              borderRadius: 'var(--radius)',
              background: 'var(--user-bg)',
              border: '1px solid transparent',
              fontSize: 14,
              lineHeight: 1.5,
              wordBreak: 'break-word',
              opacity: 0.7,
            }}>
              {inFlightMessage}
            </div>
            <div style={{
              fontSize: 10,
              color: 'var(--text-muted)',
              opacity: 0.5,
              marginTop: 4,
              textAlign: 'right' as const,
            }}>
              Sending...
            </div>
          </div>
        )}
        {networkError && (
          <div style={{
            color: 'var(--danger)',
            fontSize: 13,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: 'var(--danger-bg, rgba(255, 0, 0, 0.1))',
            borderRadius: 6,
            padding: '12px 16px',
            margin: '8px 0'
          }}>
            <div>⚠️ Network error occurred</div>
            <button
              onClick={handleReconnect}
              style={{
                background: 'var(--accent)',
                color: '#fff',
                padding: '4px 8px',
                borderRadius: 4,
                fontSize: 11,
                marginLeft: 'auto'
              }}
            >
              <RotateCw size={12} style={{ marginRight: 4 }} />
              Reconnect
            </button>
          </div>
        )}
        {streaming && (
          <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '8px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
            <div>Claude is working...</div>
            <div style={{ fontSize: 11, opacity: 0.7 }}>
              (You can send another message anytime)
            </div>
          </div>
        )}
        <div ref={bottomRef} />
        </div>

        {/* Auto-scroll toggle button */}
        <button
          onClick={toggleAutoScroll}
          style={{
            position: 'absolute',
            bottom: '20px',
            right: '20px',
            background: autoScroll ? 'var(--accent)' : 'var(--bg-secondary)',
            color: autoScroll ? '#fff' : 'var(--text)',
            border: autoScroll ? 'none' : '1px solid var(--border)',
            borderRadius: '50%',
            width: '40px',
            height: '40px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
            zIndex: 10,
            transition: 'all 0.2s ease',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = 'scale(1.1)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = 'scale(1)';
          }}
          title={autoScroll ? 'Auto-scroll is ON - Click to disable' : 'Auto-scroll is OFF - Click to enable'}
        >
          <ArrowDown size={20} />
        </button>
      </div>

      {pendingAction ? (
        <FeedbackPanel action={pendingAction} onRespond={handleRespond} />
      ) : (
        <PromptInput onSend={handleSend} disabled={false} onSaveDraft={handleSaveDraft} slashCommands={slashCommands} onSetValue={setPromptInputSetValue} />
      )}

      <DraftModal
        isOpen={showDraftModal}
        onClose={() => {
          setShowDraftModal(false);
          setDraftMessage('');
          setDraftSuccessCallback(null);
        }}
        chatId={id!}
        message={draftMessage}
        onSuccess={draftSuccessCallback || undefined}
      />

      <SlashCommandsModal
        isOpen={showSlashCommandsModal}
        onClose={() => setShowSlashCommandsModal(false)}
        slashCommands={slashCommands}
        plugins={plugins}
        onCommandSelect={handleCommandSelect}
        onActivePluginsChange={setActivePluginIds}
      />
    </div>
  );
}
