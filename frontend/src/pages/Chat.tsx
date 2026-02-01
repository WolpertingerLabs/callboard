import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getChat, getMessages, respondToChat, type Chat as ChatType, type ParsedMessage } from '../api';
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

  useEffect(() => {
    getChat(id!).then(setChat);
    getMessages(id!).then(setMessages);
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

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

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
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        setMessages(prev => [...prev, { role: 'assistant', type: 'text', content: `Error: ${err.message}` }]);
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }, [id]);

  const handleRespond = useCallback(async (allow: boolean, updatedInput?: Record<string, unknown>) => {
    setPendingAction(null);
    await respondToChat(id!, allow, updatedInput);
  }, [id]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    fetch(`/api/chats/${id}/stop`, { method: 'POST', credentials: 'include' });
    setStreaming(false);
  }, [id]);

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
          <MessageBubble key={i} message={msg} />
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
