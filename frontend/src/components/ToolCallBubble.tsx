import { useState, useMemo } from "react";
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

export default function ToolCallBubble({ toolUse, toolResult, isRunning }: ToolCallBubbleProps) {
  const [inputExpanded, setInputExpanded] = useState(false);
  const [resultExpanded, setResultExpanded] = useState(false);

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
          {isRunning && (
            <RotateCw
              size={12}
              style={{
                flexShrink: 0,
                color: "var(--accent)",
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
