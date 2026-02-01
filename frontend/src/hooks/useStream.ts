import { useState, useCallback, useRef } from 'react';
import type { ParsedMessage } from '../api';

export interface StreamEvent {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'done' | 'error';
  content: string;
  toolName?: string;
}

export function useStream(chatId: string) {
  const [streaming, setStreaming] = useState(false);
  const [streamMessages, setStreamMessages] = useState<ParsedMessage[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(async (prompt: string) => {
    setStreaming(true);
    setStreamMessages(prev => [...prev, { role: 'user', type: 'text', content: prompt }]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch(`/api/chats/${chatId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
            const event: StreamEvent = JSON.parse(line.slice(6));
            if (event.type === 'done') {
              setStreaming(false);
              return;
            }
            if (event.type === 'error') {
              setStreamMessages(prev => [...prev, { role: 'assistant', type: 'text', content: `Error: ${event.content}` }]);
              setStreaming(false);
              return;
            }
            setStreamMessages(prev => [...prev, {
              role: 'assistant',
              type: event.type as ParsedMessage['type'],
              content: event.content,
              toolName: event.toolName,
            }]);
          } catch {}
        }
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        setStreamMessages(prev => [...prev, { role: 'assistant', type: 'text', content: `Error: ${err.message}` }]);
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }, [chatId]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    fetch(`/api/chats/${chatId}/stop`, { method: 'POST' });
    setStreaming(false);
  }, [chatId]);

  return { streaming, streamMessages, setStreamMessages, send, stop };
}
