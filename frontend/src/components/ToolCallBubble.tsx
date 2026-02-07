import { useState, useMemo } from 'react';
import { RotateCw, ChevronRight, ChevronDown } from 'lucide-react';
import type { ParsedMessage } from '../api';
import { getToolSummary, parseTodoItems, TodoList } from './MessageBubble';
import { useRelativeTime } from '../hooks/useRelativeTime';

interface ToolCallBubbleProps {
  toolUse: ParsedMessage;
  toolResult: ParsedMessage | null;
  isRunning: boolean;
}

export default function ToolCallBubble({ toolUse, toolResult, isRunning }: ToolCallBubbleProps) {
  const [inputExpanded, setInputExpanded] = useState(false);
  const [resultExpanded, setResultExpanded] = useState(false);
  const relativeTime = useRelativeTime(toolResult?.timestamp || toolUse.timestamp);

  // Special case: TodoWrite renders as TodoList component
  const todoItems = useMemo(() => {
    if (toolUse.toolName === 'TodoWrite') {
      return parseTodoItems(toolUse.content);
    }
    return null;
  }, [toolUse]);

  if (todoItems) {
    return <TodoList items={todoItems} />;
  }

  const toolName = toolUse.toolName || 'unknown';
  const summary = getToolSummary(toolName, toolUse.content);

  return (
    <div style={{ margin: '4px 0' }}>
      <div style={{
        borderLeft: '2px solid var(--accent)',
      }}>
        {/* Header row: tool name + summary + status */}
        <div
          onClick={() => setInputExpanded(!inputExpanded)}
          style={{
            padding: '6px 12px',
            fontSize: 13,
            color: 'var(--text-muted)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <span style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
            {inputExpanded
              ? <ChevronDown size={12} style={{ opacity: 0.5 }} />
              : <ChevronRight size={12} style={{ opacity: 0.5 }} />
            }
          </span>
          <span style={{ fontWeight: 500, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {toolName}{summary}
          </span>
          {isRunning && (
            <RotateCw
              size={12}
              style={{
                flexShrink: 0,
                color: 'var(--accent)',
                animation: 'spin 1s linear infinite',
              }}
            />
          )}
        </div>

        {/* Expandable: tool input JSON */}
        {inputExpanded && (
          <pre style={{
            padding: '6px 12px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontSize: 12,
            color: 'var(--text-muted)',
            borderTop: '1px solid var(--border)',
            margin: 0,
            background: 'transparent',
          }}>
            {toolUse.content}
          </pre>
        )}

        {/* Tool result section */}
        {toolResult && (
          <div
            onClick={(e) => {
              e.stopPropagation();
              setResultExpanded(!resultExpanded);
            }}
            style={{
              padding: '4px 12px 4px 12px',
              fontSize: 12,
              color: 'var(--text-muted)',
              cursor: 'pointer',
              borderTop: '1px dashed var(--border)',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
                {resultExpanded
                  ? <ChevronDown size={11} style={{ opacity: 0.5 }} />
                  : <ChevronRight size={11} style={{ opacity: 0.5 }} />
                }
              </span>
              <span style={{ fontStyle: 'italic' }}>
                Result
              </span>
            </div>
            {resultExpanded && (
              <pre style={{
                marginTop: 4,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontSize: 12,
                maxHeight: 300,
                overflow: 'auto',
              }}>
                {toolResult.content}
              </pre>
            )}
          </div>
        )}
      </div>

      {/* Timestamp from the latest available message */}
      {relativeTime && (
        <div style={{
          fontSize: 10,
          color: 'var(--text-muted)',
          opacity: 0.6,
          marginTop: 4,
          textAlign: 'left' as const,
        }}>
          {relativeTime}
        </div>
      )}
    </div>
  );
}
