/**
 * Says when a folder's own Claude config (hooks, statusLine, credential
 * helpers, `.mcp.json` servers) won't run in a Claude Code chat, and why, with
 * a "Trust this folder" button when trust is the only thing missing. Security
 * finding H-02; the decision itself is the backend's
 * (`backend/src/services/repo-config-trust.ts`), this only shows it.
 *
 * Keyed on the folder (the chat's cwd), never on a workspace: trust is about
 * what is in the directory.
 */
import { useCallback, useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { getRepoConfigStatus, trustFolder, type RepoConfigStatus } from "../api";
import { errorMessage } from "../utils/errorMessage";

interface RepoConfigNoticeProps {
  /** The folder the chat runs in. Nothing renders without one. */
  folder: string;
  /** The chat's Code execution level, as it stands in the form. */
  codeExecution: "allow" | "ask" | "deny";
  /** The chat's harness. Only Claude Code reads these files. */
  provider?: string;
  /** An existing chat: the change applies from its next message. */
  existingChat?: boolean;
}

/** "hooks (SessionStart, PreToolUse), a status line, credential helpers (apiKeyHelper) and MCP servers in .mcp.json (evil)". */
export function describeDefines(d: RepoConfigStatus["defines"]): string {
  const parts: string[] = [];
  if (d.hookEvents.length > 0) parts.push(`hooks (${d.hookEvents.join(", ")})`);
  if (d.statusLine) parts.push("a status line command");
  if (d.helpers.length > 0) parts.push(`${d.helpers.length === 1 ? "a credential helper" : "credential helpers"} (${d.helpers.join(", ")})`);
  if (d.mcpJsonServers.length > 0) parts.push(`MCP servers in .mcp.json (${d.mcpJsonServers.join(", ")})`);
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

const REASON_TEXT: Record<string, string> = {
  "code-execution-not-allowed": "Code execution for this chat isn't Allow",
  "untrusted-folder": "this folder isn't trusted",
  "setting-never": "the Repository hooks setting is Never",
};

export default function RepoConfigNotice({ folder, codeExecution, provider, existingChat = false }: RepoConfigNoticeProps) {
  const [status, setStatus] = useState<RepoConfigStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isClaude = !provider || provider === "claude-code";
  const path = folder.trim();

  const load = useCallback(
    (signal?: AbortSignal) => {
      if (!isClaude || !path.startsWith("/")) {
        setStatus(null);
        return;
      }
      getRepoConfigStatus(path, codeExecution, signal)
        .then(setStatus)
        .catch(() => {
          if (!signal?.aborted) setStatus(null);
        });
    },
    [isClaude, path, codeExecution],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  const d = status?.defines;
  const definesAny = !!d && (d.hookEvents.length > 0 || d.statusLine || d.helpers.length > 0 || d.mcpJsonServers.length > 0);
  if (!status || !definesAny || !status.decision || status.decision.run) return null;
  const reason = status.decision.reason;

  const onTrust = async () => {
    setBusy(true);
    setError(null);
    try {
      await trustFolder(path);
      load();
    } catch (err) {
      setError(errorMessage(err, "Failed to trust folder"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="repo-config-notice"
      role="note"
      style={{
        display: "flex",
        gap: 8,
        alignItems: "flex-start",
        padding: "8px 10px",
        margin: "8px 0",
        borderRadius: 6,
        fontSize: 12,
        lineHeight: 1.45,
        background: "var(--warning-bg)",
        border: "1px solid var(--warning)",
        color: "var(--text)",
      }}
    >
      <ShieldAlert size={14} style={{ color: "var(--warning)", flexShrink: 0, marginTop: 2 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div>
          This folder&apos;s own Claude config defines {describeDefines(status.defines)}. Callboard won&apos;t run them because {REASON_TEXT[reason] ?? reason}.
          Your own <code>~/.claude</code> hooks are off for this chat too.
          {existingChat && " Changes apply from the next message."}
        </div>
        {reason === "untrusted-folder" && (
          <div style={{ marginTop: 6, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={onTrust}
              disabled={busy}
              style={{
                padding: "3px 10px",
                borderRadius: 4,
                fontSize: 12,
                border: "1px solid var(--border)",
                background: "var(--bg-secondary)",
                color: "var(--text)",
                cursor: busy ? "default" : "pointer",
              }}
            >
              {busy ? "Trusting…" : "Trust this folder"}
            </button>
            <span style={{ color: "var(--text-muted)" }}>Trust only a repository whose hooks you would run yourself.</span>
          </div>
        )}
        {error && <div style={{ color: "var(--danger)", marginTop: 4 }}>{error}</div>}
      </div>
    </div>
  );
}
