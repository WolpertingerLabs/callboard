import { useEffect, useState, useMemo } from "react";
import { RotateCw, ChevronRight, ChevronDown } from "lucide-react";
import type { ParsedMessage } from "../api";
import { parseTodoItems, TodoList, MessageMetadata, ToolSourceBadge, ImageThumbnails } from "./MessageBubble";
import { getToolSummary, getToolDisplayName, isCallboardTool } from "./toolFormatting";
import MediaRenderer from "./MediaRenderer";
import CanvasRenderer from "./CanvasRenderer";
import JsonContentView from "./JsonContentView";

interface ToolCallBubbleProps {
  toolUse: ParsedMessage;
  toolResult: ParsedMessage | null;
  isRunning: boolean;
}

/** Below this, a running tool is just a fast tool and a timer is noise. */
const ELAPSED_VISIBLE_AFTER_MS = 5_000;

/**
 * How long a still-running tool call has been going, or null when it is not
 * running or has not been going long enough to be worth saying.
 *
 * Exists because a spinner alone cannot distinguish "working" from "wedged",
 * and some tool calls are genuinely opaque for minutes. OpenCode's `task` is
 * the case that prompted it: the subagent runs in a child session that the ACP
 * protocol gives the client no window into — OpenCode sends *no* update for it
 * between the call opening and its result, measured, so there is nothing to
 * stream no matter how the adapter is written. Two and a half minutes of one
 * collapsed row and a 12px spinner reads as a dead chat. A ticking clock is the
 * honest signal available: it says "still running, this long", which is exactly
 * what callboard knows.
 *
 * Timed from the tool call's own transcript timestamp rather than from mount,
 * so reloading the page mid-call shows the real age instead of restarting at
 * zero.
 */
function useRunningElapsed(isRunning: boolean, timestamp: string | undefined): string | null {
  const startedAt = useMemo(() => {
    const parsed = timestamp ? Date.parse(timestamp) : NaN;
    return Number.isFinite(parsed) ? parsed : null;
  }, [timestamp]);

  // Ticks only while the call is open, so a settled transcript costs no timers.
  // The first tick also refreshes a `now` that was captured at mount, which is
  // why nothing sets it eagerly here — the display can be at most one second
  // behind, and one second is not visible on a clock that counts in seconds.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isRunning || startedAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isRunning, startedAt]);

  if (!isRunning || startedAt === null) return null;
  const ms = now - startedAt;
  // A clock skewed backwards (the transcript is stamped server-side) would
  // otherwise render a negative age.
  if (ms < ELAPSED_VISIBLE_AFTER_MS) return null;
  return formatElapsed(ms);
}

