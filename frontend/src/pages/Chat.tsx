import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getChat, getMessages, getPending, respondToChat, getSessionStatus, uploadImages, type Chat as ChatType, type ParsedMessage, type SessionStatus } from '../api';
import MessageBubble from '../components/MessageBubble';
import PromptInput from '../components/PromptInput';
import FeedbackPanel, { type PendingAction } from '../components/FeedbackPanel';
import DraftModal from '../components/DraftModal';

export default function Chat() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [chat, setChat] = useState<ChatType | null>(null);
  const [messages, setMessages] = useState<ParsedMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus | null>(null);
  const [networkError, setNetworkError] = useState<string | null>(null);
  const [showDraftModal, setShowDraftModal] = useState(false);
  const [draftMessage, setDraftMessage] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Shared SSE reader that processes a ReadableStream of SSE data
  const readSSE = useCallback(async (body: ReadableStream<Uint8Array>) => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6));
            if (event.type === 'done') {
              setStreaming(false);
              // Refresh chat data when stream ends to display updated title
              getChat(id!).then(setChat);
              return;
            }
            if (event.type === 'error') {
              setMessages(prev => [...prev, { role: 'assistant', type: 'text', content: `Error: ${event.content}` }]);
              setStreaming(false);
              return;
            }
            if (event.type === 'permission_request' || event.type === 'user_question' || event.type === 'plan_review') {
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
            setMessages(prev => [...prev, {
              role: 'assistant',
              type: event.type,
              content: event.content,
              toolName: event.toolName,
            }]);
          } catch {}
        }
      }
    } finally {
      setStreaming(false);
    }
  }, []);

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
    try {
      const status = await getSessionStatus(id);
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

  useEffect(() => {
    getChat(id!).then(setChat);
    getMessages(id!).then(setMessages);
    getPending(id!).then(p => {
      if (p) {
        setPendingAction(p);
        setStreaming(true);
      }
    });

    // Check session status and auto-connect
    checkSessionStatus();
  }, [id, checkSessionStatus]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

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

    // Display the user message (with image indicator if applicable)
    let displayContent = prompt;
    if (imageIds.length > 0) {
      displayContent = `📷 ${imageIds.length} image${imageIds.length === 1 ? '' : 's'} attached\n\n${prompt}`;
    }

    setMessages(prev => [...prev, { role: 'user', type: 'text', content: displayContent }]);
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
      const body: any = { prompt };
      if (imageIds.length > 0) {
        body.imageIds = imageIds;
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
      }
    } finally {
      // Only stop streaming if this is still the current request
      if (abortRef.current === controller) {
        setStreaming(false);
        abortRef.current = null;
      }
    }
  }, [id, readSSE]);

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
    setPendingAction(null);
  }, [id]);

  const handleReconnect = useCallback(async () => {
    setNetworkError(null);
    // Refetch chat data and messages to capture any missing content
    getChat(id!).then(setChat);
    getMessages(id!).then(setMessages);
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
        <button
          onClick={() => navigate('/')}
          style={{ background: 'none', fontSize: 18, padding: '4px 8px' }}
        >
          ←
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ fontSize: 15, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {chat?.folder.split('/').pop() || 'Chat'}
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
              padding: '6px 12px',
              borderRadius: 6,
              fontSize: 13,
              marginRight: 8,
            }}
            title="Jump to latest to-do list"
          >
            📋 Tasks
          </button>
        )}
        {networkError && (
          <button
            onClick={handleReconnect}
            style={{
              background: 'var(--accent)',
              color: '#fff',
              padding: '6px 12px',
              borderRadius: 6,
              fontSize: 13,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
            title="Reconnect to stream"
          >
            🔄 Reconnect
          </button>
        )}
        {streaming && (
          <button
            onClick={handleStop}
            style={{
              background: 'var(--danger)',
              color: '#fff',
              padding: '6px 12px',
              borderRadius: 6,
              fontSize: 13,
            }}
          >
            Stop
          </button>
        )}
      </header>

      <div style={{ flex: 1, overflow: 'auto', padding: '12px 16px' }}>
        {messages.length === 0 && !streaming && (
          <p style={{ color: 'var(--text-muted)', textAlign: 'center', marginTop: 40 }}>
            Send a message to start coding.
          </p>
        )}
        {messages.map((msg, i) => (
          <div key={i} data-message-index={i}>
            <MessageBubble message={msg} />
          </div>
        ))}
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
              🔄 Reconnect
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

      {pendingAction ? (
        <FeedbackPanel action={pendingAction} onRespond={handleRespond} />
      ) : (
        <PromptInput onSend={handleSend} disabled={false} onSaveDraft={handleSaveDraft} />
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
    </div>
  );
}
