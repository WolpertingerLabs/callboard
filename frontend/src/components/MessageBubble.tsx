import { useState } from 'react';
import type { ParsedMessage } from '../api';

interface Props {
  message: ParsedMessage;
}

export default function MessageBubble({ message }: Props) {
  const [expanded, setExpanded] = useState(false);
  const isUser = message.role === 'user';

  if (message.type === 'thinking') {
    return (
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          padding: '6px 12px',
          margin: '4px 0',
          fontSize: 13,
          color: 'var(--text-muted)',
          cursor: 'pointer',
          borderLeft: '2px solid var(--border)',
        }}
      >
        <span style={{ fontStyle: 'italic' }}>
          {expanded ? 'Thinking:' : 'Thinking... (tap to expand)'}
        </span>
        {expanded && (
          <pre style={{ marginTop: 4, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12 }}>
            {message.content}
          </pre>
        )}
      </div>
    );
  }

  if (message.type === 'tool_use') {
    return (
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          padding: '6px 12px',
          margin: '4px 0',
          fontSize: 13,
          color: 'var(--text-muted)',
          cursor: 'pointer',
          borderLeft: '2px solid var(--accent)',
        }}
      >
        <span style={{ fontWeight: 500 }}>Tool: {message.toolName || 'unknown'}</span>
        {expanded && (
          <pre style={{ marginTop: 4, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12 }}>
            {message.content}
          </pre>
        )}
      </div>
    );
  }

  if (message.type === 'tool_result') {
    return (
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          padding: '6px 12px',
          margin: '4px 0',
          fontSize: 13,
          color: 'var(--text-muted)',
          cursor: 'pointer',
          borderLeft: '2px solid var(--border)',
        }}
      >
        <span style={{ fontStyle: 'italic' }}>
          {expanded ? 'Result:' : 'Tool result (tap to expand)'}
        </span>
        {expanded && (
          <pre style={{ marginTop: 4, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, maxHeight: 300, overflow: 'auto' }}>
            {message.content}
          </pre>
        )}
      </div>
    );
  }

  return (
    <div style={{
      display: 'flex',
      justifyContent: isUser ? 'flex-end' : 'flex-start',
      margin: '6px 0',
    }}>
      <div style={{
        maxWidth: '85%',
        padding: '10px 14px',
        borderRadius: 'var(--radius)',
        background: isUser ? 'var(--user-bg)' : 'var(--assistant-bg)',
        border: `1px solid ${isUser ? 'transparent' : 'var(--border)'}`,
        fontSize: 14,
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}>
        {message.content}
      </div>
    </div>
  );
}