/** `42s` under a minute, `1m 42s` above it. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export default function ToolCallBubble({ toolUse, toolResult, isRunning }: ToolCallBubbleProps) {
  const [inputExpanded, setInputExpanded] = useState(false);
  const [resultExpanded, setResultExpanded] = useState(false);
  const elapsed = useRunningElapsed(isRunning, toolUse.timestamp);

  // Special case: TodoWrite renders as TodoList component
  const todoItems = useMemo(() => {
    if (toolUse.toolName === "TodoWrite") {
      return parseTodoItems(toolUse.content);
    }
    return null;
  }, [toolUse]);

  // Special case: render_file renders as MediaRenderer. Matched by bare tool
  // name so all providers hit it (Claude: mcp__callboard-tools__render_file,
  // Codex: callboard-tools__render_file, OpenRouter: render_file).
  const renderFileData = useMemo(() => {
    if (toolUse.toolName && isCallboardTool(toolUse.toolName, "render_file") && toolResult) {
      try {
        const parsed = JSON.parse(toolResult.content);
        if (parsed?.type === "render_file") return parsed;
      } catch {
        /* invalid JSON */
      }
    }
    return null;
  }, [toolUse, toolResult]);

  // Special case: create_canvas / update_canvas renders as CanvasRenderer
  const canvasData = useMemo(() => {
    const isCanvasTool = !!toolUse.toolName && (isCallboardTool(toolUse.toolName, "create_canvas") || isCallboardTool(toolUse.toolName, "update_canvas"));
    if (isCanvasTool && toolResult) {
      try {
        const parsed = JSON.parse(toolResult.content);
        if (parsed?.type === "render_canvas") return parsed;
      } catch {
        /* invalid JSON */
      }
    }
    return null;
  }, [toolUse, toolResult]);

  if (todoItems) {
    return <TodoList items={todoItems} />;
  }

  if (renderFileData) {
    return <MediaRenderer data={renderFileData} />;
  }

  if (canvasData) {
    return <CanvasRenderer data={canvasData} />;
  }

  const toolName = toolUse.toolName || "unknown";
  const displayName = toolUse.toolName ? getToolDisplayName(toolUse.toolName) : "unknown";
  const summary = getToolSummary(toolName, toolUse.content);

  return (
    <div style={{ margin: "4px 0" }}>
      <div
        style={{
          borderLeft: "2px solid var(--accent)",
        }}
      >
        {/* Header row: tool name + summary + status */}
        <div
          onClick={() => setInputExpanded(!inputExpanded)}
          style={{
            padding: "6px 12px",
            fontSize: 13,
            color: "var(--text-muted)",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
            {inputExpanded ? <ChevronDown size={12} style={{ opacity: 0.5 }} /> : <ChevronRight size={12} style={{ opacity: 0.5 }} />}
          </span>
          <span style={{ fontWeight: 500, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={toolName}>
            {displayName}
            {summary}
            <ToolSourceBadge toolSource={toolUse.toolSource} />
          </span>
          {elapsed && (
            <span style={{ flexShrink: 0, fontSize: 11, opacity: 0.7, fontVariantNumeric: "tabular-nums" }} title="How long this tool call has been running">
              {elapsed}
            </span>
          )}
          {isRunning && (
            <RotateCw
              size={12}
              style={{
                flexShrink: 0,
                color: "var(--accent-text)",
                animation: "spin 1s linear infinite",
              }}
            />
          )}
        </div>

        {/* Expandable: tool input JSON */}
        {inputExpanded && (
          <JsonContentView
            content={toolUse.content}
            preStyle={{
              padding: "6px 12px",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontSize: 12,
              color: "var(--text-muted)",
              borderTop: "1px solid var(--border)",
              margin: 0,
              background: "transparent",
            }}
          />
        )}

        {/* Tool result section */}
        {toolResult && (
          <div
            onClick={(e) => {
              e.stopPropagation();
              setResultExpanded(!resultExpanded);
            }}
            style={{
              padding: "4px 12px 4px 12px",
              fontSize: 12,
              color: "var(--text-muted)",
              cursor: "pointer",
              borderTop: "1px dashed var(--border)",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
                {resultExpanded ? <ChevronDown size={11} style={{ opacity: 0.5 }} /> : <ChevronRight size={11} style={{ opacity: 0.5 }} />}
              </span>
              <span style={{ fontStyle: "italic" }}>Result</span>
            </div>
            {resultExpanded && (
              <JsonContentView
                content={toolResult.content}
                preStyle={{
                  marginTop: 4,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  fontSize: 12,
                  maxHeight: 300,
                  overflow: "auto",
                }}
              />
            )}
          </div>
        )}

        {/* Images the tool returned (e.g. Read on an image file) — always visible */}
        {toolResult?.imageIds && toolResult.imageIds.length > 0 && (
          <div style={{ padding: "0 12px 8px 12px" }}>
            <ImageThumbnails imageIds={toolResult.imageIds} />
          </div>
        )}
      </div>

      {/* Metadata: timestamp, model, expandable details */}
      <MessageMetadata message={toolResult || toolUse} align="left" />
    </div>
  );
}
