import { useState, useMemo } from 'react';
import { Check, RotateCw, Square } from 'lucide-react';
import type { ParsedMessage } from '../api';
import MarkdownRenderer from './MarkdownRenderer';
import { formatRelativeTime } from '../utils/dateFormat';

interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

function parseTodoItems(content: string): TodoItem[] | null {
  try {
    const parsed = JSON.parse(content);
    if (parsed?.todos && Array.isArray(parsed.todos)) {
      return parsed.todos;
    }
  } catch {}
  return null;
}

// Generate contextual summary for tool usage
function getToolSummary(toolName: string, content: string): string {
  try {
    const input = JSON.parse(content);

    switch (toolName) {
      case 'Read':
        return input.file_path ? ` - ${input.file_path.split('/').pop()}` : '';
      case 'Write':
      case 'Edit':
      case 'MultiEdit':
        return input.file_path ? ` - ${input.file_path.split('/').pop()}` : '';
      case 'Bash':
        const cmd = input.command || '';
        const truncated = cmd.length > 40 ? cmd.substring(0, 40) + '...' : cmd;
        return cmd ? ` - ${truncated}` : '';
      case 'Grep':
        return input.pattern ? ` - '${input.pattern}'` : '';
      case 'Glob':
        return input.pattern ? ` - ${input.pattern}` : '';
      case 'WebFetch':
        if (input.url) {
          try {
            const domain = new URL(input.url).hostname;
            return ` - ${domain}`;
          } catch {
            return ` - ${input.url}`;
          }
        }
        return '';
      case 'Task':
        return input.description ? ` - ${input.description}` : '';
      case 'NotebookEdit':
        return input.notebook_path ? ` - ${input.notebook_path.split('/').pop()}` : '';
      default:
        return '';
    }
  } catch {
    return '';
  }
}

const StatusIcon = ({ status }: { status: string }) => {
  switch (status) {
    case 'completed':
      return <Check size={14} style={{ color: '#10b981' }} />;
    case 'in_progress':
      return <RotateCw size={14} style={{ color: 'var(--accent)' }} />;
    case 'pending':
    default:
      return <Square size={14} style={{ color: 'var(--text-muted)' }} />;
  }
};

function TodoList({ items }: { items: TodoItem[] }) {
  const completedCount = items.filter(t => t.status === 'completed').length;
  const total = items.length;
  const progressPct = total > 0 ? (completedCount / total) * 100 : 0;

  return (
    <div style={{
      margin: '6px 0',
      border: '1px solid var(--border)',
      borderRadius: 10,
      overflow: 'hidden',
      background: 'var(--assistant-bg)',
      maxWidth: '85%',
    }}>
      <div style={{
        padding: '10px 14px 8px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottom: '1px solid var(--border)',
      }}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>
          Tasks
        </span>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {completedCount}/{total} done
        </span>
      </div>

      <div style={{
        height: 3,
        background: 'var(--border)',
      }}>
        <div style={{
          height: '100%',
          width: `${progressPct}%`,
          background: 'var(--accent)',
          borderRadius: 2,
          transition: 'width 0.3s ease',
        }} />
      </div>

      <div style={{ padding: '6px 0' }}>
        {items.map((item, i) => (
          <div key={i} style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
            padding: '5px 14px',
            fontSize: 13,
            lineHeight: 1.4,
            opacity: item.status === 'completed' ? 0.65 : 1,
          }}>
            <span style={{ flexShrink: 0, lineHeight: '18px', display: 'flex', alignItems: 'center' }}>
              <StatusIcon status={item.status} />
            </span>
            <span style={{
              textDecoration: item.status === 'completed' ? 'line-through' : 'none',
              color: item.status === 'in_progress' ? 'var(--accent)' : undefined,
              fontWeight: item.status === 'in_progress' ? 500 : 400,
            }}>
              {item.content}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

interface Props {
  message: ParsedMessage;
}

function MessageTimestamp({ timestamp, align = 'right' }: { timestamp?: string; align?: 'left' | 'right' }) {
  if (!timestamp) return null;

  return (
    <div style={{
      fontSize: 10,
      color: 'var(--text-muted)',
      opacity: 0.6,
      marginTop: 4,
      textAlign: align,
    }}>
      {formatRelativeTime(timestamp)}
    </div>
  );
}

export default function MessageBubble({ message }: Props) {
  const [expanded, setExpanded] = useState(false);
  const isUser = message.role === 'user';

  // Special rendering for TodoWrite tool calls
  const todoItems = useMemo(() => {
    if (message.type === 'tool_use' && message.toolName === 'TodoWrite') {
      return parseTodoItems(message.content);
    }
    return null;
  }, [message]);

  if (todoItems) {
    return <TodoList items={todoItems} />;
  }

  if (message.type === 'thinking') {
    return (
      <div style={{ margin: '4px 0' }}>
        <div
          onClick={() => setExpanded(!expanded)}
          style={{
            padding: '6px 12px',
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
        <MessageTimestamp timestamp={message.timestamp} align="left" />
      </div>
    );
  }

  if (message.type === 'tool_use') {
    return (
      <div style={{ margin: '4px 0' }}>
        <div
          onClick={() => setExpanded(!expanded)}
          style={{
            padding: '6px 12px',
            fontSize: 13,
            color: 'var(--text-muted)',
            cursor: 'pointer',
            borderLeft: '2px solid var(--accent)',
          }}
        >
          <span style={{ fontWeight: 500 }}>
            Tool: {message.toolName || 'unknown'}{getToolSummary(message.toolName || '', message.content)}
          </span>
          {expanded && (
            <pre style={{ marginTop: 4, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12 }}>
              {message.content}
            </pre>
          )}
        </div>
        <MessageTimestamp timestamp={message.timestamp} align="left" />
      </div>
    );
  }

  if (message.type === 'tool_result') {
    return (
      <div style={{ margin: '4px 0' }}>
        <div
          onClick={() => setExpanded(!expanded)}
          style={{
            padding: '6px 12px',
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
        <MessageTimestamp timestamp={message.timestamp} align="left" />
      </div>
    );
  }

  // Use different colors for built-in commands
  const getBackgroundColor = () => {
    if (message.isBuiltInCommand) {
      return isUser ? 'var(--builtin-user-bg)' : 'var(--builtin-assistant-bg)';
    }
    return isUser ? 'var(--user-bg)' : 'var(--assistant-bg)';
  };

  const getBorderColor = () => {
    if (message.isBuiltInCommand) {
      return isUser ? 'var(--builtin-user-border)' : 'var(--builtin-assistant-border)';
    }
    return isUser ? 'transparent' : 'var(--border)';
  };

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: isUser ? 'flex-end' : 'flex-start',
      margin: '6px 0',
    }}>
      <div style={{
        maxWidth: '85%',
        padding: '10px 14px',
        borderRadius: 'var(--radius)',
        background: getBackgroundColor(),
        border: `1px solid ${getBorderColor()}`,
        fontSize: 14,
        lineHeight: 1.5,
        wordBreak: 'break-word',
        ...(message.isBuiltInCommand && {
          fontFamily: 'monaco, "Courier New", monospace',
          color: 'var(--builtin-text)',
          fontWeight: 500,
          whiteSpace: 'pre-wrap',
        }),
      }}>
        {message.isBuiltInCommand ? (
          message.content
        ) : (
          <MarkdownRenderer
            content={message.content}
            className="message-markdown"
          />
        )}
      </div>
      <MessageTimestamp timestamp={message.timestamp} align={isUser ? 'right' : 'left'} />
    </div>
  );
}
