import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getChat, getMessages, getPending, respondToChat, type Chat as ChatType, type ParsedMessage } from '../api';
import MessageBubble from '../components/MessageBubble';
import PromptInput from '../components/PromptInput';
import FeedbackPanel, { type PendingAction } from '../components/FeedbackPanel';

export default function Chat() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [chat, setChat] = useState<ChatType | null>(null);
  const [messages, setMessages] = useState<ParsedMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
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
        setStreaming(false);
      }
    } finally {
      abortRef.current = null;
    }
  }, [id, readSSE]);

  useEffect(() => {
    getChat(id!).then(setChat);
    getMessages(id!).then(setMessages);
    getPending(id!).then(p => {
      if (p) {
        setPendingAction(p);
        setStreaming(true);
      }
    });
  }, [id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const handleSend = useCallback(async (prompt: string) => {
    setStreaming(true);
    setMessages(prev => [...prev, { role: 'user', type: 'text', content: prompt }]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch(`/api/chats/${id}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ prompt }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        setStreaming(false);
        return;
      }

      await readSSE(res.body);
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        setMessages(prev => [...prev, { role: 'assistant', type: 'text', content: `Error: ${err.message}` }]);
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }, [id, readSSE]);

  const handleRespond = useCallback(async (allow: boolean, updatedInput?: Record<string, unknown>) => {
    const wasReconnect = !abortRef.current; // no active SSE = page was refreshed
    setPendingAction(null);
    await respondToChat(id!, allow, updatedInput);
    // If we got here via page refresh, reconnect to the SSE stream
    if (wasReconnect) {
      connectToStream();
    }
  }, [id, connectToStream]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    fetch(`/api/chats/${id}/stop`, { method: 'POST', credentials: 'include' });
    setStreaming(false);
    setPendingAction(null);
  }, [id]);

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
          <div style={{ fontSize: 15, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {chat?.folder.split('/').pop() || 'Chat'}
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
        {streaming && (
          <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '8px 0' }}>
            Claude is working...
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {pendingAction ? (
        <FeedbackPanel action={pendingAction} onRespond={handleRespond} />
      ) : (
        <PromptInput onSend={handleSend} disabled={streaming} />
      )}
    </div>
  );
}
