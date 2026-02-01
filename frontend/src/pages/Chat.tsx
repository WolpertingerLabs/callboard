import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getChat, getMessages, type Chat as ChatType, type ParsedMessage } from '../api';
import { useStream } from '../hooks/useStream';
import MessageBubble from '../components/MessageBubble';
import PromptInput from '../components/PromptInput';

export default function Chat() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [chat, setChat] = useState<ChatType | null>(null);
  const [history, setHistory] = useState<ParsedMessage[]>([]);
  const { streaming, streamMessages, setStreamMessages, send, stop } = useStream(id!);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getChat(id!).then(setChat);
    getMessages(id!).then(setHistory);
  }, [id]);

  const allMessages = [...history, ...streamMessages];

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [allMessages.length]);

  const handleSend = async (prompt: string) => {
    await send(prompt);
    // After stream ends, reload history and clear stream messages
    const msgs = await getMessages(id!);
    setHistory(msgs);
    setStreamMessages([]);
  };

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
            onClick={stop}
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
        {allMessages.length === 0 && !streaming && (
          <p style={{ color: 'var(--text-muted)', textAlign: 'center', marginTop: 40 }}>
            Send a message to start coding.
          </p>
        )}
        {allMessages.map((msg, i) => (
          <MessageBubble key={i} message={msg} />
        ))}
        {streaming && (
          <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '8px 0' }}>
            Claude is working...
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <PromptInput onSend={handleSend} disabled={streaming} />
    </div>
  );
}
